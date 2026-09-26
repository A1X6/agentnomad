import { readdir, readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { BACKUP_MARKER, INCOMING_MARKER } from '@agentnomad/core';

import type { ScopeTarget } from '../adapter.ts';
import {
  GLOBAL_FILES,
  GLOBAL_FOLDERS,
  GLOBAL_KNOWN_STATE,
  GLOBAL_MEMORY_FOLDERS,
  IGNORED_COPY_PATTERNS,
  NEVER_SYNCED,
} from './global-paths.ts';
import { hookScripts } from './hook-scripts.ts';
import {
  PROJECT_CLAUDE_FILES,
  PROJECT_CLAUDE_FOLDERS,
  PROJECT_KNOWN_STATE,
  PROJECT_MEMORY_FOLDERS,
  PROJECT_NEVER_SYNCED,
} from './project-paths.ts';

export interface UnknownFilesInput {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  /** The home folder, to find the scripts the hooks and status line run (T49). */
  readonly homedir?: string;
}

/**
 * Top-level names in the base folder that hold a script the global hooks or status line
 * run (T49): push saves those scripts by that route (T25), so such a folder, e.g. `hooks/`,
 * is not unknown. A folder with no such script is still reported.
 */
async function hookScriptNames(input: UnknownFilesInput): Promise<string[]> {
  if (input.homedir === undefined) return [];
  const path = input.platform === 'win32' ? win32 : posix;
  const settings = await readFile(path.join(input.baseDir, 'settings.json'), 'utf8').catch(
    () => null,
  );
  if (settings === null) return [];
  return hookScripts(settings, {
    homedir: input.homedir,
    baseDir: input.baseDir,
    platform: input.platform,
  })
    .map((script) => script.bundlePath)
    .filter((bundlePath) => !bundlePath.startsWith('.agentnomad/'))
    .map(topLevel);
}

/** The first part of a list entry: `skills/synced` → `skills`. */
const topLevel = (entry: string) => entry.split('/')[0] ?? entry;

/** Names that are copies or temporary files, never worth reporting. */
function isCopy(name: string): boolean {
  return (
    name.includes(BACKUP_MARKER) ||
    name.includes(INCOMING_MARKER) ||
    name.includes('.agentnomad-tmp-') ||
    IGNORED_COPY_PATTERNS.some((pattern) => pattern.test(name))
  );
}

/**
 * Entries in Claude Code's folder that agentnomad does not know (T32): not synced, not a
 * known never-synced item, not known state. Push reports them, so nothing new that a Claude
 * Code update adds is ever skipped silently. `skills/synced/` is known (always skipped) and
 * never reported. Global: the base folder; project: the project's `.claude/` folder.
 * Folder names end in `/`.
 */
export async function findUnknownEntries(
  target: ScopeTarget,
  input: UnknownFilesInput,
): Promise<string[]> {
  const path = input.platform === 'win32' ? win32 : posix;
  const [folder, prefix, known] =
    target.kind === 'global'
      ? [
          input.baseDir,
          '',
          [
            ...GLOBAL_FILES,
            ...GLOBAL_FOLDERS,
            ...GLOBAL_MEMORY_FOLDERS,
            ...NEVER_SYNCED,
            ...GLOBAL_KNOWN_STATE,
          ].map(topLevel),
        ]
      : [
          path.join(target.projectDir, '.claude'),
          '.claude/',
          [
            ...PROJECT_CLAUDE_FILES,
            ...PROJECT_CLAUDE_FOLDERS,
            ...PROJECT_MEMORY_FOLDERS,
            ...PROJECT_KNOWN_STATE,
            ...PROJECT_NEVER_SYNCED.filter((entry) => entry.startsWith('.claude/')).map((entry) =>
              entry.slice('.claude/'.length),
            ),
          ].map(topLevel),
        ];

  const knownNames = new Set(known);
  if (target.kind === 'global') {
    // `.claude.json` sits in the base folder when CLAUDE_CONFIG_DIR is set; handled apart.
    knownNames.add('.claude.json');
    for (const name of await hookScriptNames(input)) knownNames.add(name);
  }

  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !knownNames.has(entry.name) && !isCopy(entry.name))
    .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
}

/** What push says about unknown entries; `null` when there are none. */
export function unknownEntriesNotice(entries: readonly string[]): string | null {
  if (entries.length === 0) return null;
  return [
    `Not saved, because agentnomad does not know ${entries.length === 1 ? 'this' : 'these'} yet: ${entries.join(', ')}.`,
    'A newer Claude Code may have added them; if they matter to you, update agentnomad.',
  ].join(' ');
}
