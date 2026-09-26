/**
 * What the Claude Code global collector takes from `~/.claude` (T25). The lists come from
 * the paths data file (T32); this module only gives them names and fast lookups.
 */
import { CLAUDE_CODE_PATHS as DATA } from './claude-code-paths.data.ts';

/** Single files in the base folder. */
export const GLOBAL_FILES: readonly string[] = DATA.global.files;

/** Folders in the base folder, taken whole (minus the skips below). */
export const GLOBAL_FOLDERS: readonly string[] = DATA.global.folders;

/** Opt-in: subagent memory with `memory: user` (auto memory is per project, T26). */
export const GLOBAL_MEMORY_FOLDERS: readonly string[] = DATA.global.memoryFolders;

/** Never taken, even when a hook names them (includes `skills/synced`). */
export const NEVER_SYNCED: readonly string[] = DATA.global.neverSynced;

/** Known base-folder entries left out on purpose, so the unknown-file check stays quiet. */
export const GLOBAL_KNOWN_STATE: readonly string[] = DATA.global.knownState;

/** Names skipped anywhere inside a synced folder: tool state and OS clutter. */
export const SKIPPED_NAMES: ReadonlySet<string> = new Set(DATA.skippedNames);

/** The user's own copies (`settings.json.bak`), never reported as unknown. */
export const IGNORED_COPY_PATTERNS: readonly RegExp[] = DATA.ignoredCopyPatterns.map(
  (pattern) => new RegExp(pattern),
);

/**
 * `~/.claude.json` keys that are preferences: the "Global config" keys in Claude Code's
 * settings reference. Everything else there is account, machine or project state.
 */
export const CLAUDE_JSON_PREFERENCE_KEYS: readonly string[] = DATA.claudeJsonPreferenceKeys;

/** User-scope MCP servers, also kept in `~/.claude.json`. */
export const CLAUDE_JSON_MCP_KEY = 'mcpServers';

/** Reserved bundle folder for files that do not live in the base folder. */
export const RESERVED_DIR = '.agentnomad';
/** The selected `~/.claude.json` keys. */
export const CLAUDE_JSON_BUNDLE_PATH = `${RESERVED_DIR}/claude.json`;
/** Hook and status line scripts elsewhere in the home folder, by path from home. */
export const HOME_SCRIPTS_PREFIX = `${RESERVED_DIR}/home/`;

/** A hook argument is only taken as a script with one of these extensions. */
export const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(DATA.scriptExtensions);

/** Home folders never read for hook scripts, whatever a command names: keys and cloud logins. */
export const SENSITIVE_HOME_DIRS: readonly string[] = DATA.sensitiveHomeDirs;

/** Home folders the OS or a shell runs files from by itself (T43). */
export const AUTOSTART_HOME_DIRS: readonly string[] = DATA.autostartHomeDirs;

/**
 * Why a path from the home folder (`/`-separated) must never be read or written for a
 * setup, or `null`: a folder for keys and logins, or one whose files run by themselves.
 * Compared without case, since Windows and macOS ignore it.
 */
export function homePathProblem(relative: string): string | null {
  if (isSensitiveHomePath(relative)) return 'a folder for keys and logins';
  if (AUTOSTART_HOME_DIRS.some((dir) => inFolder(relative, dir))) {
    return 'a folder whose files run by themselves';
  }
  return null;
}

/** A path from the home folder inside a folder for keys and logins (any case). */
export function isSensitiveHomePath(relative: string): boolean {
  return SENSITIVE_HOME_DIRS.some((dir) => inFolder(relative, dir));
}

function inFolder(relative: string, dir: string): boolean {
  const [lower, folder] = [relative.toLowerCase(), dir.toLowerCase()];
  return lower === folder || lower.startsWith(`${folder}/`) || lower.includes(`/${folder}/`);
}

/** Marketplaces and plugins to reinstall on pull (T29). */
export const PLUGINS_BUNDLE_PATH = `${RESERVED_DIR}/plugins.json`;

/** Programs a hook or the status line needs, with install details (`.agentnomad/programs.json`). */
export const PROGRAMS_BUNDLE_PATH = `${RESERVED_DIR}/programs.json`;

/**
 * Settings files of known status line and hook tools, from the home folder. Taken when a
 * command runs the tool, directly or through `npx` / `bunx`.
 */
export const TOOL_CONFIG_FILES: Readonly<Record<string, readonly string[]>> = DATA.toolConfigFiles;

/** Shells and runtimes: present wherever agentnomad runs, so not recorded as programs. */
export const RUNTIME_COMMANDS: ReadonlySet<string> = new Set(DATA.runtimeCommands);

/** Run a package without installing it; the package name follows the options. */
export const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(DATA.packageRunners);
