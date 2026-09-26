import { BundlePathSchema, hasControlCharacter } from '@agentnomad/contracts';

import { HOME_PLACEHOLDER, PathError, type PathEnvironment, type PathResolver } from './paths.ts';

/**
 * Names Windows keeps for devices, in any folder and with any extension (`nul.txt`),
 * including the superscript `COM¹`–`LPT³` forms Microsoft's naming rules list.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** An 8.3 short name (`PROGRA~1`, `SSH~1`), which can reach a folder under another name. */
const SHORT_NAME = /~\d+(\.[^.]*)?$/;

/** `{{HOME}}` and its kept forms `{{HOME\}}`, `{{HOME\\}}`, …; group 1 is the backslashes. */
const PLACEHOLDER_FORMS = /\{\{HOME(\\*)\}\}/g;

/** Characters that can be part of a folder name next to the home path (for exact matching). */
const NAME_CHARACTER = '[A-Za-z0-9._-]';

/** One path segment in text: stops at whitespace, quotes, separators and shell punctuation. */
const TEXT_SEGMENT = '[^\\s"\'`\\\\/,;|&<>(){}\\[\\]*?]+';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why a bundle path cannot be written safely on Windows (T38, T43), or `null`: a `:` would
 * write a hidden alternate data stream, device names reach a device, a trailing dot or space
 * is dropped (the file lands under another name), and an 8.3 short name can reach a folder
 * that is refused under its long name (`SSH~1` is `.ssh`).
 */
export function windowsNameProblem(path: string): string | null {
  for (const segment of path.split('/')) {
    if (segment.includes(':')) return 'a name with ":" cannot be written on Windows';
    if (hasControlCharacter(segment) || /[<>"|?*]/.test(segment)) {
      return 'a name Windows does not allow';
    }
    if (WINDOWS_DEVICE.test(segment)) return 'a name Windows keeps for devices';
    if (/[. ]$/.test(segment)) return 'a name ending in a dot or space on Windows';
    if (SHORT_NAME.test(segment)) return 'a Windows short name (like PROGRA~1)';
  }
  return null;
}

/** Throws when a bundle path cannot be created as-is on Windows. */
function assertWindowsSafe(bundlePath: string): void {
  const problem = windowsNameProblem(bundlePath);
  if (problem !== null) {
    throw new PathError(`"${bundlePath}" cannot be restored on Windows (${problem})`);
  }
}

function assertSafeBundlePath(bundlePath: string): void {
  if (!BundlePathSchema.safeParse(bundlePath).success) {
    throw new PathError(`Unsafe bundle path: "${bundlePath}"`);
  }
}

/** Windows paths with backslashes and no trailing separator (except a drive root like `C:\`). */
function normalizeWindows(path: string): string {
  const backslashed = path.replace(/\//g, '\\');
  return /^[A-Za-z]:\\$/.test(backslashed) ? backslashed : backslashed.replace(/\\+$/, '');
}

/** POSIX paths with no trailing slash (except the root `/`). */
function normalizePosix(path: string): string {
  return path === '/' ? path : path.replace(/\/+$/, '');
}

function assertValidHome(environment: PathEnvironment): void {
  const { os, homeDir } = environment;
  const valid =
    os === 'win32'
      ? /^[A-Za-z]:[\\/][^\\/]/.test(homeDir)
      : homeDir.startsWith('/') && !['', '/'].includes(normalizePosix(homeDir));
  if (!valid)
    throw new PathError(`Home folder must be an absolute path below the root: "${homeDir}"`);
}

/** Replaces the home folder in text, in each way it can be written, with `{{HOME}}/...`. */
function windowsToPortable(text: string, homeDir: string): string {
  const segments = homeDir.split(/[\\/]+/).filter((segment) => segment !== '');
  // JSON-escaped backslashes first, then forward slashes, then plain backslashes.
  const separators = ['\\\\\\\\', '/', '\\\\'];
  return separators.reduce((current, separator) => {
    const pattern = new RegExp(
      `(?<!${NAME_CHARACTER})${segments.map(escapeRegExp).join(separator)}` +
        `((?:${separator}${TEXT_SEGMENT})*)(?!${NAME_CHARACTER})`,
      'gi',
    );
    const separatorPattern = new RegExp(separator, 'g');
    return current.replace(
      pattern,
      (_match, rest: string) => HOME_PLACEHOLDER + rest.replace(separatorPattern, '/'),
    );
  }, text);
}

function posixToPortable(text: string, homeDir: string): string {
  const pattern = new RegExp(
    `(?<!${NAME_CHARACTER}|/)${escapeRegExp(homeDir)}(?!${NAME_CHARACTER})`,
    'g',
  );
  return text.replace(pattern, HOME_PLACEHOLDER);
}

/**
 * PathResolver for one OS and home folder (T10). Pure string logic, so every OS can be
 * tested on any OS. Portable text always uses forward slashes after `{{HOME}}`; on Windows
 * the home folder is restored as `C:/Users/...`, which Windows accepts and JSON needs no
 * escaping for.
 */
export function createPathResolver(environment: PathEnvironment): PathResolver {
  assertValidHome(environment);
  const windows = environment.os === 'win32';
  const homeDir = windows
    ? normalizeWindows(environment.homeDir)
    : normalizePosix(environment.homeDir);
  const portableHome = windows ? homeDir.replace(/\\/g, '/') : homeDir;

  return {
    environment,

    toNativePath(baseDir, bundlePath) {
      assertSafeBundlePath(bundlePath);
      if (windows) {
        assertWindowsSafe(bundlePath);
        const base = normalizeWindows(baseDir);
        const joiner = base.endsWith('\\') ? '' : '\\';
        return base + joiner + bundlePath.split('/').join('\\');
      }
      const base = normalizePosix(baseDir);
      return (base === '/' ? '' : base) + '/' + bundlePath;
    },

    toBundlePath(baseDir, nativePath) {
      const [base, path] = windows
        ? [normalizeWindows(baseDir), nativePath.replace(/\//g, '\\')]
        : [normalizePosix(baseDir), nativePath];
      const separator = windows ? '\\' : '/';
      const prefix = base.endsWith(separator) ? base : base + separator;
      // Windows paths are case-insensitive; macOS and Linux paths are compared exactly.
      const inside = windows
        ? path.toLowerCase().startsWith(prefix.toLowerCase())
        : path.startsWith(prefix);
      if (!inside) throw new PathError(`"${nativePath}" is not inside "${baseDir}"`);

      const bundlePath = path.slice(prefix.length).split(separator).join('/');
      if (!BundlePathSchema.safeParse(bundlePath).success) {
        throw new PathError(`"${nativePath}" is not inside "${baseDir}"`);
      }
      return bundlePath;
    },

    toPortableText(text) {
      // A `{{HOME}}` already in the text gets one more backslash, so pull can tell it from
      // the ones that stand for the home folder: `{{HOME}}` → `{{HOME\}}` (T45).
      const kept = text.replace(
        PLACEHOLDER_FORMS,
        (_match, slashes: string) => `{{HOME${slashes}\\}}`,
      );
      return windows ? windowsToPortable(kept, homeDir) : posixToPortable(kept, homeDir);
    },

    fromPortableText(text, options = {}) {
      const backslashes = windows && options.backslashes === true;
      const pattern = new RegExp(`${PLACEHOLDER_FORMS.source}((?:/${TEXT_SEGMENT})*)`, 'g');
      return text.replace(pattern, (_match, slashes: string, rest: string) => {
        if (slashes !== '') return `{{HOME${slashes.slice(1)}}}${rest}`;
        return backslashes ? homeDir + rest.replace(/\//g, '\\') : portableHome + rest;
      });
    },
  };
}
