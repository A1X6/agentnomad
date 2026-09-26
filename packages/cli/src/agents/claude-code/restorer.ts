import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

import type { SourceOs } from '@agentnomad/contracts';
import {
  BACKUP_MARKER,
  createMergeStrategies,
  createPathResolver,
  selectMergeStrategy,
  type PlannedWrite,
} from '@agentnomad/core';
import * as z from 'zod';

import type {
  CollectedFile,
  ConflictResolver,
  RestoreContext,
  Restorer,
  ScopeTarget,
} from '../adapter.ts';
import { hookScripts } from './hook-scripts.ts';
import { findAutoMemory } from './auto-memory.ts';
import { commandsInSettings, commandWords, createFileGatherer } from './file-gathering.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
} from './global-paths.ts';
import { ClaudeJsonError } from './global-collector.ts';
import {
  globalDestination,
  projectDestination,
  projectHookScripts,
  type RestoreDestination,
  windowsNameProblem,
} from './restore-rules.ts';
import type { ClaudeRunningCheck } from './running-claude.ts';

/** The user's answer while Claude Code is running: try again after closing it, or skip. */
export type ClaudeRunningAnswer = 'retry' | 'skip';

export interface RestorerOptions {
  /** Claude Code's base folder on this PC (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  readonly isClaudeRunning: ClaudeRunningCheck;
  /** Asks the user to close Claude Code (then `retry`) or to leave `~/.claude.json` alone. */
  readonly onClaudeRunning: () => Promise<ClaudeRunningAnswer>;
  /** Clock for backup names; injectable for tests. */
  readonly now?: () => Date;
}

/** Scripts that must use LF (a CR breaks the shell) and ones Windows runs with CRLF. */
const LF_SCRIPTS = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.lua']);
const CRLF_SCRIPTS = new Set(['.bat', '.cmd']);

/** Commands that only run on one side. */
const WINDOWS_ONLY = /(\.ps1|\.psm1|\.bat|\.cmd)$|^(powershell|pwsh|cmd)(\.exe)?$/i;
const POSIX_ONLY = /(\.sh|\.bash|\.zsh|\.fish)$|^(bash|sh|zsh|fish)$/i;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Line endings of scripts for this OS; every other file stays byte-for-byte. */
export function lineEndingsFor(
  platform: NodeJS.Platform,
  path: string,
  content: Uint8Array,
): Uint8Array {
  const extension = /(\.[^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const crlf = platform === 'win32' && CRLF_SCRIPTS.has(extension);
  if (!crlf && !LF_SCRIPTS.has(extension)) return content;
  const text = new TextDecoder().decode(content);
  const lf = text.replace(/\r\n/g, '\n');
  return new TextEncoder().encode(crlf ? lf.replace(/\n/g, '\r\n') : lf);
}

/** Hook and status line commands that will likely not run on `platform` (from another OS). */
export function hooksForOtherOs(settingsJson: string, platform: NodeJS.Platform): string[] {
  const foreign = platform === 'win32' ? POSIX_ONLY : WINDOWS_ONLY;
  return commandsInSettings(settingsJson).filter((command) =>
    commandWords(command).some((word) => foreign.test(word)),
  );
}

/**
 * Writes a pulled Claude Code setup to this PC (T27). Only paths a collector could have
 * produced are written; existing files that differ are resolved with the user's choice
 * (T11 strategies); `~/.claude.json` is only ever merged, and never while Claude Code runs.
 */
export function createClaudeCodeRestorer(options: RestorerOptions): Restorer {
  const files = createFileGatherer(options.platform);
  const { path } = files;
  const os: SourceOs =
    options.platform === 'win32' || options.platform === 'darwin' ? options.platform : 'linux';
  const resolver = createPathResolver({ os, homeDir: options.homedir });
  const strategies = createMergeStrategies(options.now ? { now: options.now } : {});
  const claudeJsonFile = options.customConfigDir
    ? path.join(options.baseDir, '.claude.json')
    : path.join(options.homedir, '.claude.json');

  async function readExisting(nativePath: string): Promise<Uint8Array | 'folder' | null> {
    const info = await stat(nativePath).catch(() => null);
    if (info === null) return null;
    if (!info.isFile()) return 'folder';
    return new Uint8Array(await readFile(nativePath));
  }

  /** `''` when nothing is at `nativePath`, else the first free `-2`, `-3`, … (T45). */
  async function freeSuffix(nativePath: string): Promise<string> {
    const taken = async (candidate: string) => (await stat(candidate).catch(() => null)) !== null;
    if (!(await taken(nativePath))) return '';
    for (let number = 2; ; number += 1) {
      if (!(await taken(`${nativePath}-${String(number)}`))) return `-${String(number)}`;
    }
  }

  /** Writes to a temporary file and swaps it in, so a crash never leaves half a file. */
  async function writeAtomically(nativePath: string, content: Uint8Array, mode: number | null) {
    await mkdir(path.dirname(nativePath), { recursive: true });
    const temp = path.join(
      path.dirname(nativePath),
      `.${path.basename(nativePath)}.agentnomad-tmp-${randomBytes(4).toString('hex')}`,
    );
    try {
      await writeFile(temp, content, { flag: 'wx', ...(mode !== null && { mode }) });
      if (mode !== null && options.platform !== 'win32') await chmod(temp, mode);
      await rename(temp, nativePath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** Permissions: a replaced file keeps its own; new scripts may run on macOS and Linux. */
  function modeFor(file: CollectedFile, content: Uint8Array, existingMode: number | null) {
    if (options.platform === 'win32') return null;
    const runnable =
      file.executable || (content[0] === 0x23 && content[1] === 0x21); /* starts with "#!" */
    if (existingMode !== null) return runnable ? existingMode | 0o111 : existingMode;
    return runnable ? 0o755 : null;
  }

  /** The OS path of a destination, or `null` when it has no place on this PC. */
  async function nativePathOf(
    target: ScopeTarget,
    destination: RestoreDestination,
    memoryDir: () => Promise<string | null>,
  ): Promise<string | null> {
    switch (destination.kind) {
      case 'target':
        return resolver.toNativePath(
          target.kind === 'global' ? options.baseDir : target.projectDir,
          destination.path,
        );
      case 'home':
        return resolver.toNativePath(options.homedir, destination.path);
      case 'auto-memory': {
        const dir = await memoryDir();
        return dir === null ? null : resolver.toNativePath(dir, destination.path);
      }
      default:
        return null;
    }
  }

  /** `~/.claude.json` as it is now, parsed: `existing` is `null` when missing. */
  async function readClaudeJson() {
    const existing = await readExisting(claudeJsonFile);
    if (existing === null || existing === 'folder') return { existing, current: {} };
    try {
      const current = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(new TextDecoder().decode(existing)));
      return { existing, current };
    } catch (error) {
      throw new ClaudeJsonError(claudeJsonFile, { cause: error });
    }
  }

  /**
   * `current` with the incoming keys merged in: servers by name (incoming wins), preference
   * keys replaced. A Map keeps a key named "__proto__" plain data. `unchanged` compares the
   * keys, not the bytes, since Claude Code formats the file its own way.
   */
  function mergeInto(current: Record<string, unknown>, incoming: Record<string, unknown>) {
    const merged = new Map(Object.entries(current));
    for (const [key, value] of Object.entries(incoming)) {
      const before = merged.get(key);
      merged.set(
        key,
        key === CLAUDE_JSON_MCP_KEY && isJsonObject(before) && isJsonObject(value)
          ? Object.fromEntries([...Object.entries(before), ...Object.entries(value)])
          : value,
      );
    }
    const unchanged = Object.keys(incoming).every(
      (key) => JSON.stringify(current[key]) === JSON.stringify(merged.get(key)),
    );
    return { merged, unchanged };
  }

  /**
   * Merges the selected keys into `~/.claude.json`, keeping everything else in it. Only the
   * keys push saves are taken (T43): the MCP servers and the preference keys. Anything else,
   * such as `projects` (local MCP servers and folder trust) or account state, is left out.
   */
  async function mergeClaudeJson(
    file: CollectedFile,
    onConflict: ConflictResolver,
    report: MutableReport,
    assumeYes: boolean,
  ): Promise<void> {
    const parsed = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(new TextDecoder().decode(file.content)));
    const allowed = new Set([CLAUDE_JSON_MCP_KEY, ...CLAUDE_JSON_PREFERENCE_KEYS]);
    const incoming = Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.has(key)));
    const ignored = Object.keys(parsed).filter((key) => !allowed.has(key));
    if (ignored.length > 0) {
      report.warnings.push(
        `Left out of ${claudeJsonFile}: ${ignored.map((key) => JSON.stringify(key)).join(', ')} (only MCP servers and preferences are restored there).`,
      );
    }
    if (Object.keys(incoming).length === 0) return;

    const before = await readClaudeJson();
    if (before.existing === 'folder') {
      report.skipped.push(file.path);
      return;
    }
    if (before.existing !== null) {
      if (mergeInto(before.current, incoming).unchanged) return;
      const choice = await onConflict(CLAUDE_JSON_BUNDLE_PATH, { overwriteAllowed: false });
      if (choice === 'skip') {
        report.skipped.push(file.path);
        return;
      }
    }
    while (await options.isClaudeRunning()) {
      // --yes never waits for the user to close Claude Code: the file is skipped instead.
      if (assumeYes || (await options.onClaudeRunning()) === 'skip') {
        report.skipped.push(file.path);
        report.warnings.push(
          `${claudeJsonFile} was left as it is because Claude Code was running; pull again later to add your MCP servers and preferences.`,
        );
        return;
      }
    }
    // Read again now that Claude Code is closed: it may have saved the file meanwhile (T43).
    const { existing, current } = await readClaudeJson();
    if (existing === 'folder') {
      report.skipped.push(file.path);
      return;
    }
    const { merged, unchanged } = mergeInto(current, incoming);
    if (existing !== null && unchanged) return;
    const content = new TextEncoder().encode(
      `${JSON.stringify(Object.fromEntries(merged), null, 2)}\n`,
    );
    const mode = existing === null ? 0o600 : (await stat(claudeJsonFile)).mode & 0o777;
    if (existing !== null) {
      const name = `${claudeJsonFile}${BACKUP_MARKER}${stamp(options.now?.() ?? new Date())}`;
      const backup = name + (await freeSuffix(name));
      await writeAtomically(backup, existing, mode);
      report.backups.push(backup);
    }
    await writeAtomically(claudeJsonFile, content, mode);
    report.written.push(file.path);
  }

  return {
    async restore(target, incoming, onConflict, context: RestoreContext = {}) {
      const report: MutableReport = { written: [], skipped: [], backups: [], warnings: [] };
      const projectScripts = projectHookScripts(
        incoming
          .filter((entry) =>
            ['.claude/settings.json', '.claude/settings.local.json'].includes(entry.path),
          )
          .map((entry) => new TextDecoder().decode(entry.content)),
      );
      const settings = incoming.find((entry) => entry.path === 'settings.json');
      const globalScripts = new Set(
        settings
          ? hookScripts(new TextDecoder().decode(settings.content), options).map(
              (script) => script.bundlePath,
            )
          : [],
      );
      const destinationOf = (path: string): RestoreDestination => {
        const windowsProblem = options.platform === 'win32' ? windowsNameProblem(path) : null;
        if (windowsProblem !== null) return { kind: 'refused', reason: windowsProblem };
        return target.kind === 'global'
          ? globalDestination(path, globalScripts)
          : projectDestination(path, projectScripts);
      };

      let memory: Promise<string | null> | undefined;
      const memoryDir = () =>
        (memory ??= (async () => {
          if (target.kind !== 'project') return null;
          const location = await findAutoMemory({ ...options, projectDir: target.projectDir });
          if (location.kind === 'folder') return location.dir;
          report.warnings.push(
            location.kind === 'shared'
              ? 'Auto memory was not restored: autoMemoryDirectory in your user settings is shared by every project.'
              : location.kind === 'refused'
                ? `Auto memory was not restored to ${location.dir}, the folder autoMemoryDirectory names: ${location.reason}.`
                : 'Auto memory was not restored: this project path is too long to find its memory folder.',
          );
          return null;
        })());

      /** Writes one entry; a problem with it is thrown and reported by the loop below. */
      async function restoreEntry(file: CollectedFile): Promise<void> {
        const destination = destinationOf(file.path);
        if (destination.kind === 'refused') {
          report.skipped.push(file.path);
          report.warnings.push(`Refused "${file.path}": ${destination.reason}.`);
          return;
        }
        if (destination.kind === 'metadata') return;
        if (destination.kind === 'claude-json') {
          await mergeClaudeJson(file, onConflict, report, context.assumeYes === true);
          return;
        }

        const nativePath = await nativePathOf(target, destination, memoryDir);
        if (nativePath === null) {
          report.skipped.push(file.path);
          return;
        }

        const content = lineEndingsFor(options.platform, file.path, file.content);
        const existing = await readExisting(nativePath);
        if (existing === 'folder') {
          report.skipped.push(file.path);
          report.warnings.push(`Skipped "${file.path}": a folder with that name exists.`);
          return;
        }
        const existingMode = existing === null ? null : (await stat(nativePath)).mode & 0o777;

        let writes: readonly PlannedWrite[];
        if (existing === null) {
          writes = [{ path: file.path, content }];
        } else if (sameBytes(existing, content)) {
          return;
        } else {
          const choice = await onConflict(file.path, { overwriteAllowed: true });
          if (choice === 'skip') {
            report.skipped.push(file.path);
            return;
          }
          writes = selectMergeStrategy(strategies, choice, file.path).resolve({
            path: file.path,
            existing,
            incoming: content,
          });
        }

        for (const write of writes) {
          // Backups and side-by-side copies sit next to the file, with a marker suffix; a
          // name already taken (two pulls in one second) gets a number, never replaced (T45).
          const replacing = write.path === file.path;
          const suffix = replacing
            ? ''
            : await freeSuffix(nativePath + write.path.slice(file.path.length));
          const writePath = nativePath + write.path.slice(file.path.length) + suffix;
          await writeAtomically(
            writePath,
            write.content,
            replacing ? modeFor(file, write.content, existingMode) : existingMode,
          );
          if (write.path.includes(BACKUP_MARKER)) report.backups.push(write.path + suffix);
          else report.written.push(write.path + suffix);
        }
      }

      // Windows and macOS ignore case and Unicode form, so two entries a Linux PC keeps apart
      // (`Notes.md`, `notes.md`) would land on one file here: only the first is written (T43).
      const foldsNames = options.platform === 'win32' || options.platform === 'darwin';
      const seen = new Map<string, string>();
      for (const file of [...incoming].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        if (foldsNames) {
          const folded = file.path.normalize('NFC').toLowerCase();
          const first = seen.get(folded);
          if (first !== undefined) {
            report.skipped.push(file.path);
            report.warnings.push(
              `Skipped "${file.path}": on this PC it is the same file as "${first}".`,
            );
            continue;
          }
          seen.set(folded, file.path);
        }
        // One bad entry is skipped with a warning; it never stops the rest of the restore.
        try {
          await restoreEntry(file);
        } catch (error) {
          report.skipped.push(file.path);
          report.warnings.push(`Skipped "${file.path}": ${(error as Error).message}.`);
        }
      }

      if (context.sourceOs !== undefined && context.sourceOs !== os) {
        const settingsPaths =
          target.kind === 'global'
            ? ['settings.json']
            : ['.claude/settings.json', '.claude/settings.local.json'];
        for (const file of incoming.filter((entry) => settingsPaths.includes(entry.path))) {
          for (const command of hooksForOtherOs(
            new TextDecoder().decode(file.content),
            options.platform,
          )) {
            report.warnings.push(
              `This hook or status line came from ${context.sourceOs} and will likely not run here: ${command}`,
            );
          }
        }
      }
      return report;
    },
  };
}

interface MutableReport {
  written: string[];
  skipped: string[];
  backups: string[];
  warnings: string[];
}

/** Same format as the T11 backup names: `20260925T120000Z`. */
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
