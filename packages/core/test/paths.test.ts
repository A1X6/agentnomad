import { describe, expect, it } from 'vitest';

import {
  HOME_PLACEHOLDER,
  PathError,
  createPathResolver,
  type PathEnvironment,
} from '../src/index.ts';

const linux: PathEnvironment = { os: 'linux', homeDir: '/home/ahmed' };
const mac: PathEnvironment = { os: 'darwin', homeDir: '/Users/ahmed' };
const win: PathEnvironment = { os: 'win32', homeDir: 'C:\\Users\\ahmed' };

const onLinux = createPathResolver(linux);
const onMac = createPathResolver(mac);
const onWin = createPathResolver(win);

describe('toNativePath: bundle path to a real path on each OS', () => {
  it.each([
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.claude/skills/review/SKILL.md'],
    [onLinux, '/home/ahmed/.claude/', '/home/ahmed/.claude/skills/review/SKILL.md'],
    [onMac, '/Users/ahmed/.claude', '/Users/ahmed/.claude/skills/review/SKILL.md'],
    [onWin, 'C:\\Users\\ahmed\\.claude', 'C:\\Users\\ahmed\\.claude\\skills\\review\\SKILL.md'],
    [onWin, 'C:/Users/ahmed/.claude/', 'C:\\Users\\ahmed\\.claude\\skills\\review\\SKILL.md'],
  ])('%#: joins under %s', (resolver, baseDir, expected) => {
    expect(resolver.toNativePath(baseDir, 'skills/review/SKILL.md')).toBe(expected);
  });

  it.each(['../outside', 'skills/../../x', '/etc/passwd', 'a\\b', ''])(
    'refuses unsafe bundle path %j on every OS',
    (path) => {
      for (const resolver of [onLinux, onMac, onWin]) {
        expect(() => resolver.toNativePath('/base', path)).toThrow(PathError);
      }
    },
  );

  // Legal on Linux and macOS, but Windows cannot create these (or treats them specially).
  it.each([
    'CON',
    'nul.txt',
    'skills/com1.md',
    'lpt9',
    'notes:v2.md',
    'what?.md',
    'star*.md',
    'pipe|x',
    'quote".md',
    'less<.md',
    'trailing.',
    'trailing ',
    // Microsoft's naming rules also reserve the superscript forms (T43).
    'COM¹.md',
    'skills/lpt³',
    // 8.3 short names reach a folder under another name (T43).
    'PROGRA~1/x.md',
    'SSH~1',
  ])('refuses %j on Windows only', (path) => {
    expect(() => onWin.toNativePath('C:\\base', path)).toThrow(/Windows/);
    expect(onLinux.toNativePath('/base', path)).toBe(`/base/${path}`);
  });

  it('allows names that only look reserved on Windows', () => {
    expect(onWin.toNativePath('C:\\b', 'console.md')).toBe('C:\\b\\console.md');
    expect(onWin.toNativePath('C:\\b', 'com10.md')).toBe('C:\\b\\com10.md');
  });
});

describe('toBundlePath: real path back to a bundle path', () => {
  it.each([
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.claude/skills/a.md'],
    [onMac, '/Users/ahmed/.claude/', '/Users/ahmed/.claude/skills/a.md'],
    [onWin, 'C:\\Users\\ahmed\\.claude', 'C:\\Users\\ahmed\\.claude\\skills\\a.md'],
    [onWin, 'C:\\Users\\ahmed\\.claude', 'c:\\users\\AHMED\\.claude\\skills\\a.md'],
    [onWin, 'C:/Users/ahmed/.claude', 'C:\\Users\\ahmed\\.claude/skills\\a.md'],
  ])('%#: under %s', (resolver, baseDir, nativePath) => {
    expect(resolver.toBundlePath(baseDir, nativePath)).toBe('skills/a.md');
  });

  it.each([
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.claudeX/a.md'],
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/other/a.md'],
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.claude'],
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.CLAUDE/a.md'],
    [onLinux, '/home/ahmed/.claude', '/home/ahmed/.claude/../x.md'],
    [onWin, 'C:\\Users\\ahmed\\.claude', 'D:\\Users\\ahmed\\.claude\\a.md'],
  ])('%#: refuses a path outside %s', (resolver, baseDir, nativePath) => {
    expect(() => resolver.toBundlePath(baseDir, nativePath)).toThrow(PathError);
  });

  it('round-trips with toNativePath on every OS', () => {
    const cases: [ReturnType<typeof createPathResolver>, string][] = [
      [onLinux, '/home/ahmed/.claude'],
      [onMac, '/Users/ahmed/.claude'],
      [onWin, 'C:\\Users\\ahmed\\.claude'],
    ];
    for (const [resolver, base] of cases) {
      const native = resolver.toNativePath(base, 'agents/team/reviewer.md');
      expect(resolver.toBundlePath(base, native)).toBe('agents/team/reviewer.md');
    }
  });
});

describe('toPortableText: home folder to {{HOME}} (on push)', () => {
  it('uses {{HOME}} as the placeholder', () => {
    expect(HOME_PLACEHOLDER).toBe('{{HOME}}');
  });

  it.each([
    [onLinux, '"command": "/home/ahmed/.claude/hook.sh"', '"command": "{{HOME}}/.claude/hook.sh"'],
    [onMac, 'bash /Users/ahmed/.claude/statusline.sh', 'bash {{HOME}}/.claude/statusline.sh'],
    [onLinux, 'cd /home/ahmed', 'cd {{HOME}}'],
    [onLinux, '/home/ahmed/a and /home/ahmed/b', '{{HOME}}/a and {{HOME}}/b'],
  ])('%#: macOS and Linux', (resolver, text, expected) => {
    expect(resolver.toPortableText(text)).toBe(expected);
  });

  it.each(['/home/ahmed2/x', '/home/ahmed.old/x', '/home/ahmed-backup', '/home/Ahmed/x'])(
    'leaves a look-alike folder %j alone',
    (text) => {
      expect(onLinux.toPortableText(text)).toBe(text);
    },
  );

  it.each([
    [
      'plain',
      'powershell C:\\Users\\ahmed\\.claude\\hook.ps1',
      'powershell {{HOME}}/.claude/hook.ps1',
    ],
    [
      'escaped in JSON',
      '{"command":"C:\\\\Users\\\\ahmed\\\\.claude\\\\hook.ps1"}',
      '{"command":"{{HOME}}/.claude/hook.ps1"}',
    ],
    ['forward slashes', 'node C:/Users/ahmed/.claude/x.js', 'node {{HOME}}/.claude/x.js'],
    ['different case', 'c:\\users\\AHMED\\.claude', '{{HOME}}/.claude'],
    ['home alone', 'cd C:\\Users\\ahmed', 'cd {{HOME}}'],
  ])('Windows, %s', (_, text, expected) => {
    expect(onWin.toPortableText(text)).toBe(expected);
  });

  it('keeps JSON escapes that follow a Windows path', () => {
    const json = '{"a":"C:\\\\Users\\\\ahmed\\\\x","b":"line\\nbreak"}';
    expect(onWin.toPortableText(json)).toBe('{"a":"{{HOME}}/x","b":"line\\nbreak"}');
  });

  it('leaves text without the home folder unchanged', () => {
    expect(onWin.toPortableText('~/.claude and D:\\data')).toBe('~/.claude and D:\\data');
  });
});

describe('fromPortableText: {{HOME}} to this home folder (on pull)', () => {
  it.each([
    [onLinux, '/home/ahmed/.claude/hook.sh'],
    [onMac, '/Users/ahmed/.claude/hook.sh'],
    [onWin, 'C:/Users/ahmed/.claude/hook.sh'],
  ])('%#: restores the home folder', (resolver, expected) => {
    expect(resolver.fromPortableText('{{HOME}}/.claude/hook.sh')).toBe(expected);
  });

  it('keeps JSON valid on Windows (forward slashes need no escaping)', () => {
    const restored = onWin.fromPortableText('{"command":"{{HOME}}/.claude/hook.ps1"}');
    expect(JSON.parse(restored)).toEqual({ command: 'C:/Users/ahmed/.claude/hook.ps1' });
  });
});

describe('a {{HOME}} already in a file survives push and pull (T45)', () => {
  it.each([
    ['a template', 'Hello {{HOME}} and {{HOME}}/docs'],
    ['a kept form', 'literal {{HOME\\}} and {{HOME\\\\}}'],
  ])('%s', (_, text) => {
    for (const from of [onLinux, onMac, onWin]) {
      for (const to of [onLinux, onMac, onWin]) {
        expect(to.fromPortableText(from.toPortableText(text))).toBe(text);
      }
    }
  });

  it('still swaps the real home folder next to a literal one', () => {
    const text = 'see {{HOME}} in /home/ahmed/notes.md';
    expect(onMac.fromPortableText(onLinux.toPortableText(text))).toBe(
      'see {{HOME}} in /Users/ahmed/notes.md',
    );
  });
});

describe('batch files keep backslashes on Windows (T45)', () => {
  it('restores the home folder and the path after it with backslashes', () => {
    expect(onWin.fromPortableText('dir {{HOME}}/bin/tools', { backslashes: true })).toBe(
      'dir C:\\Users\\ahmed\\bin\\tools',
    );
  });

  it('other files and other OSes keep forward slashes', () => {
    expect(onWin.fromPortableText('{{HOME}}/bin')).toBe('C:/Users/ahmed/bin');
    expect(onLinux.fromPortableText('{{HOME}}/bin', { backslashes: true })).toBe('/home/ahmed/bin');
  });
});

describe('every OS to every OS (push on one, pull on another)', () => {
  // How each OS writes the hook path natively, and how it should read after a pull there.
  const machines = [
    {
      name: 'Linux',
      resolver: onLinux,
      native: '/home/ahmed/.claude/hook.sh',
      restored: '/home/ahmed/.claude/hook.sh',
    },
    {
      name: 'macOS',
      resolver: onMac,
      native: '/Users/ahmed/.claude/hook.sh',
      restored: '/Users/ahmed/.claude/hook.sh',
    },
    {
      name: 'Windows',
      resolver: onWin,
      native: 'C:\\Users\\ahmed\\.claude\\hook.sh',
      restored: 'C:/Users/ahmed/.claude/hook.sh',
    },
  ];
  const pairs = machines.flatMap((from) =>
    machines.map((to) => [from.name, to.name, from, to] as const),
  );

  it.each(pairs)('%s to %s: plain text', (_, __, from, to) => {
    const pushed = from.resolver.toPortableText(`bash ${from.native}`);
    expect(pushed).toBe('bash {{HOME}}/.claude/hook.sh');
    expect(to.resolver.fromPortableText(pushed)).toBe(`bash ${to.restored}`);
  });

  it.each(pairs)('%s to %s: inside a JSON settings file', (_, __, from, to) => {
    const settings = JSON.stringify({ hooks: { command: from.native } });
    const pulled = to.resolver.fromPortableText(from.resolver.toPortableText(settings));
    expect(JSON.parse(pulled)).toEqual({ hooks: { command: to.restored } });
  });
});

describe('environment checks', () => {
  // A home of "/" would make every "/" in every file look like the home folder.
  it.each<PathEnvironment>([
    { os: 'linux', homeDir: '/' },
    // Normalises to nothing, which would match between every two characters (T45).
    { os: 'linux', homeDir: '//' },
    { os: 'darwin', homeDir: '' },
    { os: 'linux', homeDir: 'home/ahmed' },
    { os: 'win32', homeDir: 'C:\\' },
    { os: 'win32', homeDir: '\\Users\\ahmed' },
  ])('refuses home folder %j', (environment) => {
    expect(() => createPathResolver(environment)).toThrow(PathError);
  });
});
