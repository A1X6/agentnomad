import { posix, win32 } from 'node:path';

import { BundlePathSchema } from '@agentnomad/contracts';

import { commandsInSettings, commandWords } from './file-gathering.ts';
import {
  NEVER_SYNCED,
  HOME_SCRIPTS_PREFIX,
  homePathProblem,
  SCRIPT_EXTENSIONS,
} from './global-paths.ts';

export interface HookScriptContext {
  readonly homedir: string;
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
}

/** A script a hook or the status line runs: where it is, and its bundle path. */
export interface HookScript {
  readonly nativePath: string;
  /** `hooks/a.sh` in the base folder, or `.agentnomad/home/...` elsewhere in the home. */
  readonly bundlePath: string;
}

const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The scripts that the hooks and status line in a global `settings.json` run (T25), as push
 * collects them and pull allows them back (T38): script files in the base folder (not never-
 * synced ones) or elsewhere in the home folder (never in folders for keys and logins, nor
 * in ones whose files run by themselves, T43).
 * Push saves only these; pull writes a home-folder file only when it is one of these, so a
 * bundle cannot place other files that run by themselves (a Startup folder, a shell profile).
 */
export function hookScripts(settingsJson: string, context: HookScriptContext): HookScript[] {
  const path = context.platform === 'win32' ? win32 : posix;
  const home = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
  const config = /^(\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\}|%CLAUDE_CONFIG_DIR%)(?=[\\/]|$)/i;

  const relativeInside = (folder: string, file: string): string | null => {
    const relative = path.relative(folder, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const bundlePath = relative.split(path.sep).join('/');
    return BundlePathSchema.safeParse(bundlePath).success ? bundlePath : null;
  };

  const found = new Map<string, HookScript>();
  for (const command of commandsInSettings(settingsJson)) {
    for (const word of commandWords(command)) {
      const expanded = word
        .replace(home, () => context.homedir)
        .replace(config, () => context.baseDir);
      if (!path.isAbsolute(expanded)) continue;
      const nativePath = path.normalize(expanded);
      if (!SCRIPT_EXTENSIONS.has(path.extname(nativePath).toLowerCase())) continue;

      const inBase = relativeInside(context.baseDir, nativePath);
      const inHome = relativeInside(context.homedir, nativePath);
      let bundlePath: string;
      if (inBase !== null) {
        if (NEVER_SYNCED.some((entry) => under(inBase, entry))) continue;
        bundlePath = inBase;
      } else if (inHome !== null && homePathProblem(inHome) === null) {
        bundlePath = HOME_SCRIPTS_PREFIX + inHome;
      } else {
        continue;
      }
      found.set(bundlePath, { nativePath, bundlePath });
    }
  }
  return [...found.values()];
}
