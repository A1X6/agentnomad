import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { posix, win32, type PlatformPath } from 'node:path';

import { BACKUP_MARKER, INCOMING_MARKER } from '@agentnomad/core';
import { BundlePathSchema } from '@agentnomad/contracts';
import * as z from 'zod';

import type { CollectedFile } from '../adapter.ts';
import {
  isSensitiveHomePath,
  PACKAGE_RUNNERS,
  RUNTIME_COMMANDS,
  SKIPPED_NAMES,
} from './global-paths.ts';

/** Reading files for a bundle; shared by the global (T25) and project (T26) collectors. */
export interface FileGatherer {
  /** Path rules of the PC being collected. */
  readonly path: PlatformPath;
  /** Path from `folder` in forward slashes, or `null` when `file` is outside it. */
  relativeInside(folder: string, file: string): string | null;
  /** The file as a bundle entry, or `null` when it is not a file. */
  readIfFile(nativePath: string, bundlePath: string): Promise<CollectedFile | null>;
  /**
   * Every file under `folder`, as `bundlePrefix/...`. Follows links once (loop-safe) and
   * skips clutter, agentnomad backup copies and whatever `excluded` names.
   */
  walk(
    folder: string,
    bundlePrefix: string,
    excluded: (bundlePath: string) => boolean,
    seen?: Set<string>,
  ): Promise<CollectedFile[]>;
}

const isMarkerCopy = (name: string) =>
  name.includes(BACKUP_MARKER) || name.includes(INCOMING_MARKER);

/** A file larger than this is left out of a setup (T45): a setup is settings and text. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Where links may lead when collecting (T45). */
export interface GatherLimits {
  /** The home folder: a link into a folder for keys and logins is never followed. */
  readonly homedir?: string;
  /**
   * Links must stay inside this folder. For a project: a cloned repository could link
   * `.claude/skills/x` to `~/.ssh`, and push would save the keys.
   */
  readonly within?: string;
  /** Told about each file left out, with why, so push can say so. */
  readonly onSkipped?: (bundlePath: string, reason: string) => void;
}

export function createFileGatherer(
  platform: NodeJS.Platform,
  limits: GatherLimits = {},
): FileGatherer {
  const path = platform === 'win32' ? win32 : posix;

  const relativeInside = (folder: string, file: string): string | null => {
    const relative = path.relative(folder, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const bundlePath = relative.split(path.sep).join('/');
    return BundlePathSchema.safeParse(bundlePath).success ? bundlePath : null;
  };

  const realOrSelf = (folder: string) => realpath(folder).catch(() => folder);
  const realHome = limits.homedir === undefined ? null : realOrSelf(limits.homedir);
  const realWithin = limits.within === undefined ? null : realOrSelf(limits.within);

  /** Why the real file behind `nativePath` must not be read, or `null` (T45). */
  async function linkProblem(nativePath: string): Promise<string | null> {
    const real = await realpath(nativePath).catch(() => null);
    if (real === null) return null;
    if (realWithin !== null) {
      const within = await realWithin;
      if (real !== within && relativeInside(within, real) === null) {
        return 'it links to a place outside the project';
      }
    }
    if (realHome !== null) {
      const fromHome = relativeInside(await realHome, real);
      if (fromHome !== null && isSensitiveHomePath(fromHome)) {
        return 'it links into a folder for keys and logins';
      }
    }
    return null;
  }

  function skip(bundlePath: string, reason: string): null {
    limits.onSkipped?.(bundlePath, reason);
    return null;
  }

  async function fileEntry(nativePath: string, bundlePath: string) {
    const info = await stat(nativePath);
    if (info.size > MAX_FILE_BYTES) return skip(bundlePath, 'it is larger than 10 MB');
    return {
      path: bundlePath,
      content: new Uint8Array(await readFile(nativePath)),
      // Only macOS and Linux record "may run"; T27 decides per OS on restore.
      executable: platform !== 'win32' && (info.mode & 0o111) !== 0,
    };
  }

  async function readIfFile(nativePath: string, bundlePath: string) {
    const info = await stat(nativePath).catch(() => null);
    if (!info?.isFile()) return null;
    const problem = await linkProblem(nativePath);
    return problem === null ? fileEntry(nativePath, bundlePath) : skip(bundlePath, problem);
  }

  async function walk(
    folder: string,
    bundlePrefix: string,
    excluded: (bundlePath: string) => boolean,
    seen = new Set<string>(),
  ): Promise<CollectedFile[]> {
    let real: string;
    try {
      real = await realpath(folder);
    } catch {
      return [];
    }
    if (seen.has(real)) return [];
    seen.add(real);
    const problem = await linkProblem(folder);
    if (problem !== null) {
      skip(bundlePrefix, problem);
      return [];
    }

    const files: CollectedFile[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (SKIPPED_NAMES.has(entry.name) || isMarkerCopy(entry.name)) continue;
      const bundlePath = `${bundlePrefix}/${entry.name}`;
      if (excluded(bundlePath) || !BundlePathSchema.safeParse(bundlePath).success) continue;
      const nativePath = path.join(folder, entry.name);
      // stat follows links, so linked folders (e.g. from a dotfiles repo) come along, as far
      // as the limits allow.
      const info = await stat(nativePath).catch(() => null);
      if (info?.isDirectory()) {
        files.push(...(await walk(nativePath, bundlePath, excluded, seen)));
      } else if (info?.isFile()) {
        const file = await readIfFile(nativePath, bundlePath);
        if (file) files.push(file);
      }
    }
    return files;
  }

  return { path, relativeInside, readIfFile, walk };
}

/** One entry per path (the last wins), sorted by path. */
export function uniqueByPath(files: readonly CollectedFile[]): CollectedFile[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const jsonFile = (bundlePath: string, value: unknown): CollectedFile => ({
  path: bundlePath,
  content: new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
  executable: false,
});

const HookCommandSchema = z.looseObject({ command: z.string().optional() });
const SettingsSchema = z.looseObject({
  hooks: z
    .record(
      z.string(),
      z.array(z.looseObject({ hooks: z.array(HookCommandSchema).optional() })).optional(),
    )
    .optional(),
  statusLine: HookCommandSchema.optional(),
});

/** Parsed settings JSON, or `null` when the text is not a JSON object. */
export function parseSettings(settingsJson: string): Record<string, unknown> | null {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(settingsJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Commands in a `settings.json` that run files: every hook, and the status line. */
export function commandsInSettings(settingsJson: string): string[] {
  const settings = SettingsSchema.safeParse(parseSettings(settingsJson));
  if (!settings.success) return [];
  const commands = Object.values(settings.data.hooks ?? {}).flatMap((groups) =>
    (groups ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)),
  );
  commands.push(settings.data.statusLine?.command);
  return commands.filter((command): command is string => command !== undefined);
}

/**
 * Words of a command line, like a shell splits them: quoted and unquoted parts next to each
 * other form one word (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/a.sh`), quotes removed.
 */
export function commandWords(command: string): string[] {
  return [...command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((match) =>
    match[0].replace(
      /"([^"]*)"|'([^']*)'/g,
      (_quoted, double?: string, single?: string) => double ?? single ?? '',
    ),
  );
}

/** `ccstatusline@2.2.22` → `ccstatusline`; `@scope/tool@1` → `@scope/tool`. */
const withoutVersion = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, '');

/**
 * The program a command starts, e.g. `ccstatusline`, or `ccstatusline` for
 * `npx -y ccstatusline@latest` (`runner`: nothing to install). `null` for a script path,
 * a shell or a runtime.
 */
export function programOf(command: string): { name: string; runner: boolean } | null {
  const words = commandWords(command);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  const first = words[index];
  if (first === undefined || /[\\/]/.test(first)) return null;
  const base = first.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (PACKAGE_RUNNERS.has(base)) {
    const spec = words.slice(index + 1).find((word) => !word.startsWith('-'));
    return spec === undefined ? null : { name: withoutVersion(spec), runner: true };
  }
  if (RUNTIME_COMMANDS.has(base) || !/^[A-Za-z0-9._-]+$/.test(first)) return null;
  return { name: base, runner: false };
}
