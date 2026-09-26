import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { posix } from 'node:path';

import { BACKUP_MARKER } from '@agentnomad/core';

/** Adds variables where new terminals (and the programs they start) will see them. */
export interface EnvWriter {
  /** Where they go, for the question and the summary, e.g. `~/.zshrc`. */
  readonly where: string;
  /** Adds or updates the variables; returns the backup made, if any. */
  write(variables: Readonly<Record<string, string>>): Promise<{ readonly backup: string | null }>;
}

export type ShellKind = 'posix' | 'fish';

export const BLOCK_START = '# >>> agentnomad env >>>';
export const BLOCK_END = '# <<< agentnomad env <<<';

/** `it's` → `'it'\''s'`: safe in sh, bash and zsh whatever the value holds. */
export const quotePosix = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** fish single quotes only treat `\\` and `\'` specially. */
export const quoteFish = (value: string) =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function unquotePosix(quoted: string): string {
  return [...quoted.matchAll(/'([^']*)'|\\(.)/g)].map((part) => part[1] ?? part[2] ?? '').join('');
}
function unquoteFish(quoted: string): string {
  return quoted.slice(1, -1).replace(/\\([\\'])/g, '$1');
}

const LINE = {
  posix: /^export ([A-Za-z_][A-Za-z0-9_]*)=((?:'[^']*'|\\')+)$/gm,
  fish: /^set -gx ([A-Za-z_][A-Za-z0-9_]*) ('(?:[^'\\]|\\[\\'])*')$/gm,
};

/** The variables in an existing agentnomad block. */
export function readBlock(text: string, kind: ShellKind): Map<string, string> {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  const variables = new Map<string, string>();
  if (start === -1 || end === -1) return variables;
  const block = text.slice(start + BLOCK_START.length, end);
  for (const match of block.matchAll(LINE[kind])) {
    const [, name, quoted] = match;
    if (name && quoted)
      variables.set(name, kind === 'posix' ? unquotePosix(quoted) : unquoteFish(quoted));
  }
  return variables;
}

/** The profile with the agentnomad block added, or replaced with the merged variables. */
export function upsertBlock(
  text: string,
  variables: Readonly<Record<string, string>>,
  kind: ShellKind,
): string {
  const merged = readBlock(text, kind);
  for (const [name, value] of Object.entries(variables)) merged.set(name, value);
  const lines = [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) =>
      kind === 'posix'
        ? `export ${name}=${quotePosix(value)}`
        : `set -gx ${name} ${quoteFish(value)}`,
    );
  const block = [
    BLOCK_START,
    '# Added by agentnomad pull. Values are plain text on this PC.',
    ...lines,
    BLOCK_END,
  ].join('\n');

  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  const separator = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${block}\n`;
}

/** The profile file a new terminal reads, from `$SHELL` (zsh, bash, fish; sh-style otherwise). */
export function shellProfileFor(
  shell: string | undefined,
  homedir: string,
  platform: NodeJS.Platform,
): { readonly path: string; readonly kind: ShellKind; readonly label: string } {
  const name = posix.basename(shell ?? '');
  if (name === 'fish') {
    return {
      path: posix.join(homedir, '.config', 'fish', 'config.fish'),
      kind: 'fish',
      label: '~/.config/fish/config.fish',
    };
  }
  if (name === 'zsh' || (name === '' && platform === 'darwin')) {
    return { path: posix.join(homedir, '.zshrc'), kind: 'posix', label: '~/.zshrc' };
  }
  if (name === 'bash' && platform === 'darwin') {
    // macOS Terminal starts login shells, which read .bash_profile, not .bashrc.
    return { path: posix.join(homedir, '.bash_profile'), kind: 'posix', label: '~/.bash_profile' };
  }
  if (name === 'bash')
    return { path: posix.join(homedir, '.bashrc'), kind: 'posix', label: '~/.bashrc' };
  return { path: posix.join(homedir, '.profile'), kind: 'posix', label: '~/.profile' };
}

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** `20260925T120000Z`, as in the T11 backup names. */
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

/** macOS and Linux: an agentnomad block in the shell profile, backed up first. */
export function createShellProfileWriter(
  profile: { readonly path: string; readonly kind: ShellKind; readonly label: string },
  now: () => Date = () => new Date(),
): EnvWriter {
  return {
    where: profile.label,
    async write(variables) {
      // A profile linked from a dotfiles folder (stow, chezmoi) is written where it really
      // is, so the link stays (T46).
      // Only a link is followed: a plain file keeps the path as given.
      const link = await lstat(profile.path).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      const target = link?.isSymbolicLink() ? await realpath(profile.path) : profile.path;
      let existing: string | null;
      // A new profile holds saved values, so only this user may read it (T46).
      let mode = 0o600;
      try {
        existing = await readFile(target, 'utf8');
        mode = (await stat(target)).mode & 0o777;
      } catch (error) {
        // Only a missing file is started fresh; any other error must not replace the profile.
        if (!isMissing(error)) throw error;
        existing = null;
      }
      await mkdir(posix.dirname(target), { recursive: true });
      let backup: string | null = null;
      if (existing !== null) {
        backup = `${target}${BACKUP_MARKER}${stamp(now())}`;
        await writeFile(backup, existing, { mode });
      }
      const updated = upsertBlock(existing ?? '', variables, profile.kind);
      const temp = `${target}.agentnomad-tmp-${randomBytes(4).toString('hex')}`;
      try {
        await writeFile(temp, updated, { flag: 'wx', mode });
        await chmod(temp, mode);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return { backup };
    },
  };
}

/** Runs one PowerShell statement; name and value travel as environment variables, not arguments. */
export type PowerShellRunner = (
  script: string,
  env: Readonly<Record<string, string>>,
) => Promise<string>;

export const realPowerShell: PowerShellRunner = (script, env) =>
  new Promise((done, fail) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 30_000 },
      (error, stdout) => {
        if (error) fail(new Error(`PowerShell failed: ${error.message}`, { cause: error }));
        else done(stdout);
      },
    );
  });

/**
 * Windows: the user's environment variables (like "Edit environment variables for your
 * account"). Values never appear on a command line, where other programs could see them.
 */
export function createWindowsEnvWriter(run: PowerShellRunner = realPowerShell): EnvWriter {
  return {
    where: 'your Windows user environment variables',
    async write(variables) {
      for (const [name, value] of Object.entries(variables)) {
        await run(
          "[Environment]::SetEnvironmentVariable($env:AGENTNOMAD_ENV_NAME, $env:AGENTNOMAD_ENV_VALUE, 'User')",
          { AGENTNOMAD_ENV_NAME: name, AGENTNOMAD_ENV_VALUE: value },
        );
      }
      return { backup: null };
    },
  };
}
