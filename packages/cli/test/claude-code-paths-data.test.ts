import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentVersionNotice,
  CLAUDE_CODE_PATHS,
  compareVersions,
  findUnknownEntries,
  GLOBAL_FOLDERS,
  NEVER_SYNCED,
  SCRIPT_EXTENSIONS,
  unknownEntriesNotice,
} from '../src/index.ts';

let root: string;
let base: string;
let project: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-unknown-'));
  base = join(root, '.claude');
  project = join(root, 'app');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'x');
}

const input = () => ({ baseDir: base, platform: process.platform });

describe('paths data file', () => {
  it('is the source of every list the adapter uses', () => {
    expect(GLOBAL_FOLDERS).toEqual(CLAUDE_CODE_PATHS.global.folders);
    expect(NEVER_SYNCED).toContain('skills/synced');
    expect([...SCRIPT_EXTENSIONS]).toEqual(CLAUDE_CODE_PATHS.scriptExtensions);
  });

  it('never lists one name as both synced and never synced', () => {
    const synced = new Set([
      ...CLAUDE_CODE_PATHS.global.files,
      ...CLAUDE_CODE_PATHS.global.folders,
    ]);
    expect(CLAUDE_CODE_PATHS.global.neverSynced.filter((entry) => synced.has(entry))).toEqual([]);
    const known = new Set(CLAUDE_CODE_PATHS.global.knownState);
    expect(CLAUDE_CODE_PATHS.global.neverSynced.filter((entry) => known.has(entry))).toEqual([]);
  });
});

describe('unknown-file check (T32 done-when)', () => {
  it('reports an unlisted file or folder, never skipping it silently', async () => {
    await put(join(base, 'settings.json'));
    await put(join(base, 'skills', 'mine', 'SKILL.md'));
    await put(join(base, 'hooks', 'a.sh'));
    await put(join(base, 'new-feature.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([
      'hooks/',
      'new-feature.json',
    ]);
  });

  it('does not report a folder whose script a hook or the status line runs (T49)', async () => {
    const home = dirname(base);
    await put(join(base, 'hooks', 'check.sh'));
    await put(join(base, 'bin', 'status.sh'));
    await put(join(base, 'tools', 'unused.sh'));
    await writeFile(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/check.sh' }] }] },
        statusLine: { type: 'command', command: 'bash ~/.claude/bin/status.sh' },
      }),
    );
    // push saves hooks/check.sh and bin/status.sh; nothing in tools/ is saved.
    expect(await findUnknownEntries({ kind: 'global' }, { ...input(), homedir: home })).toEqual([
      'tools/',
    ]);
  });

  it('does not report skills/synced/, secrets, state or known copies', async () => {
    await put(join(base, 'skills', 'synced', 'x', 'SKILL.md'));
    await put(join(base, '.credentials.json'));
    await put(join(base, 'projects', 'C--x', 'a.jsonl'));
    await put(join(base, 'state', 'x'));
    await put(join(base, 'chrome', 'x'));
    await put(join(base, 'settings.json.bak'));
    await put(join(base, 'CLAUDE.md.agentnomad-backup-20260925T120000Z'));
    await put(join(base, '.claude.json'));
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });

  it('checks a project’s .claude folder', async () => {
    await put(join(project, '.claude', 'settings.json'));
    await put(join(project, '.claude', 'worktrees', 'wt', 'x'));
    await put(join(project, '.claude', 'agent-memory-local', 'x'));
    await put(join(project, '.claude', 'hooks', 'lint.sh'));
    await put(join(project, '.claude', 'brand-new.json'));
    await put(join(project, 'src', 'index.ts'));
    expect(await findUnknownEntries({ kind: 'project', projectDir: project }, input())).toEqual([
      '.claude/brand-new.json',
    ]);
  });

  it('says what was not saved and why', () => {
    expect(unknownEntriesNotice(['hooks/', 'new-feature.json'])).toBe(
      'Not saved, because agentnomad does not know these yet: hooks/, new-feature.json. A newer Claude Code may have added them; if they matter to you, update agentnomad.',
    );
    expect(unknownEntriesNotice([])).toBeNull();
  });

  it('a missing folder reports nothing', async () => {
    expect(await findUnknownEntries({ kind: 'global' }, input())).toEqual([]);
  });
});

describe('Claude Code version stamp', () => {
  it.each([
    ['2.1.282', '2.1.282', 0],
    ['2.2.0', '2.1.282', 1],
    ['2.1.9', '2.1.10', -1],
    ['2.0.0-beta.3', '2.0.0', 0],
    ['3', '2.9.9', 1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it('warns only when the setup came from a newer version', () => {
    expect(agentVersionNotice('Claude Code', '2.2.0', '2.1.282')).toBe(
      'This setup was saved from Claude Code 2.2.0, but this PC has 2.1.282. Update Claude Code so every setting works.',
    );
    expect(agentVersionNotice('Claude Code', '2.1.0', '2.1.282')).toBeNull();
    expect(agentVersionNotice('Claude Code', null, '2.1.282')).toBeNull();
    expect(agentVersionNotice('Claude Code', '2.1.0', null)).toContain('version here is unknown');
  });
});
