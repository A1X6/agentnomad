/**
 * The weekly Claude Code drift check (T41): compares the Claude Code paths data file (T32)
 * with the newest Claude Code, so a file or folder Claude Code adds is noticed before users
 * miss it. Pure functions; `check-claude-code.ts` fetches the inputs and writes the report.
 *
 * Three sources:
 * - the official ".claude directory" docs page, which names what lives in `~/.claude` and a
 *   project's `.claude`;
 * - what a fresh Claude Code creates in an empty config folder (run in CI);
 * - the changelog entries of versions newer than the one the data file was reviewed against.
 */
import type { ClaudeCodePathsData } from '../../src/agents/claude-code/claude-code-paths.data.ts';
import { compareVersions } from '../../src/agents/claude-code/version-stamp.ts';

export interface ChangelogSection {
  readonly version: string;
  /** Only the entries that may change where Claude Code keeps things (see `RELEVANT`). */
  readonly lines: readonly string[];
}

export interface DriftReport {
  readonly latestVersion: string;
  readonly reviewedVersion: string;
  /** Top-level names the docs page mentions that the data file does not know. */
  readonly unknownInDocs: readonly string[];
  /** Top-level names a fresh Claude Code created that the data file does not know. */
  readonly unknownInFreshInstall: readonly string[];
  /** Relevant changelog entries of versions after `reviewedVersion`, newest first. */
  readonly changelog: readonly ChangelogSection[];
  readonly hasFindings: boolean;
}

export interface DriftInput {
  readonly paths: ClaudeCodePathsData;
  /** Markdown of https://code.claude.com/docs/en/claude-directory.md */
  readonly directoryDocs: string;
  /** Markdown of Claude Code's CHANGELOG.md */
  readonly changelog: string;
  /** The newest Claude Code version on npm. */
  readonly latestVersion: string;
  /** Top-level names in a fresh config folder, or `null` when that step did not run. */
  readonly freshEntries: readonly string[] | null;
}

/**
 * With `CLAUDE_CONFIG_DIR` set (as in the fresh-install run), `.claude.json` lives inside
 * the config folder instead of the home folder; the data file handles it separately.
 */
const CONFIG_DIR_ONLY = ['.claude.json'];

/** First path segment: `skills/synced` → `skills`, `.claude/rules` → `.claude`. */
const firstSegment = (path: string) => path.split('/')[0] ?? path;

/**
 * Every top-level name the data file accounts for, in `~/.claude` or a project's `.claude`:
 * synced, never synced or known state. Anything else is drift.
 */
export function knownTopLevelNames(paths: ClaudeCodePathsData): Set<string> {
  const inProjectClaude = (entry: string) =>
    entry.startsWith('.claude/') ? [firstSegment(entry.slice('.claude/'.length))] : [];
  return new Set([
    ...paths.global.files,
    ...paths.global.folders,
    ...paths.global.memoryFolders,
    ...paths.global.neverSynced.map(firstSegment),
    ...paths.global.knownState.map(firstSegment),
    ...paths.project.claudeFiles,
    ...paths.project.claudeFolders,
    ...paths.project.memoryFolders,
    ...paths.project.knownState.map(firstSegment),
    ...paths.project.neverSynced.flatMap(inProjectClaude),
  ]);
}

/**
 * Top-level names the docs mention under `~/.claude/` or `.claude/`, e.g. `tasks` for
 * `~/.claude/tasks/` and `rules` for `.claude/rules/frontend/react.md`. Placeholders in
 * angle brackets and globs are not names.
 */
export function docsTopLevelNames(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(
    /(?:~\/\.claude|(?<![\w.~/-])\.claude)\/([A-Za-z0-9._-]+)/g,
  )) {
    // A full stop ending the sentence is not part of the name.
    const name = match[1]?.replace(/\.+$/, '');
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Changelog entries that add, change, move or remove something about files or setup. */
const KIND =
  /^- (Added|Changed|Moved|Renamed|Removed|New|Now|Deprecated|Replaced|Settings?|Claude Code now)\b/i;
const WHERE =
  /~\/\.claude\b|\.claude\/|\.claude\.json|CLAUDE_CONFIG_DIR|\b(stored|saved|written|moved|kept|lives?) (in|to|under|at)\b|\bnew (file|folder|directory)\b|AGENTS\.md|CLAUDE(\.local)?\.md|\.mcp\.json|keybindings\.json|\.worktreeinclude/i;

/** Relevant entries of every version newer than `afterVersion`, newest first. */
export function changelogSince(markdown: string, afterVersion: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [heading = '', ...body] = section.split(/\r?\n/);
    const version = /^\d+\.\d+\.\d+/.exec(heading.trim())?.[0];
    if (version === undefined || compareVersions(version, afterVersion) <= 0) continue;
    const lines = body.filter((line) => KIND.test(line) && WHERE.test(line));
    if (lines.length > 0) sections.push({ version, lines });
  }
  return sections.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * A changelog line as it is shown in the issue (T48): text from outside the repository, so an
 * @mention cannot notify anyone and an image cannot load from elsewhere.
 */
export function inert(line: string): string {
  return line.replace(/@(?=[A-Za-z0-9])/g, '@\u200b').replace(/!\[/g, '!\\[');
}

export function driftReport(input: DriftInput): DriftReport {
  const known = knownTopLevelNames(input.paths);
  const unknownInDocs = docsTopLevelNames(input.directoryDocs).filter((name) => !known.has(name));
  const unknownInFreshInstall = (input.freshEntries ?? [])
    .filter((name) => !known.has(name) && !CONFIG_DIR_ONLY.includes(name))
    .sort();
  const changelog = changelogSince(input.changelog, input.paths.reviewedVersion);
  return {
    latestVersion: input.latestVersion,
    reviewedVersion: input.paths.reviewedVersion,
    unknownInDocs,
    unknownInFreshInstall,
    changelog,
    hasFindings:
      unknownInDocs.length > 0 || unknownInFreshInstall.length > 0 || changelog.length > 0,
  };
}

const bullets = (items: readonly string[]) => items.map((item) => `- \`${item}\``).join('\n');

/** The GitHub issue (or job summary) for a report, in Markdown. */
export function reportMarkdown(report: DriftReport, runUrl?: string): string {
  const parts = [
    `The paths data file (\`packages/cli/src/agents/claude-code/claude-code-paths.data.ts\`) was reviewed against Claude Code **${report.reviewedVersion}**; the newest is **${report.latestVersion}**.`,
  ];
  if (!report.hasFindings) parts.push('No drift found.');
  if (report.unknownInDocs.length > 0) {
    parts.push(
      '## Named by the docs, unknown to the data file',
      'From [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory):',
      bullets(report.unknownInDocs),
    );
  }
  if (report.unknownInFreshInstall.length > 0) {
    parts.push(
      '## Created by a fresh Claude Code, unknown to the data file',
      bullets(report.unknownInFreshInstall),
    );
  }
  if (report.changelog.length > 0) {
    parts.push(
      '## Changelog entries to review',
      'Entries that may change where Claude Code keeps things ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)):',
      ...report.changelog.map(
        (section) => `### ${section.version}\n${section.lines.map(inert).join('\n')}`,
      ),
    );
  }
  if (report.hasFindings) {
    parts.push(
      '## To do',
      [
        '- [ ] Sort each unknown name into `neverSynced`, `knownState` or a synced list (never sync credentials, history, caches or machine state).',
        '- [ ] Read the changelog entries; add anything that is part of a user setup.',
        `- [ ] Set \`reviewedVersion\` to \`${report.latestVersion}\`, run \`pnpm check\`, and close this issue.`,
      ].join('\n'),
    );
  }
  if (runUrl !== undefined) parts.push(`---\nFound by the [weekly drift check](${runUrl}).`);
  return `${parts.join('\n\n')}\n`;
}
