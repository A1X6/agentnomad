import { BundlePathSchema } from '@agentnomad/contracts';
import { strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  BACKUP_MARKER,
  INCOMING_MARKER,
  createMergeStrategies,
  selectMergeStrategy,
  type FileConflict,
  type PlannedWrite,
} from '../src/index.ts';

const fixedNow = () => new Date('2026-09-24T17:42:50.123Z');
const strategies = createMergeStrategies({ now: fixedNow });
const { jsonMerge, textSideBySide, overwrite } = strategies;

const STAMP = '20260924T174250Z';

const conflict = (path: string, existing: string, incoming: string): FileConflict => ({
  path,
  existing: strToU8(existing),
  incoming: strToU8(incoming),
});

const text = (write: PlannedWrite | undefined): string =>
  strFromU8(write?.content ?? new Uint8Array());

/** Parses the single write a JSON merge produced. */
function mergedJson(existing: unknown, incoming: unknown): unknown {
  const writes = jsonMerge.resolve(
    conflict('settings.json', JSON.stringify(existing), JSON.stringify(incoming)),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]?.path).toBe('settings.json');
  return JSON.parse(text(writes[0]));
}

describe('every strategy', () => {
  it.each([jsonMerge, textSideBySide, overwrite])(
    '$name writes nothing when the files are identical',
    (strategy) => {
      expect(strategy.resolve(conflict('settings.json', '{"a":1}', '{"a":1}'))).toEqual([]);
    },
  );

  it('uses Windows-safe, valid bundle paths for backups and copies (no colons)', () => {
    const backup = overwrite.resolve(conflict('skills/a/SKILL.md', 'old', 'new'))[0];
    const copy = textSideBySide.resolve(conflict('skills/a/SKILL.md', 'old', 'new'))[0];
    for (const path of [backup?.path, copy?.path]) {
      expect(BundlePathSchema.safeParse(path).success).toBe(true);
      expect(path).not.toContain(':');
    }
  });
});

describe('overwrite: back up the existing file, then write the incoming one', () => {
  it('returns the backup first, then the incoming file', () => {
    const writes = overwrite.resolve(conflict('CLAUDE.md', 'mine', 'theirs'));
    expect(writes.map((write) => write.path)).toEqual([
      `CLAUDE.md${BACKUP_MARKER}${STAMP}`,
      'CLAUDE.md',
    ]);
    expect(text(writes[0])).toBe('mine');
    expect(text(writes[1])).toBe('theirs');
  });

  it('keeps the folder of nested files', () => {
    const [backup] = overwrite.resolve(conflict('agents/team/reviewer.md', 'a', 'b'));
    expect(backup?.path).toBe(`agents/team/reviewer.md${BACKUP_MARKER}${STAMP}`);
  });

  it('handles binary content byte for byte', () => {
    const existing = new Uint8Array([0, 255, 1]);
    const incoming = new Uint8Array([9, 8]);
    const writes = overwrite.resolve({ path: 'logo.png', existing, incoming });
    expect(writes[0]?.content).toEqual(existing);
    expect(writes[1]?.content).toEqual(incoming);
  });

  it('applies to every file', () => {
    expect(overwrite.appliesTo('anything.bin')).toBe(true);
  });
});

describe('text side by side: keep the existing file, write the incoming one next to it', () => {
  it('writes only the incoming copy; the existing file is not touched', () => {
    const writes = textSideBySide.resolve(conflict('commands/deploy.md', 'mine', 'theirs'));
    expect(writes).toEqual([
      { path: `commands/deploy.md${INCOMING_MARKER}${STAMP}`, content: strToU8('theirs') },
    ]);
  });

  it('never gives the copy the original extension, so Claude Code does not load it', () => {
    const [copy] = textSideBySide.resolve(conflict('commands/deploy.md', 'a', 'b'));
    expect(copy?.path.endsWith('.md')).toBe(false);
  });
});

describe('json merge: combine by key, incoming wins', () => {
  it('applies to .json files only', () => {
    expect(jsonMerge.appliesTo('settings.json')).toBe(true);
    expect(jsonMerge.appliesTo('.mcp.json')).toBe(true);
    expect(jsonMerge.appliesTo('KEYBINDINGS.JSON')).toBe(true);
    expect(jsonMerge.appliesTo('CLAUDE.md')).toBe(false);
    expect(jsonMerge.appliesTo('settings.json.bak')).toBe(false);
  });

  it('keeps a file with a number JSON cannot hold exactly, side by side (T45)', () => {
    const existing = strToU8('{"id": 12345678901234567890}');
    const incoming = strToU8('{"theme": "dark"}');
    const writes = jsonMerge.resolve({ path: 'x.json', existing, incoming });
    expect(writes.map((write) => write.path)).toEqual([`x.json${INCOMING_MARKER}${STAMP}`]);
  });

  it('keeps keys only on this PC and adds keys only in the bundle', () => {
    expect(mergedJson({ theme: 'dark' }, { model: 'opus' })).toEqual({
      theme: 'dark',
      model: 'opus',
    });
  });

  it('lets the incoming value win on the same key', () => {
    expect(mergedJson({ theme: 'dark' }, { theme: 'light' })).toEqual({ theme: 'light' });
  });

  it('merges nested objects key by key', () => {
    const existing = { hooks: { PreToolUse: 'lint', Stop: 'notify' }, env: { A: '1' } };
    const incoming = { hooks: { PreToolUse: 'format' }, env: { B: '2' } };
    expect(mergedJson(existing, incoming)).toEqual({
      hooks: { PreToolUse: 'format', Stop: 'notify' },
      env: { A: '1', B: '2' },
    });
  });

  it('replaces arrays with the incoming array (no mixing of lists)', () => {
    const existing = { permissions: { allow: ['Bash(ls)', 'Read'] } };
    const incoming = { permissions: { allow: ['Edit'] } };
    expect(mergedJson(existing, incoming)).toEqual({ permissions: { allow: ['Edit'] } });
  });

  it('lets an incoming null or scalar replace an object, and an object replace a scalar', () => {
    expect(mergedJson({ a: { x: 1 }, b: 1 }, { a: null, b: { y: 2 } })).toEqual({
      a: null,
      b: { y: 2 },
    });
  });

  it('writes 2-space JSON with a trailing newline', () => {
    const [write] = jsonMerge.resolve(conflict('settings.json', '{"a":1}', '{"b":2}'));
    expect(text(write)).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it('writes nothing when the merge result is the same as the existing file', () => {
    const existing = '{\n  "a": 1,\n  "b": 2\n}\n';
    expect(jsonMerge.resolve(conflict('settings.json', existing, '{"b":2}'))).toEqual([]);
  });

  it('reads files that start with a byte order mark (common on Windows)', () => {
    const bom = String.fromCharCode(0xfeff);
    const writes = jsonMerge.resolve(conflict('settings.json', `${bom}{"a":1}`, '{"b":2}'));
    expect(JSON.parse(text(writes[0]))).toEqual({ a: 1, b: 2 });
  });

  it('treats a "__proto__" key as plain data and cannot change other objects', () => {
    const incoming = '{"__proto__":{"polluted":true},"a":1}';
    const [write] = jsonMerge.resolve(conflict('settings.json', '{"b":2}', incoming));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(text(write)).toContain('"__proto__"');
    expect(text(write)).toContain('"polluted": true');
  });

  // Nothing is ever lost: when merging is impossible, fall back to side by side.
  it.each([
    ['existing is not valid JSON', '{broken', '{"a":1}'],
    ['incoming is not valid JSON', '{"a":1}', 'nope'],
    ['existing is a JSON array', '[1,2]', '{"a":1}'],
    ['incoming is a JSON string', '{"a":1}', '"text"'],
  ])('falls back to a side-by-side copy when %s', (_, existing, incoming) => {
    const writes = jsonMerge.resolve(conflict('settings.json', existing, incoming));
    expect(writes).toEqual([
      { path: `settings.json${INCOMING_MARKER}${STAMP}`, content: strToU8(incoming) },
    ]);
  });
});

describe('selectMergeStrategy: the user choice and file type decide the strategy', () => {
  it.each([
    ['merge', 'settings.json', 'json-merge'],
    ['merge', '.mcp.json', 'json-merge'],
    ['merge', 'CLAUDE.md', 'text-side-by-side'],
    ['merge', 'skills/a/SKILL.md', 'text-side-by-side'],
    ['merge', 'logo.png', 'text-side-by-side'],
    ['overwrite', 'settings.json', 'overwrite'],
    ['overwrite', 'CLAUDE.md', 'overwrite'],
  ] as const)('%s + %s uses %s', (choice, path, expected) => {
    expect(selectMergeStrategy(strategies, choice, path).name).toBe(expected);
  });
});
