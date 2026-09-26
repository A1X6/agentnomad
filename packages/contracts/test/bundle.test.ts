import { describe, expect, it } from 'vitest';

import {
  BUNDLE_FORMAT_VERSION,
  BundleSchema,
  ProjectNameSchema,
  type Bundle,
} from '../src/index.ts';

describe('project names are checked as they are stored, NFC-normalised (T45)', () => {
  it.each([
    ['one that grows past 100 characters', '\u0958'.repeat(100)],
    ['one that grows past 400 bytes', '\ufb2c'.repeat(100)],
  ])('refuses %s', (_, name) => {
    expect(ProjectNameSchema.safeParse(name).success).toBe(false);
  });

  it('accepts ordinary names, in any script', () => {
    for (const name of ['my-app', 'café', '项目', 'x'.repeat(100)]) {
      expect(ProjectNameSchema.safeParse(name).success).toBe(true);
    }
  });
});

const validBundle: Bundle = {
  formatVersion: 1,
  agent: 'claude-code',
  scope: { kind: 'global' },
  sourceOs: 'win32',
  agentVersion: '2.1.282',
  revision: 3,
  files: [
    { path: 'settings.json', encoding: 'utf8', content: '{"theme":"dark"}', executable: false },
    {
      path: 'skills/review/SKILL.md',
      encoding: 'utf8',
      content: '# Review skill',
      executable: false,
    },
    { path: 'scripts/statusline.sh', encoding: 'utf8', content: 'echo hi', executable: true },
    { path: 'themes/logo.png', encoding: 'base64', content: 'iVBORw0KGgo=', executable: false },
  ],
};

/** Returns a copy of the valid bundle with one file replaced by `file`. */
function withFile(file: Record<string, unknown>): unknown {
  return { ...validBundle, files: [file] };
}

const fileAt = (path: string) => ({ path, encoding: 'utf8', content: '', executable: false });

describe('BundleSchema', () => {
  it('records the agent version it was saved from, or null when unknown (T32)', () => {
    expect(BundleSchema.safeParse({ ...validBundle, agentVersion: null }).success).toBe(true);
    expect(BundleSchema.safeParse({ ...validBundle, agentVersion: '2.0.0-beta.3' }).success).toBe(
      true,
    );
    expect(BundleSchema.safeParse({ ...validBundle, agentVersion: '2.1 ; rm' }).success).toBe(
      false,
    );
    const withoutVersion = Object.fromEntries(
      Object.entries(validBundle).filter(([key]) => key !== 'agentVersion'),
    );
    expect(BundleSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('accepts a valid global bundle', () => {
    expect(BundleSchema.parse(validBundle)).toEqual(validBundle);
  });

  it('accepts a project bundle with a name', () => {
    const bundle = { ...validBundle, scope: { kind: 'project', name: 'my-saas-app' } };
    expect(BundleSchema.safeParse(bundle).success).toBe(true);
  });

  it('uses format version 1', () => {
    expect(BUNDLE_FORMAT_VERSION).toBe(1);
  });

  it('accepts a bundle with no files', () => {
    expect(BundleSchema.safeParse({ ...validBundle, files: [] }).success).toBe(true);
  });

  describe('formatVersion', () => {
    it.each([0, 2, '1', undefined])('rejects %s', (formatVersion) => {
      expect(BundleSchema.safeParse({ ...validBundle, formatVersion }).success).toBe(false);
    });
  });

  it('rejects unknown top-level fields', () => {
    expect(BundleSchema.safeParse({ ...validBundle, extra: true }).success).toBe(false);
  });

  describe('agent', () => {
    it.each(['codex', 'cursor', 'open-code', 'a1'])('accepts %s', (agent) => {
      expect(BundleSchema.safeParse({ ...validBundle, agent }).success).toBe(true);
    });

    it.each(['', 'Claude Code', 'claude_code', '-claude', '1claude', 'a'.repeat(41)])(
      'rejects %j',
      (agent) => {
        expect(BundleSchema.safeParse({ ...validBundle, agent }).success).toBe(false);
      },
    );
  });

  describe('sourceOs', () => {
    it.each(['darwin', 'linux', 'win32'])('accepts %s', (sourceOs) => {
      expect(BundleSchema.safeParse({ ...validBundle, sourceOs }).success).toBe(true);
    });

    it.each(['windows', 'macos', 'freebsd', ''])('rejects %j', (sourceOs) => {
      expect(BundleSchema.safeParse({ ...validBundle, sourceOs }).success).toBe(false);
    });
  });

  describe('scope', () => {
    it.each([
      { kind: 'project' },
      { kind: 'project', name: '' },
      { kind: 'project', name: ' padded ' },
      { kind: 'project', name: 'a'.repeat(101) },
      { kind: 'project', name: 'line\nbreak' },
      { kind: 'global', name: 'not-allowed' },
      { kind: 'team' },
    ])('rejects %j', (scope) => {
      expect(BundleSchema.safeParse({ ...validBundle, scope }).success).toBe(false);
    });
  });

  describe('file paths', () => {
    it.each(['.mcp.json', 'CLAUDE.md', 'skills/a/b/c/SKILL.md', 'output-styles/terse.md'])(
      'accepts %s',
      (path) => {
        expect(BundleSchema.safeParse(withFile(fileAt(path))).success).toBe(true);
      },
    );

    // Anything that could escape the agent's folder on restore, or that only works on one OS.
    it.each([
      '',
      '../outside',
      'skills/../../outside',
      './settings.json',
      '/etc/passwd',
      'C:/Windows/system.ini',
      'c:settings.json',
      'skills\\SKILL.md',
      'skills//SKILL.md',
      'skills/',
      'nul\0byte',
      'a'.repeat(1025),
    ])('rejects %j', (path) => {
      expect(BundleSchema.safeParse(withFile(fileAt(path))).success).toBe(false);
    });

    it('rejects duplicate paths and points at the duplicate', () => {
      const result = BundleSchema.safeParse({
        ...validBundle,
        files: [fileAt('CLAUDE.md'), fileAt('settings.json'), fileAt('CLAUDE.md')],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['files', 2, 'path']);
    });
  });

  describe('file content', () => {
    it('accepts any text for utf8 files', () => {
      const file = { ...fileAt('CLAUDE.md'), content: 'Home: {{HOME}}\r\n✓ ünïcödé' };
      expect(BundleSchema.safeParse(withFile(file)).success).toBe(true);
    });

    it('rejects base64 files whose content is not base64', () => {
      const file = { ...fileAt('logo.png'), encoding: 'base64', content: 'not base64!' };
      expect(BundleSchema.safeParse(withFile(file)).success).toBe(false);
    });

    it.each(['hex', 'binary', undefined])('rejects encoding %j', (encoding) => {
      expect(BundleSchema.safeParse(withFile({ ...fileAt('a.md'), encoding })).success).toBe(false);
    });

    it('requires the executable flag', () => {
      const file = { path: 'a.sh', encoding: 'utf8', content: '' };
      expect(BundleSchema.safeParse(withFile(file)).success).toBe(false);
    });

    it('rejects unknown file fields', () => {
      expect(BundleSchema.safeParse(withFile({ ...fileAt('a.md'), mode: 0o755 })).success).toBe(
        false,
      );
    });
  });
});
