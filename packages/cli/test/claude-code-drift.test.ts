import { describe, expect, it } from 'vitest';

import {
  changelogSince,
  docsTopLevelNames,
  driftReport,
  knownTopLevelNames,
  inert,
  reportMarkdown,
} from '../scripts/drift/drift.ts';
import { CLAUDE_CODE_PATHS } from '../src/index.ts';

/** Every top-level name the ".claude directory" docs page named on 2026-09-26 (Claude Code 2.1.283). */
const DOCS_NAMES_2026_09_26 = [
  'agent-memory',
  'agent-memory-local',
  'backups',
  'cache',
  'CLAUDE.md',
  'debug',
  'feedback',
  'feedback-bundles',
  'file-history',
  'history.jsonl',
  'image-cache',
  'logs',
  'output-styles',
  'paste-cache',
  'plans',
  'plugins',
  'policy-limits.json',
  'projects',
  'remote-settings.json',
  'rules',
  'session-env',
  'settings.json',
  'settings.local.json',
  'shell-snapshots',
  'skills',
  'stats-cache.json',
  'statsig',
  'tasks',
  'todos',
  'uploads',
  'usage-data',
  'workflows',
];

const CHANGELOG = `# Changelog

## 2.1.290

- Added \`~/.claude/prompts/\` for saved prompts
- Fixed a crash when \`~/.claude/settings.json\` was empty

## 2.1.284

- Fixed scrolling in long sessions
- Added a new theme

## 2.1.283

- Added AGENTS.md support
`;

describe('drift check (T41): reading the sources', () => {
  it('finds top-level names under ~/.claude/ and .claude/ in the docs', () => {
    const docs = [
      'Tasks live in `~/.claude/tasks/<session>/`, images in ~/.claude/image-cache.',
      'Project rules: `.claude/rules/frontend/react.md`; your MCP servers are in `~/.claude.json`.',
      'Skills: ~/.claude/skills/<name>/SKILL.md and my.claude/ignored and x.claude/also-ignored',
    ].join('\n');
    expect(docsTopLevelNames(docs)).toEqual(['image-cache', 'rules', 'skills', 'tasks']);
  });

  it('keeps only relevant changelog entries of versions after the reviewed one, newest first', () => {
    expect(changelogSince(CHANGELOG, '2.1.283')).toEqual([
      { version: '2.1.290', lines: ['- Added `~/.claude/prompts/` for saved prompts'] },
    ]);
    expect(changelogSince(CHANGELOG, '2.1.290')).toEqual([]);
    expect(changelogSince(CHANGELOG, '2.1.282').map((section) => section.version)).toEqual([
      '2.1.290',
      '2.1.283',
    ]);
  });
});

describe('drift check (T41): comparing with the data file', () => {
  it('the data file knows every name the docs named on 2026-09-26', () => {
    const known = knownTopLevelNames(CLAUDE_CODE_PATHS);
    expect(DOCS_NAMES_2026_09_26.filter((name) => !known.has(name))).toEqual([]);
  });

  it('reports unknown docs names, unknown fresh-install entries and new changelog entries', () => {
    const report = driftReport({
      paths: { ...CLAUDE_CODE_PATHS, reviewedVersion: '2.1.283' },
      directoryDocs: 'Settings in `~/.claude/settings.json`, prompts in `~/.claude/prompts/`.',
      changelog: CHANGELOG,
      latestVersion: '2.1.290',
      freshEntries: ['.claude.json', 'backups', 'projects', 'sessions', 'new-state'],
    });
    expect(report).toMatchObject({
      latestVersion: '2.1.290',
      reviewedVersion: '2.1.283',
      unknownInDocs: ['prompts'],
      unknownInFreshInstall: ['new-state'],
      hasFindings: true,
    });
    expect(report.changelog.map((section) => section.version)).toEqual(['2.1.290']);

    const markdown = reportMarkdown(report, 'https://github.com/A1X6/agent-nomad/actions/runs/1');
    expect(markdown).toContain('- `prompts`');
    expect(markdown).toContain('- `new-state`');
    expect(markdown).toContain('### 2.1.290');
    expect(markdown).toContain('Set `reviewedVersion` to `2.1.290`');
    expect(markdown).toContain('actions/runs/1');
  });

  it('finds nothing when the data file is up to date', () => {
    const report = driftReport({
      paths: CLAUDE_CODE_PATHS,
      directoryDocs: DOCS_NAMES_2026_09_26.map((name) => `~/.claude/${name}`).join('\n'),
      changelog: CHANGELOG.replace('2.1.290', CLAUDE_CODE_PATHS.reviewedVersion),
      latestVersion: CLAUDE_CODE_PATHS.reviewedVersion,
      freshEntries: ['.claude.json', 'backups', 'projects', 'sessions'],
    });
    expect(report.hasFindings).toBe(false);
    expect(reportMarkdown(report)).toContain('No drift found.');
  });
});

describe('drift check (T48): changelog text is shown inert', () => {
  it('cannot mention anyone or load an image in the issue', () => {
    const shown = inert('- Fixed @someone and ![x](https://tracker.example/p.png) in ~/.claude');
    expect(shown).not.toMatch(/@[A-Za-z]/);
    expect(shown).not.toContain('![');
    expect(shown).toContain('~/.claude');
  });
});
