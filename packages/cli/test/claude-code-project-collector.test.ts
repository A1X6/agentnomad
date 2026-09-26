import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandWords,
  createClaudeCodeProjectCollector,
  findAutoMemory,
  projectDirName,
  repositoryRoot,
  type CollectedFile,
} from '../src/index.ts';

let root: string;
let home: string;
let base: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentnomad-project-'));
  home = join(root, 'home');
  base = join(home, '.claude');
  project = join(root, 'work', 'my-app');
  await mkdir(base, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const options = (env: Record<string, string> = {}) => ({
  baseDir: base,
  homedir: home,
  platform: process.platform,
  env,
});

function collect(includeMemory = false, env: Record<string, string> = {}, dir = project) {
  return createClaudeCodeProjectCollector(options(env)).collect(
    { kind: 'project', projectDir: dir },
    { includeMemory },
  );
}
const paths = (files: readonly CollectedFile[]) => files.map((file) => file.path);
const text = (files: readonly CollectedFile[], path: string) =>
  new TextDecoder().decode(files.find((file) => file.path === path)?.content);

/** The folder Claude Code keeps this project's auto memory in. */
const memoryDir = (repo = project) => join(base, 'projects', projectDirName(repo), 'memory');

async function realisticProject(): Promise<void> {
  for (const file of [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    '.mcp.json',
    '.worktreeinclude',
  ]) {
    await put(join(project, file));
  }
  for (const file of ['settings.json', 'settings.local.json', 'CLAUDE.md']) {
    await put(join(project, '.claude', file));
  }
  for (const dir of ['rules', 'skills/test', 'commands', 'agents', 'workflows', 'output-styles']) {
    await put(join(project, '.claude', dir, 'a.md'));
  }
  // Never taken:
  await put(join(project, 'src', 'index.ts'), 'SECRET app code');
  await put(join(project, '.env'), 'SECRET=1');
  await put(join(project, '.git', 'config'));
  await put(join(project, '.claude', 'agent-memory-local', 'r', 'MEMORY.md'), 'SECRET local');
  await put(join(project, '.claude', 'worktrees', 'wt', 'CLAUDE.md'), 'SECRET worktree');
  await put(join(project, '.claude', 'skills', 'test', 'node_modules', 'x.js'));
  await put(join(project, '.claude', 'rules', 'a.md.agentnomad-backup-20260925T120000Z'));
  await put(join(project, '.claude', 'unknown.json'));
  // Opt-in:
  await put(join(project, '.claude', 'agent-memory', 'reviewer', 'MEMORY.md'));
  await put(join(memoryDir(), 'MEMORY.md'), '- [Role](user_role.md)');
  await put(join(memoryDir(), 'user_role.md'), 'backend dev');
}

describe('project collector: what is taken', () => {
  it('takes the root files and the .claude allowlist, nothing else', async () => {
    await realisticProject();
    expect(paths(await collect())).toEqual([
      '.claude/CLAUDE.md',
      '.claude/agents/a.md',
      '.claude/commands/a.md',
      '.claude/output-styles/a.md',
      '.claude/rules/a.md',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/skills/test/a.md',
      '.claude/workflows/a.md',
      '.mcp.json',
      '.worktreeinclude',
      'AGENTS.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
    ]);
  });

  it('never takes app code, .env, .git, local agent memory or worktrees', async () => {
    await realisticProject();
    const files = await collect(true);
    const all = files.map((file) => new TextDecoder().decode(file.content)).join('\n');
    expect(all).not.toContain('SECRET');
  });

  it('takes subagent memory and auto memory only when asked', async () => {
    await realisticProject();
    expect(paths(await collect(false)).filter((path) => path.includes('memory'))).toEqual([]);
    const files = await collect(true);
    expect(paths(files).filter((path) => path.includes('memory'))).toEqual([
      '.agentnomad/auto-memory/MEMORY.md',
      '.agentnomad/auto-memory/user_role.md',
      '.claude/agent-memory/reviewer/MEMORY.md',
    ]);
    expect(text(files, '.agentnomad/auto-memory/user_role.md')).toBe('backend dev');
  });

  it('takes scripts the project hooks run, when they are inside the project', async () => {
    await put(join(project, '.claude', 'hooks', 'lint.sh'), 'npm run lint');
    await put(join(project, 'scripts', 'check.py'), 'print(1)');
    await put(join(project, '.env.sh'), 'SECRET');
    await put(join(root, 'outside.sh'));
    await put(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/lint.sh' },
                { type: 'command', command: 'python scripts/check.py' },
                { type: 'command', command: `bash ${join(root, 'outside.sh')}` },
                { type: 'command', command: 'bash ../outside.sh' },
              ],
            },
          ],
        },
      }),
    );
    const files = await collect();
    expect(paths(files)).toEqual([
      '.claude/hooks/lint.sh',
      '.claude/settings.json',
      'scripts/check.py',
    ]);
    expect(text(files, '.claude/hooks/lint.sh')).toBe('npm run lint');
  });

  it('returns nothing for a folder without a Claude Code setup', async () => {
    await put(join(project, 'README.md'));
    expect(await collect(true)).toEqual([]);
  });

  it('refuses the global scope', async () => {
    await expect(
      createClaudeCodeProjectCollector(options()).collect(
        { kind: 'global' },
        { includeMemory: false },
      ),
    ).rejects.toThrow('project');
  });
});

describe('project collector: links and size (T45)', () => {
  /** A folder link; a junction on Windows, which needs no admin rights. */
  const linkFolder = (target: string, path: string) =>
    symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

  it('never follows a link into a folder for keys, and says so', async () => {
    await put(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(join(home, '.ssh'), join(project, '.claude', 'skills', 'x'));
    const skipped: string[] = [];
    const found = await createClaudeCodeProjectCollector(options()).collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(found).filter((path) => path.includes('skills'))).toEqual([]);
    expect(skipped).toEqual(['.claude/skills/x: it links to a place outside the project']);
  });

  it('never follows a link out of the project', async () => {
    await put(join(root, 'elsewhere', 'SKILL.md'), 'not this project');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(join(root, 'elsewhere'), join(project, '.claude', 'skills', 'x'));
    expect(paths(await collect()).filter((path) => path.includes('skills'))).toEqual([]);
  });

  it('follows a link that stays inside the project', async () => {
    await put(join(project, 'shared', 'review', 'SKILL.md'), 'review');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await linkFolder(
      join(project, 'shared', 'review'),
      join(project, '.claude', 'skills', 'review'),
    );
    expect(text(await collect(), '.claude/skills/review/SKILL.md')).toBe('review');
  });

  it('leaves out a file larger than 10 MB', async () => {
    await put(
      join(project, '.claude', 'skills', 'big', 'data.bin'),
      'x'.repeat(10 * 1024 * 1024 + 1),
    );
    await put(join(project, '.claude', 'skills', 'big', 'SKILL.md'), 'small');
    const skipped: string[] = [];
    const found = await createClaudeCodeProjectCollector(options()).collect(
      { kind: 'project', projectDir: project },
      { includeMemory: false, onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`) },
    );
    expect(paths(found)).toContain('.claude/skills/big/SKILL.md');
    expect(skipped).toEqual(['.claude/skills/big/data.bin: it is larger than 10 MB']);
  });
});

describe('auto memory location', () => {
  it('names the folder like Claude Code: every non-letter or digit becomes -', () => {
    expect(projectDirName('E:\\Projects\\agent-nomad')).toBe('E--Projects-agent-nomad');
    expect(projectDirName('/home/ahmed/my_app.v2')).toBe('-home-ahmed-my-app-v2');
  });

  it('uses the repository root, so subfolders share one memory', async () => {
    await mkdir(join(project, '.git'));
    const sub = join(project, 'packages', 'api');
    await mkdir(sub, { recursive: true });
    expect(await repositoryRoot(sub, process.platform)).toBe(resolve(project));
    expect(await findAutoMemory({ ...options(), projectDir: sub })).toEqual({
      kind: 'folder',
      dir: memoryDir(),
    });
  });

  it('uses the main repository for a git worktree', async () => {
    await mkdir(join(project, '.git', 'worktrees', 'feature'), { recursive: true });
    await writeFile(join(project, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const worktree = join(root, 'work', 'my-app-feature');
    await put(join(worktree, '.git'), `gitdir: ${join(project, '.git', 'worktrees', 'feature')}\n`);
    expect(await repositoryRoot(worktree, process.platform)).toBe(resolve(project));
  });

  it('uses the project folder outside git', async () => {
    expect(await repositoryRoot(project, process.platform)).toBe(resolve(project));
  });

  it('honours autoMemoryDirectory from the project settings', async () => {
    await put(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: '~/notes/my-app-memory' }),
    );
    await put(join(home, 'notes', 'my-app-memory', 'MEMORY.md'), 'custom');
    expect(await findAutoMemory({ ...options(), projectDir: project })).toEqual({
      kind: 'folder',
      dir: join(home, 'notes', 'my-app-memory'),
    });
    expect(text(await collect(true), '.agentnomad/auto-memory/MEMORY.md')).toBe('custom');
  });

  it('takes only Markdown files from auto memory (T43)', async () => {
    await put(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ autoMemoryDirectory: '~/notes/my-app-memory' }),
    );
    await put(join(home, 'notes', 'my-app-memory', 'MEMORY.md'), 'notes');
    await put(join(home, 'notes', 'my-app-memory', 'run.sh'), 'echo hi');
    expect(paths(await collect(true)).filter((path) => path.includes('auto-memory'))).toEqual([
      '.agentnomad/auto-memory/MEMORY.md',
    ]);
  });

  it('never reads a memory folder that is a folder for keys (T43)', async () => {
    await put(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryDirectory: '~/.ssh' }),
    );
    await put(join(home, '.ssh', 'notes.md'), 'secret');
    expect(await findAutoMemory({ ...options(), projectDir: project })).toEqual({
      kind: 'refused',
      dir: join(home, '.ssh'),
      reason: 'it is a folder for keys and logins',
    });
    expect(paths(await collect(true))).toEqual(['.claude/settings.json']);
  });

  it('skips a memory folder set in user settings, since every project shares it', async () => {
    await put(join(base, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/all-memory' }));
    await put(join(home, 'all-memory', 'MEMORY.md'), 'shared');
    expect((await findAutoMemory({ ...options(), projectDir: project })).kind).toBe('shared');
    expect(paths(await collect(true))).toEqual([]);
  });

  it('honours CLAUDE_CODE_PROJECT_DIR_NAME beside CLAUDE_CONFIG_DIR', async () => {
    const env = { CLAUDE_CONFIG_DIR: base, CLAUDE_CODE_PROJECT_DIR_NAME: 'work' };
    expect(await findAutoMemory({ ...options(env), projectDir: project })).toEqual({
      kind: 'folder',
      dir: join(base, 'projects', 'work', 'memory'),
    });
  });

  it('finds the hashed folder of a very long path, or reports it unknown', async () => {
    const long = join(root, 'x'.repeat(220));
    await mkdir(long, { recursive: true });
    const cut = projectDirName(resolve(long)).slice(0, 200);
    expect((await findAutoMemory({ ...options(), projectDir: long })).kind).toBe('unknown');
    await mkdir(join(base, 'projects', `${cut}-a1b2c3`), { recursive: true });
    expect(await findAutoMemory({ ...options(), projectDir: long })).toEqual({
      kind: 'folder',
      dir: join(base, 'projects', `${cut}-a1b2c3`, 'memory'),
    });
  });
});

describe('command words', () => {
  it.each([
    [
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/a.sh --x',
      ['$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh', '--x'],
    ],
    ["bash 'my scripts/a.sh'", ['bash', 'my scripts/a.sh']],
    ['node "C:\\Program Files\\x.js"', ['node', 'C:\\Program Files\\x.js']],
    ['a  b', ['a', 'b']],
  ])('splits %j like a shell', (command, words) => {
    expect(commandWords(command)).toEqual(words);
  });
});
