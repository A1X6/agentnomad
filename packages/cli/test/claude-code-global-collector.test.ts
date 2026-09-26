import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ClaudeJsonError,
  commandsInSettings,
  createProgramLocator,
  programOf,
  type DetectorSystem,
  type ProgramInfo,
  createClaudeCodeGlobalCollector,
  type CollectedFile,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
let home: string;
let base: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentnomad-home-'));
  base = join(home, '.claude');
  await mkdir(base);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function collector(customConfigDir = false, baseDir = base) {
  return createClaudeCodeGlobalCollector({
    baseDir,
    homedir: home,
    platform: process.platform,
    customConfigDir,
  });
}

async function collect(includeMemory = false): Promise<readonly CollectedFile[]> {
  return collector().collect({ kind: 'global' }, { includeMemory });
}
const paths = (files: readonly CollectedFile[]) => files.map((file) => file.path);
const text = (files: readonly CollectedFile[], path: string) =>
  new TextDecoder().decode(files.find((file) => file.path === path)?.content);

/** A ~/.claude with every kind of file a real one has. */
async function realisticSetup(): Promise<void> {
  for (const file of ['settings.json', 'CLAUDE.md', 'keybindings.json'])
    await put(join(base, file));
  await put(join(base, 'rules', 'style.md'));
  await put(join(base, 'skills', 'deploy', 'SKILL.md'));
  await put(join(base, 'skills', 'deploy', 'scripts', 'run.sh'));
  await put(join(base, 'commands', 'review.md'));
  await put(join(base, 'agents', 'reviewer.md'));
  await put(join(base, 'workflows', 'ship.md'));
  await put(join(base, 'output-styles', 'terse.md'));
  await put(join(base, 'themes', 'dark.json'));
  // Never synced:
  await put(join(base, '.credentials.json'), '{"token":"SECRET"}');
  await put(join(base, 'history.jsonl'), 'SECRET prompt');
  await put(join(base, 'projects', 'C--work-app', 'abc.jsonl'), 'SECRET transcript');
  await put(join(base, 'projects', 'C--work-app', 'memory', 'MEMORY.md'));
  for (const dir of [
    'file-history',
    'plans',
    'debug',
    'cache',
    'backups',
    'sessions',
    'jobs',
    'daemon',
    'todos',
    'shell-snapshots',
    'plugins',
    '.trash',
  ]) {
    await put(join(base, dir, 'state.json'));
  }
  await put(join(base, 'settings.local.json'));
  await put(join(base, 'skills', 'synced', 'from-claude-ai', 'SKILL.md'));
  await put(join(base, 'unknown-new-thing.json'));
  // Clutter inside a synced folder:
  await put(join(base, 'skills', 'deploy', '.git', 'HEAD'));
  await put(join(base, 'skills', 'deploy', 'node_modules', 'x', 'index.js'));
  await put(join(base, 'skills', 'deploy', '.DS_Store'));
  await put(join(base, 'rules', 'style.md.agentnomad-backup-20260925T120000Z'));
  await put(join(base, 'rules', 'style.md.agentnomad-incoming-20260925T120000Z'));
  // Opt-in memory:
  await put(join(base, 'agent-memory', 'reviewer', 'MEMORY.md'));
}

describe('global collector: what is taken', () => {
  it('takes the synced files and folders, nothing else', async () => {
    await realisticSetup();
    expect(paths(await collect())).toEqual([
      'CLAUDE.md',
      'agents/reviewer.md',
      'commands/review.md',
      'keybindings.json',
      'output-styles/terse.md',
      'rules/style.md',
      'settings.json',
      'skills/deploy/SKILL.md',
      'skills/deploy/scripts/run.sh',
      'themes/dark.json',
      'workflows/ship.md',
    ]);
  });

  it('never takes credentials, history, transcripts or other state', async () => {
    await realisticSetup();
    const files = await collect(true);
    const all = files.map((file) => new TextDecoder().decode(file.content)).join('\n');
    expect(all).not.toContain('SECRET');
    for (const path of paths(files)) {
      expect(path).not.toMatch(
        /^(\.credentials\.json|history\.jsonl|projects|file-history|plans|debug|cache|backups|sessions|jobs|daemon|todos|shell-snapshots|plugins|\.trash|settings\.local\.json)(\/|$)/,
      );
    }
  });

  it('never takes skills/synced/, even through a link or a hook', async () => {
    await put(join(base, 'skills', 'synced', 'a', 'SKILL.md'));
    await put(join(base, 'skills', 'synced', 'a', 'helper.sh'));
    await put(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `bash ${join(base, 'skills', 'synced', 'a', 'helper.sh')}`,
                },
              ],
            },
          ],
        },
      }),
    );
    const files = paths(await collect(true));
    expect(files.some((path) => path.startsWith('skills/synced'))).toBe(false);
  });

  it('skips .git, node_modules, OS clutter and agentnomad backup copies', async () => {
    await realisticSetup();
    const files = paths(await collect());
    expect(
      files.filter((path) => /\.git\/|node_modules|\.DS_Store|agentnomad-/.test(path)),
    ).toEqual([]);
  });

  it('takes subagent memory only when asked', async () => {
    await realisticSetup();
    expect(paths(await collect(false))).not.toContain('agent-memory/reviewer/MEMORY.md');
    expect(paths(await collect(true))).toContain('agent-memory/reviewer/MEMORY.md');
  });

  it('keeps the bytes and marks executable scripts on macOS and Linux', async () => {
    await put(join(base, 'skills', 's', 'run.sh'), '#!/bin/sh\necho hi\n');
    if (posix) await chmod(join(base, 'skills', 's', 'run.sh'), 0o755);
    const files = await collect();
    expect(text(files, 'skills/s/run.sh')).toBe('#!/bin/sh\necho hi\n');
    expect(files[0]?.executable).toBe(posix);
  });

  it('returns nothing for an empty folder', async () => {
    expect(await collect()).toEqual([]);
  });

  it('refuses the project scope (T26)', async () => {
    await expect(
      collector().collect({ kind: 'project', projectDir: home }, { includeMemory: false }),
    ).rejects.toThrow('global');
  });
});

describe('global collector: ~/.claude.json', () => {
  const claudeJson = {
    mcpServers: { github: { command: 'npx', args: ['gh-mcp'], env: { TOKEN: '${GITHUB_TOKEN}' } } },
    diffTool: 'terminal',
    autoConnectIde: true,
    oauthAccount: { emailAddress: 'SECRET@example.com' },
    userID: 'SECRET-user',
    machineID: 'SECRET-machine',
    projects: { '/home/a/app': { allowedTools: [], hasTrustDialogAccepted: true } },
    numStartups: 108,
    cachedGrowthBookFeatures: { x: 1 },
  };

  it('keeps only MCP servers and preference keys', async () => {
    await put(join(home, '.claude.json'), JSON.stringify(claudeJson));
    const files = await collect();
    expect(JSON.parse(text(files, '.agentnomad/claude.json'))).toEqual({
      mcpServers: claudeJson.mcpServers,
      diffTool: 'terminal',
      autoConnectIde: true,
    });
    expect(text(files, '.agentnomad/claude.json')).not.toContain('SECRET');
  });

  it('adds nothing when there are no servers or preferences', async () => {
    await put(join(home, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: {} }));
    expect(await collect()).toEqual([]);
  });

  it('reads it from CLAUDE_CONFIG_DIR when that is set', async () => {
    const custom = join(home, 'work-claude');
    await put(join(custom, '.claude.json'), JSON.stringify({ diffTool: 'auto' }));
    await put(join(home, '.claude.json'), JSON.stringify({ diffTool: 'terminal' }));
    const files = await collector(true, custom).collect(
      { kind: 'global' },
      { includeMemory: false },
    );
    expect(JSON.parse(text(files, '.agentnomad/claude.json'))).toEqual({ diffTool: 'auto' });
  });

  it('stops with a clear message when the file is half-written', async () => {
    await put(join(home, '.claude.json'), '{"mcpServers": {');
    await expect(collect()).rejects.toBeInstanceOf(ClaudeJsonError);
  });
});

describe('global collector: hook and status line scripts', () => {
  async function withSettings(settings: object): Promise<readonly CollectedFile[]> {
    await put(join(base, 'settings.json'), JSON.stringify(settings));
    return collect();
  }
  const hook = (command: string) => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
  });

  it('takes a script inside ~/.claude by its path there', async () => {
    await put(join(base, 'hooks', 'check.sh'), 'echo check');
    const files = await withSettings(hook(`bash "${join(base, 'hooks', 'check.sh')}"`));
    expect(text(files, 'hooks/check.sh')).toBe('echo check');
  });

  it('takes a script elsewhere in home under .agentnomad/home/', async () => {
    await put(join(home, 'scripts', 'status.py'), 'print(1)');
    const files = await withSettings({
      statusLine: { type: 'command', command: `python3 ${join(home, 'scripts', 'status.py')}` },
    });
    expect(text(files, '.agentnomad/home/scripts/status.py')).toBe('print(1)');
  });

  it('understands ~ and $HOME in commands', async () => {
    await put(join(home, 'bin', 'a.sh'));
    await put(join(home, 'bin', 'b.sh'));
    const files = paths(
      await withSettings({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: '~/bin/a.sh' },
                { type: 'command', command: '$HOME/bin/b.sh --fast' },
              ],
            },
          ],
        },
      }),
    );
    expect(files).toEqual(
      expect.arrayContaining(['.agentnomad/home/bin/a.sh', '.agentnomad/home/bin/b.sh']),
    );
  });

  it('never takes keys or logins a command mentions', async () => {
    await put(join(home, '.ssh', 'deploy.sh'), 'SECRET');
    await put(join(home, '.ssh', 'id_ed25519'), 'SECRET');
    await put(join(home, '.aws', 'login.py'), 'SECRET');
    const files = await withSettings(
      hook(`ssh -i ~/.ssh/id_ed25519 host && ~/.ssh/deploy.sh && python ~/.aws/login.py`),
    );
    expect(paths(files)).toEqual(['settings.json']);
  });

  it('ignores programs on PATH, missing files and files outside home', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'agentnomad-outside-'));
    try {
      await put(join(outside, 'tool.sh'));
      const files = await withSettings({
        statusLine: { type: 'command', command: 'ccstatusline' },
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `~/missing.sh; ${join(outside, 'tool.sh')}` }] },
          ],
        },
      });
      expect(paths(files)).toEqual(['settings.json']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reads commands from every hook event and the status line', () => {
    expect(
      commandsInSettings(
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }],
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'b' },
                  { type: 'prompt', prompt: 'x' },
                ],
              },
            ],
          },
          statusLine: { type: 'command', command: 'c' },
        }),
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(commandsInSettings('not json')).toEqual([]);
  });
});

describe.runIf(posix)('global collector: links', () => {
  it('follows a linked skills folder once and survives a link loop', async () => {
    const dotfiles = join(home, 'dotfiles', 'my-skill');
    await put(join(dotfiles, 'SKILL.md'), 'linked');
    await mkdir(join(base, 'skills'));
    await symlink(dotfiles, join(base, 'skills', 'my-skill'));
    await symlink(join(base, 'skills'), join(base, 'skills', 'loop'));
    const files = await collect();
    expect(text(files, 'skills/my-skill/SKILL.md')).toBe('linked');
    expect(paths(files).some((path) => path.includes('loop/loop'))).toBe(false);
  });
});

describe('global collector: a link into a folder for keys (T45)', () => {
  it('is never followed, and push is told why', async () => {
    await put(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(join(base, 'skills'), { recursive: true });
    await symlink(
      join(home, '.ssh'),
      join(base, 'skills', 'keys'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const skipped: string[] = [];
    const files = await collector().collect(
      { kind: 'global' },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(files).some((path) => path.startsWith('skills/keys'))).toBe(false);
    expect(skipped).toEqual(['skills/keys: it links into a folder for keys and logins']);
  });
});

describe('global collector: programs the status line and hooks need', () => {
  const statusLine = (command: string) =>
    put(join(base, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));
  const npmInfo = (command: string) =>
    Promise.resolve({ command, npm: { package: command, version: '2.2.22' } });

  function collectWith(findProgram?: (command: string) => Promise<ProgramInfo | null>) {
    return createClaudeCodeGlobalCollector({
      baseDir: base,
      homedir: home,
      platform: process.platform,
      customConfigDir: false,
      ...(findProgram && { findProgram }),
    }).collect({ kind: 'global' }, { includeMemory: false });
  }

  it('takes ccstatusline settings and records the npm package and version', async () => {
    await statusLine('ccstatusline');
    await put(join(home, '.config', 'ccstatusline', 'settings.json'), '{"lines":[]}');
    const files = await collectWith(npmInfo);
    expect(text(files, '.agentnomad/home/.config/ccstatusline/settings.json')).toBe('{"lines":[]}');
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [{ command: 'ccstatusline', npm: { package: 'ccstatusline', version: '2.2.22' } }],
    });
  });

  it('npx needs no install record, but the tool settings still come along', async () => {
    await statusLine('npx -y ccstatusline@latest');
    await put(join(home, '.config', 'ccstatusline', 'settings.json'), '{}');
    const files = paths(await collectWith(npmInfo));
    expect(files).toContain('.agentnomad/home/.config/ccstatusline/settings.json');
    expect(files).not.toContain('.agentnomad/programs.json');
  });

  it('records a program that is not from npm without install details', async () => {
    await put(
      join(base, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'terminal-notifier -message done' }] }],
        },
      }),
    );
    const files = await collectWith((command) => Promise.resolve({ command, npm: null }));
    expect(JSON.parse(text(files, '.agentnomad/programs.json'))).toEqual({
      programs: [{ command: 'terminal-notifier', npm: null }],
    });
  });

  it.each([
    ['ccstatusline', { name: 'ccstatusline', runner: false }],
    ['npx -y ccstatusline@latest', { name: 'ccstatusline', runner: true }],
    ['bunx @scope/tool@1.2.3 --flag', { name: '@scope/tool', runner: true }],
    ['FOO=1 my-tool --x', { name: 'my-tool', runner: false }],
    ['ccstatusline.cmd', { name: 'ccstatusline', runner: false }],
    ['bash ~/x.sh', null],
    ['~/bin/x.sh', null],
    ['node script.js', null],
    ['echo done', null],
    ['printf hi', null],
  ])('reads the program of %j', (command, expected) => {
    expect(programOf(command)).toEqual(expected);
  });
});

describe('program locator', () => {
  const system = (pc: {
    platform: NodeJS.Platform;
    path: string;
    executables: string[];
    files: Record<string, string>;
  }): DetectorSystem => ({
    platform: pc.platform,
    homedir: pc.platform === 'win32' ? 'C:\\Users\\a' : '/home/a',
    env: { PATH: pc.path, PATHEXT: '.EXE;.CMD' },
    isDirectory: () => Promise.resolve(false),
    isExecutable: (path) => Promise.resolve(pc.executables.includes(path)),
    readText: (path) => Promise.resolve(pc.files[path] ?? null),
    runVersion: () => Promise.resolve(null),
  });
  const manifest = JSON.stringify({
    name: 'ccstatusline',
    version: '2.2.22',
    bin: { ccstatusline: 'dist/cli.js' },
  });

  it('finds a global npm package on Windows (prefix/node_modules)', async () => {
    const find = createProgramLocator(
      system({
        platform: 'win32',
        path: 'C:\\nvm4w\\nodejs',
        executables: ['C:\\nvm4w\\nodejs\\ccstatusline.cmd'],
        files: { 'C:\\nvm4w\\nodejs\\node_modules\\ccstatusline\\package.json': manifest },
      }),
    );
    expect(await find('ccstatusline')).toEqual({
      command: 'ccstatusline',
      npm: { package: 'ccstatusline', version: '2.2.22' },
    });
  });

  it('finds a global npm package on macOS and Linux (prefix/lib/node_modules)', async () => {
    const find = createProgramLocator(
      system({
        platform: 'linux',
        path: '/usr/local/bin',
        executables: ['/usr/local/bin/ccstatusline'],
        files: { '/usr/local/lib/node_modules/ccstatusline/package.json': manifest },
      }),
    );
    expect((await find('ccstatusline'))?.npm?.version).toBe('2.2.22');
  });

  it('a program from elsewhere has no npm details; a missing one is null', async () => {
    const find = createProgramLocator(
      system({
        platform: 'linux',
        path: '/usr/bin',
        executables: ['/usr/bin/jq'],
        files: {},
      }),
    );
    expect(await find('jq')).toEqual({ command: 'jq', npm: null });
    expect(await find('nope')).toBeNull();
  });
});
