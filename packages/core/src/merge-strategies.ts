import { strFromU8, strToU8 } from 'fflate';

import type { FileConflict, MergeStrategy, PlannedWrite } from './merge.ts';

/**
 * Suffixes for files the merge strategies create. They go after the original extension,
 * so Claude Code never loads a backup or copy as a real skill, command or agent. Collectors
 * skip files with these markers (T25, T26).
 */
export const BACKUP_MARKER = '.agentnomad-backup-';
export const INCOMING_MARKER = '.agentnomad-incoming-';

export interface MergeStrategyOptions {
  /** Clock for backup and copy names; injectable so tests are deterministic. */
  readonly now?: () => Date;
}

export interface MergeStrategies {
  readonly jsonMerge: MergeStrategy;
  readonly textSideBySide: MergeStrategy;
  readonly overwrite: MergeStrategy;
}

/** `2026-09-24T17:42:50.123Z` to `20260924T174250Z`: sortable, and no colons (Windows-safe). */
function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Invisible character some Windows editors put at the start of text files. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A whole number too large to survive `JSON.parse`, anywhere inside `value` (T45). */
function hasUnsafeInteger(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(hasUnsafeInteger);
  if (isJsonObject(value)) return Object.values(value).some(hasUnsafeInteger);
  return false;
}

/**
 * The file as a JSON object, or `undefined` when it is not valid JSON, not an object, or
 * holds a number a merge would change (such files are kept side by side instead).
 */
function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  const raw = strFromU8(bytes);
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) && !hasUnsafeInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges key by key: objects merge recursively, everything else (including arrays) is
 * replaced by the incoming value. Built through a Map and `Object.fromEntries`, so a key
 * named `__proto__` stays plain data and cannot change other objects.
 */
function deepMerge(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = new Map<string, unknown>(Object.entries(existing));
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged.get(key);
    merged.set(
      key,
      isJsonObject(current) && isJsonObject(value) ? deepMerge(current, value) : value,
    );
  }
  return Object.fromEntries(merged);
}

/** The three conflict strategies from the PRD (T11). All pure: they return planned writes. */
export function createMergeStrategies(options: MergeStrategyOptions = {}): MergeStrategies {
  const now = options.now ?? (() => new Date());

  const textSideBySide: MergeStrategy = {
    name: 'text-side-by-side',
    appliesTo: () => true,
    resolve: ({ path, existing, incoming }: FileConflict): readonly PlannedWrite[] =>
      sameBytes(existing, incoming)
        ? []
        : [{ path: `${path}${INCOMING_MARKER}${timestamp(now())}`, content: incoming }],
  };

  const overwrite: MergeStrategy = {
    name: 'overwrite',
    appliesTo: () => true,
    resolve: ({ path, existing, incoming }: FileConflict): readonly PlannedWrite[] =>
      sameBytes(existing, incoming)
        ? []
        : [
            { path: `${path}${BACKUP_MARKER}${timestamp(now())}`, content: existing },
            { path, content: incoming },
          ],
  };

  const jsonMerge: MergeStrategy = {
    name: 'json-merge',
    appliesTo: (path) => /\.json$/i.test(path),
    resolve(conflict: FileConflict): readonly PlannedWrite[] {
      if (sameBytes(conflict.existing, conflict.incoming)) return [];
      const existing = parseJsonObject(conflict.existing);
      const incoming = parseJsonObject(conflict.incoming);
      // Cannot merge safely: keep the existing file and write the incoming one next to it.
      if (!existing || !incoming) return textSideBySide.resolve(conflict);

      const content = strToU8(`${JSON.stringify(deepMerge(existing, incoming), null, 2)}\n`);
      return sameBytes(content, conflict.existing) ? [] : [{ path: conflict.path, content }];
    },
  };

  return { jsonMerge, textSideBySide, overwrite };
}

/**
 * The strategy for the user's choice: "overwrite" always overwrites (with a backup);
 * "merge" merges JSON files and keeps both copies of everything else.
 */
export function selectMergeStrategy(
  strategies: MergeStrategies,
  choice: 'merge' | 'overwrite',
  path: string,
): MergeStrategy {
  if (choice === 'overwrite') return strategies.overwrite;
  return strategies.jsonMerge.appliesTo(path) ? strategies.jsonMerge : strategies.textSideBySide;
}
