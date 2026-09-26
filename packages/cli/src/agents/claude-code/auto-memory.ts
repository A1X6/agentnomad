import { readFile, readdir, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { parseSettings } from './file-gathering.ts';
import { homePathProblem } from './global-paths.ts';
import { MAX_PROJECT_DIR_NAME } from './project-paths.ts';

export interface AutoMemoryInput {
  /** The project folder being pushed or pulled. */
  readonly projectDir: string;
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where this project's auto memory lives, or why it has none of its own. */
export type AutoMemoryLocation =
  | { readonly kind: 'folder'; readonly dir: string }
  /** `autoMemoryDirectory` in user settings: one folder for every project, not this one's. */
  | { readonly kind: 'shared'; readonly dir: string }
  /** A name over 200 characters whose hashed folder does not exist here. */
  | { readonly kind: 'unknown' }
  /** A folder the project's settings chose that agentnomad will not read or write (T43). */
  | { readonly kind: 'refused'; readonly dir: string; readonly reason: string };

/**
 * `E:\Projects\agent-nomad` → `E--Projects-agent-nomad`: every character that is not a
 * letter or digit becomes `-` (Claude Code's rule, checked against real folders).
 */
export const projectDirName = (root: string) => root.replace(/[^A-Za-z0-9]/g, '-');

const pathsOf = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The folder whose name auto memory is keyed by: the main repository root for a git
 * project (worktrees and subfolders share it), else the project folder itself.
 */
export async function repositoryRoot(
  projectDir: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const path = pathsOf(platform);
  for (let dir = path.resolve(projectDir); ;) {
    const dotGit = path.join(dir, '.git');
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return dir;
    if (info?.isFile()) {
      // A worktree: `.git` is a file pointing at .git/worktrees/<name>; `commondir` leads
      // back to the main repository's .git folder.
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? '')?.[1];
      if (pointer === undefined) return dir;
      const gitDir = path.resolve(dir, pointer);
      const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
      return common ? path.dirname(path.resolve(gitDir, common)) : dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(projectDir);
    dir = parent;
  }
}

/** `autoMemoryDirectory` from a settings file, with `~/` expanded; absolute paths only. */
async function configuredDirectory(
  settingsFile: string,
  input: AutoMemoryInput,
): Promise<string | null> {
  const path = pathsOf(input.platform);
  const text = await readText(settingsFile);
  const value = text === null ? undefined : parseSettings(text)?.['autoMemoryDirectory'];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const expanded = value.replace(/^~(?=[\\/])/, () => input.homedir);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : null;
}

/**
 * Why a memory folder chosen by a project's settings is not used, or `null` (T43). Claude
 * Code honours such a folder only once the folder is trusted; a pulled bundle brings its own
 * settings, so the folder must be in the home folder, not a folder for keys or one whose files
 * run by themselves, and not elsewhere in Claude Code's own folder.
 */
function chosenFolderProblem(dir: string, input: AutoMemoryInput): string | null {
  const path = pathsOf(input.platform);
  const inside = (folder: string) => {
    const relative = path.relative(folder, dir);
    return relative.startsWith('..') || path.isAbsolute(relative) ? null : relative;
  };
  const fromHome = inside(input.homedir);
  if (fromHome === null) return 'it is outside your home folder';
  if (fromHome === '') return 'it is your home folder itself';
  const problem = homePathProblem(fromHome.split(path.sep).join('/'));
  if (problem !== null) return `it is ${problem}`;
  const fromBase = inside(input.baseDir);
  const fromProjects = inside(path.join(input.baseDir, 'projects'));
  if (fromBase !== null && (fromProjects === null || fromProjects === '')) {
    return "it is inside Claude Code's own folder";
  }
  return null;
}

/**
 * Finds this project's auto memory folder the way Claude Code does (T26):
 * `autoMemoryDirectory` from the project's local or shared settings, then from user
 * settings (shared by every project), then `CLAUDE_CODE_PROJECT_DIR_NAME`, then
 * `<base>/projects/<repository root as a name>/memory`.
 */
export async function findAutoMemory(input: AutoMemoryInput): Promise<AutoMemoryLocation> {
  const path = pathsOf(input.platform);
  const claudeDir = path.join(input.projectDir, '.claude');
  for (const file of ['settings.local.json', 'settings.json']) {
    const dir = await configuredDirectory(path.join(claudeDir, file), input);
    if (dir === null) continue;
    const reason = chosenFolderProblem(dir, input);
    return reason === null ? { kind: 'folder', dir } : { kind: 'refused', dir, reason };
  }
  const shared = await configuredDirectory(path.join(input.baseDir, 'settings.json'), input);
  if (shared !== null) return { kind: 'shared', dir: shared };

  const projects = path.join(input.baseDir, 'projects');
  const fixedName = input.env['CLAUDE_CODE_PROJECT_DIR_NAME']?.trim();
  if (fixedName && input.env['CLAUDE_CONFIG_DIR']?.trim()) {
    return { kind: 'folder', dir: path.join(projects, fixedName, 'memory') };
  }

  const name = projectDirName(await repositoryRoot(input.projectDir, input.platform));
  const entries = await readdir(projects).catch(() => [] as string[]);
  const windows = input.platform === 'win32';
  const matches = (entry: string, expected: string) =>
    windows ? entry.toLowerCase() === expected.toLowerCase() : entry === expected;

  if (name.length <= MAX_PROJECT_DIR_NAME) {
    // Windows paths ignore case, so the folder may have been named from other casing.
    const existing = entries.find((entry) => matches(entry, name)) ?? name;
    return { kind: 'folder', dir: path.join(projects, existing, 'memory') };
  }
  // Longer names are cut to 200 characters plus a hash; use the one folder that fits.
  const prefix = `${name.slice(0, MAX_PROJECT_DIR_NAME)}-`;
  const candidates = entries.filter((entry) =>
    windows ? entry.toLowerCase().startsWith(prefix.toLowerCase()) : entry.startsWith(prefix),
  );
  const [only] = candidates;
  return candidates.length === 1 && only !== undefined
    ? { kind: 'folder', dir: path.join(projects, only, 'memory') }
    : { kind: 'unknown' };
}
