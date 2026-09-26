import { readFile } from 'node:fs/promises';

import * as z from 'zod';

import type { CollectedFile, CollectOptions, Collector, ScopeTarget } from '../adapter.ts';
import {
  commandsInSettings,
  createFileGatherer,
  type FileGatherer,
  jsonFile,
  programOf,
  uniqueByPath,
} from './file-gathering.ts';
import {
  CLAUDE_JSON_BUNDLE_PATH,
  CLAUDE_JSON_MCP_KEY,
  CLAUDE_JSON_PREFERENCE_KEYS,
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_MEMORY_FOLDERS,
  HOME_SCRIPTS_PREFIX,
  NEVER_SYNCED,
  PLUGINS_BUNDLE_PATH,
  PROGRAMS_BUNDLE_PATH,
  TOOL_CONFIG_FILES,
} from './global-paths.ts';
import { collectAccountSkills, readSyncedSkills } from './account-skills.ts';
import { hookScripts } from './hook-scripts.ts';
import { readPluginManifest } from './plugins.ts';
import type { ProgramInfo, ProgramLocator } from './programs.ts';

export interface GlobalCollectorOptions {
  /** Claude Code's base folder, from the detector (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  /** Whether `CLAUDE_CONFIG_DIR` is set: `.claude.json` then lives in the base folder. */
  readonly customConfigDir: boolean;
  /** Looks up programs hooks and the status line run; without it none are recorded. */
  readonly findProgram?: ProgramLocator;
}

/** `~/.claude.json` could not be read as JSON (e.g. Claude Code was writing it). */
export class ClaudeJsonError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`Could not read ${path}. If Claude Code is running, try again in a moment.`, options);
    this.name = 'ClaudeJsonError';
  }
}

/** True when `bundlePath` is a never-synced entry or inside one. */
const isNeverSynced = (bundlePath: string) =>
  NEVER_SYNCED.some((entry) => bundlePath === entry || bundlePath.startsWith(`${entry}/`));

/** A Claude Code global collector for one PC (T25). Project scope is T26. */
export function createClaudeCodeGlobalCollector(options: GlobalCollectorOptions): Collector {
  const { path } = createFileGatherer(options.platform);
  const { baseDir, homedir } = options;

  /** Script files that hooks and the status line run, if they are in the home folder. */
  async function hookScriptFiles(
    files: FileGatherer,
    settingsJson: string,
  ): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    for (const script of hookScripts(settingsJson, options)) {
      const file = await files.readIfFile(script.nativePath, script.bundlePath);
      if (file) found.push(file);
    }
    return found;
  }

  /**
   * For each program the commands run: its known settings file (e.g. ccstatusline's) and,
   * unless it runs through npx, what it is and how it was installed, so pull can check it.
   */
  async function programs(files: FileGatherer, settingsJson: string): Promise<CollectedFile[]> {
    const found: CollectedFile[] = [];
    const programsFound = new Map<string, ProgramInfo>();
    for (const command of commandsInSettings(settingsJson)) {
      const program = programOf(command);
      if (program === null) continue;
      for (const relative of TOOL_CONFIG_FILES[program.name] ?? []) {
        const file = await files.readIfFile(
          path.join(homedir, ...relative.split('/')),
          HOME_SCRIPTS_PREFIX + relative,
        );
        if (file) found.push(file);
      }
      if (!program.runner && !programsFound.has(program.name)) {
        const info = (await options.findProgram?.(program.name)) ?? {
          command: program.name,
          npm: null,
        };
        programsFound.set(program.name, info);
      }
    }
    if (programsFound.size > 0 && options.findProgram) {
      const list = [...programsFound.values()].sort((a, b) => a.command.localeCompare(b.command));
      found.push(jsonFile(PROGRAMS_BUNDLE_PATH, { programs: list }));
    }
    return found;
  }

  /** MCP servers and preference keys from `~/.claude.json`; nothing else in it. */
  async function claudeJson(): Promise<CollectedFile | null> {
    const file = options.customConfigDir
      ? path.join(baseDir, '.claude.json')
      : path.join(homedir, '.claude.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ClaudeJsonError(file, { cause: error });
    }
    const all = z.record(z.string(), z.unknown()).safeParse(parsed);
    if (!all.success) throw new ClaudeJsonError(file, { cause: all.error });

    const selected: Record<string, unknown> = {};
    const mcpServers = all.data[CLAUDE_JSON_MCP_KEY];
    if (mcpServers && typeof mcpServers === 'object' && Object.keys(mcpServers).length > 0) {
      selected[CLAUDE_JSON_MCP_KEY] = mcpServers;
    }
    for (const key of CLAUDE_JSON_PREFERENCE_KEYS) {
      if (all.data[key] !== undefined) selected[key] = all.data[key];
    }
    return Object.keys(selected).length === 0 ? null : jsonFile(CLAUDE_JSON_BUNDLE_PATH, selected);
  }

  return {
    async collect(target: ScopeTarget, collectOptions: CollectOptions) {
      if (target.kind !== 'global') {
        throw new Error('The global collector only collects the global setup');
      }
      const found: CollectedFile[] = [];
      // Links into folders for keys and logins are never followed, and huge files are left
      // out (T45); the user's own links elsewhere (a dotfiles repo) still come along.
      const files = createFileGatherer(options.platform, {
        homedir,
        ...(collectOptions.onSkipped && { onSkipped: collectOptions.onSkipped }),
      });

      for (const name of GLOBAL_FILES) {
        const file = await files.readIfFile(path.join(baseDir, name), name);
        if (file) found.push(file);
      }
      const seen = new Set<string>();
      const folders = collectOptions.includeMemory
        ? [...GLOBAL_FOLDERS, ...GLOBAL_MEMORY_FOLDERS]
        : GLOBAL_FOLDERS;
      for (const name of folders) {
        found.push(...(await files.walk(path.join(baseDir, name), name, isNeverSynced, seen)));
      }

      const settings = found.find((file) => file.path === 'settings.json');
      if (settings) {
        const text = new TextDecoder().decode(settings.content);
        found.push(...(await hookScriptFiles(files, text)), ...(await programs(files, text)));
      }

      const selected = await claudeJson();
      if (selected) found.push(selected);

      const plugins = await readPluginManifest({
        baseDir,
        platform: options.platform,
        scope: { kind: 'global' },
      });
      if (plugins) found.push(jsonFile(PLUGINS_BUNDLE_PATH, plugins));

      // Opt-in (T42): a copy of the user's own claude.ai skills, never skills/synced itself.
      if (collectOptions.includeAccountSkills) {
        found.push(...(await collectAccountSkills(files, await readSyncedSkills(files, baseDir))));
      }

      // A hook may name a file already in a synced folder.
      return uniqueByPath(found);
    },
  };
}
