import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createClaudeCodeGlobalCollector,
  createClaudeCodeProjectCollector,
  createClaudeCodeRestorer,
  createClaudeRunningCheck,
  globalDestination,
  hookScripts,
  windowsNameProblem,
  hooksForOtherOs,
  isClaudeProcess,
  lineEndingsFor,
  projectDestination,
  projectDirName,
  type ClaudeRunningAnswer,
  type CollectedFile,
  type ConflictChoice,
  type ConflictQuestion,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const STAMP = '20260925T120000Z';

let root: string;
let home: string;
let base: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-restore-'));
  home = join(root, 'home');
  base = join(home, '.claude');
  project = join(root, 'work', 'my-app');
  await mkdir(base, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string | Uint8Array = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const read = (path: string) => readFile(path, 'utf8');
const readJson = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;
const file = (path: string, content: string, executable = false): CollectedFile => ({
  path,
  content: new TextEncoder().encode(content),
  executable,
});

interface Setup {
  running?: boolean[];
  runningAnswers?: ClaudeRunningAnswer[];
  customConfigDir?: boolean;
}

function restorer(setup: Setup = {}) {
  const running = [...(setup.running ?? [false])];
  const answers = [...(setup.runningAnswers ?? [])];
  const asked: string[] = [];
  return {
    asked,
    restorer: createClaudeCodeRestorer({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
      customConfigDir: setup.customConfigDir ?? false,
      now: () => NOW,
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      onClaudeRunning: () => {
        asked.push('close claude?');
        return Promise.resolve(answers.shift() ?? 'skip');
      },
    }),
  };
}

/** Answers every conflict question the same way and records what was asked. */
function answer(choice: ConflictChoice) {
  const questions: [string, ConflictQuestion][] = [];
  const resolve = (path: string, question: ConflictQuestion) => {
    questions.push([path, question]);
    return Promise.resolve(choice);
  };
  return { questions, resolve };
}

describe('restorer: round trip', () => {
  it('a collected global setup restores byte-for-byte on a fresh PC', async () => {
    const sourceHome = join(root, 'source');
    const sourceBase = join(sourceHome, '.claude');
    await put(join(sourceBase, 'settings.json'), '{"theme":"dark"}\n');
    await put(join(sourceBase, 'CLAUDE.md'), '# Rules\r\nWindows line endings stay.\r\n');
    await put(join(sourceBase, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
    await put(join(sourceBase, 'skills', 'deploy', 'logo.png'), new Uint8Array([0, 255, 1, 254]));
    const collected = await createClaudeCodeGlobalCollector({
      baseDir: sourceBase,
      homedir: sourceHome,
      platform: process.platform,
      customConfigDir: false,
    }).collect({ kind: 'global' }, { includeMemory: false });

    const report = await restorer().restorer.restore(
      { kind: 'global' },
      collected,
      answer('skip').resolve,
    );
    expect(report.written).toEqual(collected.map((entry) => entry.path));
    for (const entry of collected) {
      expect(new Uint8Array(await readFile(join(base, ...entry.path.split('/'))))).toEqual(
        entry.content,
      );
    }
  });

  it('a collected project setup restores into another folder, memory included', async () => {
    const source = join(root, 'other-pc', 'my-app');
    await put(join(source, 'CLAUDE.md'), 'project rules');
    await put(join(source, '.claude', 'settings.local.json'), '{}');
    const sourceMemory = join(base, 'projects', projectDirName(source), 'memory');
    await put(join(sourceMemory, 'MEMORY.md'), 'remember this');
    const collected = await createClaudeCodeProjectCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
    }).collect({ kind: 'project', projectDir: source }, { includeMemory: true });

    await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      collected,
      answer('skip').resolve,
    );
    expect(await read(join(project, 'CLAUDE.md'))).toBe('project rules');
    // Memory lands in this folder's own memory directory.
    expect(await read(join(base, 'projects', projectDirName(project), 'memory', 'MEMORY.md'))).toBe(
      'remember this',
    );
  });
});

describe('restorer: refuses what a collector never produces', () => {
  it.each([
    ['skills/synced/x/SKILL.md', 'never synced'],
    ['.credentials.json', 'never synced'],
    ['history.jsonl', 'never synced'],
    ['projects/C--x/abc.jsonl', 'never synced'],
    ['unknown.json', 'not part of a Claude Code setup'],
    ['.agentnomad/home/.ssh/id_ed25519', 'a folder for keys and logins'],
    ['.agentnomad/home/.bashrc', 'no hook or status line in this setup runs it'],
    // Files that run by themselves, never shown in the pull review (T38, T43).
    [
      '.agentnomad/home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/update.bat',
      'a folder whose files run by themselves',
    ],
    [
      '.agentnomad/home/Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
      'a folder whose files run by themselves',
    ],
    [
      '.agentnomad/home/OneDrive/Documents/WindowsPowerShell/profile.ps1',
      'a folder whose files run by themselves',
    ],
    ['.agentnomad/home/.config/fish/config.fish', 'a folder whose files run by themselves'],
    ['.agentnomad/home/.config/fish/conf.d/a.fish', 'a folder whose files run by themselves'],
    ['.agentnomad/home/Library/LaunchAgents/x.sh', 'a folder whose files run by themselves'],
    ['.agentnomad/home/.SSH/id_ed25519', 'a folder for keys and logins'],
    ['.agentnomad/other.json', 'unknown agentnomad entry'],
    // Windows and macOS ignore case: another spelling of a refused folder is refused too (T43).
    ['Plugins/cache/m/p/1.0.0/hooks/run.sh', 'never synced'],
    ['Skills/Synced/x/run.sh', 'never synced'],
    ['.AgentNomad/home/x.sh', 'unknown agentnomad entry'],
    ['../outside.md', 'not a safe path'],
  ])('global: %s', (path, reason) => {
    expect(globalDestination(path, new Set())).toEqual({ kind: 'refused', reason });
  });

  it('global: a hook naming an autostart file does not make it restorable (T43)', () => {
    const startup = 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/a.cmd';
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `~/${startup}` }] }] },
    });
    const context = { homedir: home, baseDir: base, platform: process.platform };
    expect(hookScripts(settings, context)).toEqual([]);
    expect(
      globalDestination(`.agentnomad/home/${startup}`, new Set([`.agentnomad/home/${startup}`])),
    ).toEqual({ kind: 'refused', reason: 'a folder whose files run by themselves' });
  });

  it('global: a home script is restored only when a hook or the status line runs it', () => {
    const settings = JSON.stringify({
      statusLine: { type: 'command', command: '~/scripts/statusline.sh' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash $HOME/tools/stop.sh' }] }] },
    });
    const scripts = new Set(
      hookScripts(settings, { homedir: home, baseDir: base, platform: process.platform }).map(
        (script) => script.bundlePath,
      ),
    );
    expect(scripts).toEqual(
      new Set(['.agentnomad/home/scripts/statusline.sh', '.agentnomad/home/tools/stop.sh']),
    );
    expect(globalDestination('.agentnomad/home/scripts/statusline.sh', scripts)).toEqual({
      kind: 'home',
      path: 'scripts/statusline.sh',
    });
    expect(globalDestination('.agentnomad/home/scripts/other.sh', scripts)).toEqual({
      kind: 'refused',
      reason: 'no hook or status line in this setup runs it',
    });
    // Known tool settings are not run, so they need no hook.
    expect(
      globalDestination('.agentnomad/home/.config/ccstatusline/settings.json', new Set()),
    ).toEqual({ kind: 'home', path: '.config/ccstatusline/settings.json' });
  });

  it.each([
    ['.git/config', 'never synced'],
    ['.claude/agent-memory-local/a/MEMORY.md', 'never synced'],
    ['.claude/worktrees/wt/CLAUDE.md', 'never synced'],
    ['src/index.ts', 'not part of a Claude Code setup'],
    ['.env', 'not part of a Claude Code setup'],
    ['.GIT/hooks/pre-commit.sh', 'never synced'],
    ['.agentnomad/x.sh', 'unknown agentnomad entry'],
    ['.agentnomad/auto-memory/run.sh', 'auto memory holds only Markdown files'],
    ['.agentnomad/auto-memory/.bashrc', 'auto memory holds only Markdown files'],
  ])('project: %s', (path, reason) => {
    expect(projectDestination(path)).toEqual({ kind: 'refused', reason });
  });

  it('never writes into skills/synced/, even when a bundle contains it', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('skills/synced/evil/SKILL.md', 'x'), file('skills/mine/SKILL.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['skills/synced/evil/SKILL.md']);
    expect(report.warnings).toEqual(['Refused "skills/synced/evil/SKILL.md": never synced.']);
    await expect(stat(join(base, 'skills', 'synced'))).rejects.toThrow();
    expect(await read(join(base, 'skills', 'mine', 'SKILL.md'))).toBe('ok');
  });

  it('does not write programs.json (pull only reads it)', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('.agentnomad/programs.json', '{"programs":[]}')],
      answer('skip').resolve,
    );
    expect(report).toEqual({ written: [], skipped: [], backups: [], warnings: [] });
    expect(await readdir(base)).toEqual([]);
  });
});

describe('restorer: existing files', () => {
  it('leaves an identical file alone without asking', async () => {
    await put(join(base, 'CLAUDE.md'), 'same');
    const { questions, resolve } = answer('overwrite');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'same')],
      resolve,
    );
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('asks about a different file, and skip leaves it untouched', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const { questions, resolve } = answer('skip');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      resolve,
    );
    expect(questions).toEqual([['CLAUDE.md', { overwriteAllowed: true }]]);
    expect(report.skipped).toEqual(['CLAUDE.md']);
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
  });

  it('overwrite backs the old file up first', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('theirs');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('mine');
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}`]);
  });

  it('never replaces an earlier backup made in the same second (T45)', async () => {
    await put(join(base, 'CLAUDE.md'), 'first');
    await put(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`), 'older backup');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'second')],
      answer('overwrite').resolve,
    );
    expect(report.backups).toEqual([`CLAUDE.md.agentnomad-backup-${STAMP}-2`]);
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}`))).toBe('older backup');
    expect(await read(join(base, `CLAUDE.md.agentnomad-backup-${STAMP}-2`))).toBe('first');
  });

  it('merge combines JSON keys, the pulled values winning', async () => {
    await put(join(base, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', JSON.stringify({ theme: 'dark', effortLevel: 'high' }))],
      answer('merge').resolve,
    );
    expect(JSON.parse(await read(join(base, 'settings.json')))).toEqual({
      theme: 'dark',
      model: 'opus',
      effortLevel: 'high',
    });
  });

  it('merge keeps a different text file and puts the pulled one next to it', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      answer('merge').resolve,
    );
    expect(await read(join(base, 'CLAUDE.md'))).toBe('mine');
    expect(await read(join(base, `CLAUDE.md.agentnomad-incoming-${STAMP}`))).toBe('theirs');
    expect(report.written).toEqual([`CLAUDE.md.agentnomad-incoming-${STAMP}`]);
  });

  it('leaves no temporary files behind', async () => {
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('rules/a.md', 'a')],
      answer('skip').resolve,
    );
    expect(await readdir(join(base, 'rules'))).toEqual(['a.md']);
  });
});

describe('restorer: ~/.claude.json', () => {
  const incoming = file(
    '.agentnomad/claude.json',
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, diffTool: 'terminal' }),
  );
  const existingJson = {
    oauthAccount: { emailAddress: 'me@example.com' },
    projects: { '/x': { hasTrustDialogAccepted: true } },
    mcpServers: { local: { command: 'local-mcp' } },
    diffTool: 'auto',
  };

  it('merges only the servers and preferences, keeping the login and everything else', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    const { questions, resolve } = answer('merge');
    const report = await restorer().restorer.restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([['.agentnomad/claude.json', { overwriteAllowed: false }]]);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual({
      ...existingJson,
      mcpServers: { local: { command: 'local-mcp' }, github: { command: 'gh-mcp' } },
      diffTool: 'terminal',
    });
    expect(report.backups).toEqual([join(home, `.claude.json.agentnomad-backup-${STAMP}`)]);
  });

  it('never replaces the file, even when the answer is overwrite', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('overwrite').resolve);
    expect((await readJson(join(home, '.claude.json')))['oauthAccount']).toEqual(
      existingJson.oauthAccount,
    );
  });

  it('skip leaves it alone', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect(JSON.parse(await read(join(home, '.claude.json')))).toEqual(existingJson);
  });

  it('asks nothing when the keys are already there', async () => {
    await put(
      join(home, '.claude.json'),
      JSON.stringify({
        ...existingJson,
        mcpServers: { github: { command: 'gh-mcp' } },
        diffTool: 'terminal',
      }),
    );
    const { questions, resolve } = answer('merge');
    const report = await restorer().restorer.restore({ kind: 'global' }, [incoming], resolve);
    expect(questions).toEqual([]);
    expect(report.written).toEqual([]);
  });

  it('waits while Claude Code runs: retry after closing it, then writes', async () => {
    await put(join(home, '.claude.json'), '{}');
    const { restorer: r, asked } = restorer({ running: [true, false], runningAnswers: ['retry'] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(asked).toEqual(['close claude?']);
    expect(report.written).toEqual(['.agentnomad/claude.json']);
  });

  it('skips it while Claude Code runs when the user says so, and says why', async () => {
    await put(join(home, '.claude.json'), '{}');
    const { restorer: r } = restorer({ running: [true], runningAnswers: ['skip'] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code was running');
  });

  it('with --yes skips it while Claude Code runs, without asking', async () => {
    await put(join(home, '.claude.json'), '{}');
    const { restorer: r, asked } = restorer({ running: [true] });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve, {
      assumeYes: true,
    });
    expect(asked).toEqual([]);
    expect(await read(join(home, '.claude.json'))).toBe('{}');
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(report.warnings[0]).toContain('Claude Code was running');
  });

  it('restores only the servers and preferences, never projects or account state (T43)', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(existingJson));
    const forged = file(
      '.agentnomad/claude.json',
      JSON.stringify({
        mcpServers: { github: { command: 'gh-mcp' } },
        projects: {
          '/x': { mcpServers: { evil: { command: 'sh' } }, hasTrustDialogAccepted: true },
        },
        oauthAccount: { emailAddress: 'attacker@example.com' },
      }),
    );
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [forged],
      answer('merge').resolve,
    );
    const after = await readJson(join(home, '.claude.json'));
    expect(after['projects']).toEqual(existingJson.projects);
    expect(after['oauthAccount']).toEqual(existingJson.oauthAccount);
    expect(after['mcpServers']).toEqual({
      local: { command: 'local-mcp' },
      github: { command: 'gh-mcp' },
    });
    expect(report.warnings).toEqual([
      `Left out of ${join(home, '.claude.json')}: "projects", "oauthAccount" (only MCP servers and preferences are restored there).`,
    ]);
  });

  it('writes nothing when the bundle holds none of the keys it restores', async () => {
    const forged = file('.agentnomad/claude.json', JSON.stringify({ projects: {} }));
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [forged],
      answer('merge').resolve,
    );
    await expect(stat(join(home, '.claude.json'))).rejects.toThrow();
    expect(report.written).toEqual([]);
  });

  it('merges into the file as Claude Code left it after closing (T43)', async () => {
    await put(join(home, '.claude.json'), JSON.stringify({ diffTool: 'auto' }));
    const running = [true, false];
    const r = createClaudeCodeRestorer({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      env: {},
      customConfigDir: false,
      now: () => NOW,
      isClaudeRunning: () => Promise.resolve(running.shift() ?? false),
      // Claude Code saves the file as it closes.
      onClaudeRunning: async () => {
        await writeFile(
          join(home, '.claude.json'),
          JSON.stringify({ diffTool: 'auto', projects: { '/new': {} } }),
        );
        return 'retry';
      },
    });
    const report = await r.restore({ kind: 'global' }, [incoming], answer('merge').resolve);
    expect(await readJson(join(home, '.claude.json'))).toEqual({
      diffTool: 'terminal',
      projects: { '/new': {} },
      mcpServers: { github: { command: 'gh-mcp' } },
    });
    expect(await readJson(report.backups[0] ?? '')).toEqual({
      diffTool: 'auto',
      projects: { '/new': {} },
    });
  });

  it('creates it when missing, readable only by this user', async () => {
    await restorer().restorer.restore({ kind: 'global' }, [incoming], answer('skip').resolve);
    expect((await readJson(join(home, '.claude.json')))['diffTool']).toBe('terminal');
    if (posix) expect((await stat(join(home, '.claude.json'))).mode & 0o777).toBe(0o600);
  });

  it('goes into CLAUDE_CONFIG_DIR when that is set', async () => {
    await restorer({ customConfigDir: true }).restorer.restore(
      { kind: 'global' },
      [incoming],
      answer('skip').resolve,
    );
    expect((await readJson(join(base, '.claude.json')))['diffTool']).toBe('terminal');
  });
});

describe('restorer: home files', () => {
  it('puts tool settings and hook scripts back in the home folder', async () => {
    const hook = { Stop: [{ hooks: [{ type: 'command', command: '~/scripts/notify.sh' }] }] };
    await restorer().restorer.restore(
      { kind: 'global' },
      [
        file('settings.json', JSON.stringify({ hooks: hook })),
        file('.agentnomad/home/.config/ccstatusline/settings.json', '{"lines":[]}'),
        file('.agentnomad/home/scripts/notify.sh', 'echo hi\n', true),
      ],
      answer('skip').resolve,
    );
    expect(await read(join(home, '.config', 'ccstatusline', 'settings.json'))).toBe('{"lines":[]}');
    expect(await read(join(home, 'scripts', 'notify.sh'))).toBe('echo hi\n');
  });

  it('skips a home script no hook runs, e.g. one for the Windows Startup folder (T38)', async () => {
    const startup = 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/update.bat';
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file(`.agentnomad/home/${startup}`, 'echo pwned\n')],
      answer('merge').resolve,
    );
    expect(report.written).toEqual([]);
    expect(report.skipped).toEqual([`.agentnomad/home/${startup}`]);
    await expect(read(join(home, ...startup.split('/')))).rejects.toThrow();
  });
});

describe('restorer: one bad entry never stops the rest (T43)', () => {
  it('skips an entry it cannot write, with a warning, and writes the others', async () => {
    await put(join(base, 'skills', 'deploy'), 'a file where the bundle has a folder');
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('skills/deploy/SKILL.md', 'x'), file('skills/review/SKILL.md', 'ok')],
      answer('overwrite').resolve,
    );
    expect(report.skipped).toEqual(['skills/deploy/SKILL.md']);
    expect(report.warnings[0]).toMatch(/^Skipped "skills\/deploy\/SKILL.md": /);
    expect(await read(join(base, 'skills', 'review', 'SKILL.md'))).toBe('ok');
  });

  it('a broken .agentnomad/claude.json is skipped, not fatal', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('.agentnomad/claude.json', '{not json'), file('rules/a.md', 'a')],
      answer('skip').resolve,
    );
    expect(report.skipped).toEqual(['.agentnomad/claude.json']);
    expect(await read(join(base, 'rules', 'a.md'))).toBe('a');
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'writes only the first of two names this OS sees as one file',
    async () => {
      const report = await restorer().restorer.restore(
        { kind: 'global' },
        [file('rules/Notes.md', 'upper'), file('rules/notes.md', 'lower')],
        answer('overwrite').resolve,
      );
      expect(report.written).toEqual(['rules/Notes.md']);
      expect(report.skipped).toEqual(['rules/notes.md']);
      expect(report.warnings).toEqual([
        'Skipped "rules/notes.md": on this PC it is the same file as "rules/Notes.md".',
      ]);
    },
  );
});

describe('restorer: auto memory folder chosen by project settings (T43)', () => {
  const memory = file('.agentnomad/auto-memory/MEMORY.md', 'remember');

  it.each([
    ['~/.config/autostart', 'a folder whose files run by themselves'],
    ['~/.ssh', 'a folder for keys and logins'],
    ['~/.claude', "inside Claude Code's own folder"],
    ['~/', 'your home folder itself'],
  ])('refuses %s', async (dir, reason) => {
    await put(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: dir }),
    );
    const report = await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(report.skipped).toContain('.agentnomad/auto-memory/MEMORY.md');
    expect(report.warnings.join('\n')).toContain(reason);
    expect(report.written).not.toContain('.agentnomad/auto-memory/MEMORY.md');
  });

  it('refuses a folder outside the home folder', async () => {
    const outside = join(root, 'elsewhere');
    await put(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: outside }),
    );
    const report = await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(report.warnings.join('\n')).toContain('it is outside your home folder');
    await expect(stat(outside)).rejects.toThrow();
  });

  it('uses a folder in the home folder', async () => {
    await put(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: '~/notes/my-app' }),
    );
    await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      [memory],
      answer('skip').resolve,
    );
    expect(await read(join(home, 'notes', 'my-app', 'MEMORY.md'))).toBe('remember');
  });
});

describe('restorer: per-OS fixes', () => {
  it('scripts get LF; .bat and .cmd get CRLF on Windows; other files stay as they are', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const text = (content: Uint8Array) => new TextDecoder().decode(content);
    expect(text(lineEndingsFor('linux', 'a.sh', bytes('a\r\nb\r\n')))).toBe('a\nb\n');
    expect(text(lineEndingsFor('win32', 'a.sh', bytes('a\r\nb\r\n')))).toBe('a\nb\n');
    expect(text(lineEndingsFor('win32', 'a.cmd', bytes('a\nb\n')))).toBe('a\r\nb\r\n');
    expect(text(lineEndingsFor('linux', 'a.cmd', bytes('a\r\nb\r\n')))).toBe('a\r\nb\r\n');
    expect(text(lineEndingsFor('linux', 'CLAUDE.md', bytes('a\r\nb')))).toBe('a\r\nb');
  });

  it.runIf(posix)('makes scripts runnable on macOS and Linux, even from a Windows PC', async () => {
    await restorer().restorer.restore(
      { kind: 'global' },
      [
        file('hooks/a.sh', 'echo a\n', true),
        file('hooks/b.sh', '#!/bin/sh\necho b\n'),
        file('CLAUDE.md', 'x'),
      ],
      answer('skip').resolve,
    );
    expect((await stat(join(base, 'hooks', 'a.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'hooks', 'b.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o111).toBe(0);
  });

  it.runIf(posix)('an overwritten file keeps its own permissions', async () => {
    await put(join(base, 'CLAUDE.md'), 'mine');
    await chmod(join(base, 'CLAUDE.md'), 0o600);
    await restorer().restorer.restore(
      { kind: 'global' },
      [file('CLAUDE.md', 'theirs')],
      answer('overwrite').resolve,
    );
    expect((await stat(join(base, 'CLAUDE.md'))).mode & 0o777).toBe(0o600);
  });

  it('warns about hooks from another OS that will likely not run here', async () => {
    const settings = JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'powershell -File C:/hooks/notify.ps1' }] },
          { hooks: [{ type: 'command', command: '~/.claude/hooks/check.sh' }] },
          { hooks: [{ type: 'command', command: 'node ~/tool.js' }] },
        ],
      },
    });
    const otherOs = posix ? 'win32' : 'linux';
    const report = await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', settings)],
      answer('skip').resolve,
      { sourceOs: otherOs },
    );
    const expected = posix ? 'powershell -File C:/hooks/notify.ps1' : '~/.claude/hooks/check.sh';
    expect(report.warnings).toEqual([
      `This hook or status line came from ${otherOs} and will likely not run here: ${expected}`,
    ]);
    // Nothing to warn about from the same OS.
    const same = await restorer().restorer.restore(
      { kind: 'global' },
      [file('settings.json', settings)],
      answer('skip').resolve,
      { sourceOs: process.platform === 'darwin' ? 'darwin' : posix ? 'linux' : 'win32' },
    );
    expect(same.warnings).toEqual([]);
  });

  it('flags commands by what they run', () => {
    const json = (command: string) => JSON.stringify({ statusLine: { type: 'command', command } });
    expect(hooksForOtherOs(json('pwsh ./x.ps1'), 'linux')).toHaveLength(1);
    expect(hooksForOtherOs(json('bash ~/x.sh'), 'win32')).toHaveLength(1);
    expect(hooksForOtherOs(json('ccstatusline'), 'win32')).toEqual([]);
  });
});

describe('running Claude Code', () => {
  it.each([
    ['claude.exe', true],
    ['/usr/local/bin/claude --resume', true],
    ['/Users/a/.local/bin/claude', true],
    ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', true],
    ['"C:\\Users\\a\\.local\\bin\\claude.exe" --continue', true],
    ['agentnomad pull', false],
    ['claude-helper', false],
    ['/usr/bin/vim claude.md', false],
  ])('%j is Claude Code: %s', (line, expected) => {
    expect(isClaudeProcess(line)).toBe(expected);
  });

  it('is detected from the process list, and a list that cannot be read never blocks', async () => {
    expect(
      await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe', 'claude.exe']))(),
    ).toBe(true);
    expect(await createClaudeRunningCheck(() => Promise.resolve(['explorer.exe']))()).toBe(false);
    expect(await createClaudeRunningCheck(() => Promise.resolve(null))()).toBe(false);
  });
});

describe('restorer: project scripts', () => {
  const settings = (command: string) =>
    file(
      '.claude/settings.json',
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    );

  it('restores a script outside .claude/ only when a project hook runs it', async () => {
    const report = await restorer().restorer.restore(
      { kind: 'project', projectDir: project },
      [
        settings('python scripts/check.py && "$CLAUDE_PROJECT_DIR"/tools/lint.sh'),
        file('scripts/check.py', 'print(1)'),
        file('tools/lint.sh', 'lint'),
        file('src/evil.ts', 'SECRET'),
        file('.claude/hooks/any.sh', 'ok'),
      ],
      answer('skip').resolve,
    );
    expect(report.written).toEqual([
      '.claude/hooks/any.sh',
      '.claude/settings.json',
      'scripts/check.py',
      'tools/lint.sh',
    ]);
    expect(report.skipped).toEqual(['src/evil.ts']);
  });
});

describe('restorer: names Windows cannot write safely (T38)', () => {
  it.each([
    ['skills/a/notes:secret.md', 'a name with ":" cannot be written on Windows'],
    ['skills/CON/SKILL.md', 'a name Windows keeps for devices'],
    ['skills/a/nul.txt', 'a name Windows keeps for devices'],
    ['skills/a/COM1.md', 'a name Windows keeps for devices'],
    ['skills/a/COM¹.md', 'a name Windows keeps for devices'],
    ['skills/lpt³', 'a name Windows keeps for devices'],
    ['.agentnomad/home/SSH~1/run.sh', 'a Windows short name (like PROGRA~1)'],
    ['skills/PROGRA~1/SKILL.md', 'a Windows short name (like PROGRA~1)'],
    ['skills/a/file?.md', 'a name Windows does not allow'],
    ['skills/a/trailing.', 'a name ending in a dot or space on Windows'],
    ['skills/a/space ', 'a name ending in a dot or space on Windows'],
  ])('%s', (path, reason) => {
    expect(windowsNameProblem(path)).toBe(reason);
  });

  it.each(['skills/deploy/SKILL.md', 'skills/a/console.md', 'hooks/check.sh', 'CLAUDE.md'])(
    'allows %s',
    (path) => {
      expect(windowsNameProblem(path)).toBeNull();
    },
  );
});
