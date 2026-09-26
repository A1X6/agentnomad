import type { BundleFile } from '@agentnomad/contracts';
import type { PathResolver } from '@agentnomad/core';

import type { CollectedFile } from '../agents/adapter.ts';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The file's text when it is valid UTF-8 without NUL bytes; `null` for binary files. */
export function asText(content: Uint8Array): string | null {
  if (content.includes(0)) return null;
  try {
    return strictUtf8.decode(content);
  } catch {
    return null;
  }
}

/**
 * Collected files as bundle entries (T33). Text files go in as UTF-8 with this PC's home
 * folder replaced by `{{HOME}}`, so paths work on any PC (T10); everything else as base64,
 * byte for byte.
 */
export function toBundleFiles(
  files: readonly CollectedFile[],
  resolver: PathResolver,
): BundleFile[] {
  return files.map((file) => {
    const text = asText(file.content);
    return text === null
      ? {
          path: file.path,
          executable: file.executable,
          encoding: 'base64',
          content: Buffer.from(file.content).toString('base64'),
        }
      : {
          path: file.path,
          executable: file.executable,
          encoding: 'utf8',
          content: resolver.toPortableText(text),
        };
  });
}

/**
 * Bundle entries back into files for this PC (T34): `{{HOME}}` in text files becomes this
 * PC's home folder; base64 files are decoded byte for byte.
 */
export function fromBundleFiles(
  files: readonly BundleFile[],
  resolver: PathResolver,
): CollectedFile[] {
  return files.map((file) => ({
    path: file.path,
    executable: file.executable,
    content:
      file.encoding === 'utf8'
        ? new TextEncoder().encode(
            resolver.fromPortableText(file.content, {
              // Batch files read `C:/Users/a/bin` as a switch (T45).
              backslashes: /\.(bat|cmd)$/i.test(file.path),
            }),
          )
        : new Uint8Array(Buffer.from(file.content, 'base64')),
  }));
}

/**
 * Keeps this PC's own bytes for a file that already says the same thing (T34). A restored
 * home path always uses forward slashes (`C:/Users/a`), while a file written on this PC may
 * use backslashes; the portable forms are compared, so pulling back onto the same PC leaves
 * such files untouched instead of asking about them.
 */
export function preferLocalEquivalents(
  bundleFiles: readonly BundleFile[],
  restored: readonly CollectedFile[],
  here: readonly CollectedFile[],
  resolver: PathResolver,
): CollectedFile[] {
  const local = new Map(here.map((file) => [file.path, file]));
  return restored.map((file, index) => {
    const entry = bundleFiles[index];
    const mine = local.get(file.path);
    if (entry?.encoding !== 'utf8' || !mine) return file;
    const text = asText(mine.content);
    return text !== null && resolver.toPortableText(text) === entry.content
      ? { ...file, content: mine.content }
      : file;
  });
}
