import * as z from 'zod';

import type { CollectedFile } from '../agents/adapter.ts';
import { commandWords } from '../agents/claude-code/file-gathering.ts';
import {
  HOME_SCRIPTS_PREFIX,
  SCRIPT_EXTENSIONS,
  TOOL_CONFIG_FILES,
} from '../agents/claude-code/global-paths.ts';
import { runnableInMarkdown } from '../agents/claude-code/runnable-markdown.ts';
import { LOADER_VARIABLE } from '../env/loader-variables.ts';

/**
 * Things in a setup that run programs on this PC (T34, T44), as Claude Code's docs describe
 * them: hooks, the status line, settings that run a command, loader environment variables,
 * MCP servers, and skill, command and subagent files with commands that run by themselves.
 * Pull shows the new or changed ones and asks before writing them.
 */
export interface RunnableEntry {
  /** The bundle file it lives in, e.g. `settings.json` or `.mcp.json`. */
  readonly file: string;
  /** What it is, e.g. `hook PreToolUse`, `status line`, `MCP server github`. */
  readonly label: string;
  /** What runs, e.g. `~/.claude/hooks/check.sh` or `npx gh-mcp` or a URL. */
  readonly command: string;
  /** What is compared with this PC; the whole entry, so a change anywhere in it shows. */
  readonly identity: string;
}

export interface ReviewedEntry extends RunnableEntry {
  readonly change: 'new' | 'changed';
}

const SETTINGS_FILES = new Set([
  'settings.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);
const MCP_FILES = new Set(['.mcp.json', '.agentnomad/claude.json']);

/**
 * Settings keys whose value is a command Claude Code runs ("with your own command" in its
 * settings reference); every one is accepted in any settings file.
 */
const COMMAND_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'fileSuggestion',
];

/** Folders whose Markdown files are skills, custom commands or subagents. */
const MARKDOWN_FOLDERS = /^(\.claude\/)?(skills|commands|agents)\//;

const Json = z.record(z.string(), z.unknown());
const Hook = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
});
const Hooks = z.record(z.string(), z.array(z.looseObject({ hooks: z.array(Hook).optional() })));
const Command = z.looseObject({ command: z.string().optional() });
const Servers = z.record(z.string(), Json);
const Env = z.record(z.string(), z.unknown());

function parse(file: CollectedFile): Record<string, unknown> | null {
  try {
    const parsed = Json.safeParse(JSON.parse(new TextDecoder().decode(file.content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** JSON with sorted keys, so two copies of the same object compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Restored paths use forward slashes on Windows (T10), existing ones often backslashes. */
const slashes = (command: string) => command.replace(/\\/g, '/');

const entry = (file: string, label: string, command: string, identity = slashes(command)) => ({
  file,
  label,
  command,
  identity,
});

/** An MCP server as shown: what runs or where it connects, plus what else it carries. */
function describeServer(server: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const args = Array.isArray(server['args']) ? server['args'].map(text) : [];
  const main =
    text(server['url']) || [text(server['command']), ...args].filter((part) => part).join(' ');
  const extras = [
    ...(typeof server['headersHelper'] === 'string'
      ? [`runs ${server['headersHelper']} for its headers`]
      : []),
    // Names only: values may be secrets.
    ...(typeof server['env'] === 'object' && server['env'] !== null
      ? [`env: ${Object.keys(server['env']).join(', ')}`]
      : []),
    ...(typeof server['headers'] === 'object' && server['headers'] !== null
      ? [`headers: ${Object.keys(server['headers']).join(', ')}`]
      : []),
  ];
  return extras.length > 0 ? `${main}  (${extras.join('; ')})` : main;
}

function settingsEntries(file: CollectedFile, json: Record<string, unknown>): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  const hooks = Hooks.safeParse(json['hooks']);
  for (const [event, groups] of Object.entries(hooks.success ? hooks.data : {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hook.command !== undefined) {
          const command = [hook.command, ...(hook.args ?? [])].join(' ');
          entries.push(entry(file.path, `hook ${event}`, command));
        } else if (hook.type === 'http' && hook.url !== undefined) {
          // Sends what the hook sees (tool input, prompts) to that address.
          entries.push(entry(file.path, `hook ${event} (sends data to)`, hook.url));
        }
      }
    }
  }
  const statusLine = Command.safeParse(json['statusLine']);
  if (statusLine.success && statusLine.data.command !== undefined) {
    entries.push(entry(file.path, 'status line', statusLine.data.command));
  }
  for (const key of COMMAND_SETTINGS) {
    const value = json[key];
    const nested = Command.safeParse(value);
    const command =
      typeof value === 'string' ? value : nested.success ? nested.data.command : undefined;
    if (command !== undefined) entries.push(entry(file.path, `setting ${key}`, command));
  }
  const env = Env.safeParse(json['env']);
  for (const [name, value] of Object.entries(env.success ? env.data : {})) {
    // In a settings `env` block they reach Claude Code and every hook it starts.
    if (LOADER_VARIABLE.test(name)) {
      entries.push(entry(file.path, `setting env ${name}`, `${name}=${String(value)}`));
    }
  }
  // Claude Code takes these only from user settings (its permission-modes docs).
  const permissions = Json.safeParse(json['permissions']);
  if (
    file.path === 'settings.json' &&
    permissions.success &&
    permissions.data['defaultMode'] === 'bypassPermissions'
  ) {
    entries.push(
      entry(
        file.path,
        'setting permissions.defaultMode',
        'bypassPermissions (Claude asks nothing)',
      ),
    );
  }
  if (json['enableAllProjectMcpServers'] === true) {
    entries.push(
      entry(
        file.path,
        'setting enableAllProjectMcpServers',
        "true (a project's .mcp.json servers start without asking)",
      ),
    );
  }
  return entries;
}

/**
 * Everything in these files that runs programs: hooks (commands and addresses they send to),
 * the status line, command settings, loader variables in `env`, permission settings that
 * stop Claude Code asking, MCP servers (the whole definition is compared), and skill,
 * command and subagent files with commands that run by themselves.
 */
export function runnableEntries(files: readonly CollectedFile[]): RunnableEntry[] {
  const entries: RunnableEntry[] = [];
  for (const file of files) {
    if (MARKDOWN_FOLDERS.test(file.path) && file.path.toLowerCase().endsWith('.md')) {
      const found = runnableInMarkdown(new TextDecoder().decode(file.content));
      const kind = /(skills|commands|agents)\//.exec(file.path)?.[1] ?? 'skills';
      const label = { skills: 'skill', commands: 'command', agents: 'subagent' }[kind] ?? 'skill';
      if (found.length > 0) {
        entries.push(entry(file.path, `${label} ${file.path}`, found.join(', '), stable(found)));
      }
      continue;
    }
    const json = SETTINGS_FILES.has(file.path) || MCP_FILES.has(file.path) ? parse(file) : null;
    if (json === null) continue;
    if (SETTINGS_FILES.has(file.path)) entries.push(...settingsEntries(file, json));
    const servers = Servers.safeParse(json['mcpServers']);
    for (const [name, server] of Object.entries(servers.success ? servers.data : {})) {
      const shown = describeServer(server);
      if (shown !== '') {
        entries.push(entry(file.path, `MCP server ${name}`, shown, slashes(stable(server))));
      }
    }
  }
  return entries;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

const isScript = (path: string) =>
  SCRIPT_EXTENSIONS.has(/(\.[^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '');
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * Incoming script files that a command runs, matched by path: the command names the
 * script's path within the base folder, the project or (for `.agentnomad/home/...`) the home
 * folder, e.g. `…/.claude/hooks/check.sh` runs `hooks/check.sh`. Commands come from the
 * incoming setup and from this PC's own (T44: a hook already here runs a changed script
 * too), and scripts next to a run script count as well (a helper it loads).
 */
function scriptsRun(incoming: readonly CollectedFile[], commands: readonly string[]) {
  const words = commands.flatMap((command) =>
    commandWords(command).map((word) => word.replace(/\\/g, '/')),
  );
  const relativeOf = (path: string) =>
    path.startsWith(HOME_SCRIPTS_PREFIX) ? path.slice(HOME_SCRIPTS_PREFIX.length) : path;
  const run = incoming.filter((file) => {
    if (!isScript(file.path)) return false;
    const relative = relativeOf(file.path);
    return words.some((word) => word === relative || word.endsWith(`/${relative}`));
  });
  const folders = new Set(run.map((file) => folderOf(file.path)).filter((folder) => folder));
  return incoming.filter(
    (file) => run.includes(file) || (isScript(file.path) && folders.has(folderOf(file.path))),
  );
}

/**
 * The incoming entries that are not already on this PC exactly as they are: new ones, ones
 * whose definition changed, scripts that commands run whose content is new or changed here
 * (T38: a changed `check.sh` behind an unchanged hook command is shown too), and tool
 * settings that can hold commands. Unchanged ones are not asked about.
 */
export function reviewRunnable(
  incoming: readonly CollectedFile[],
  current: readonly CollectedFile[],
): ReviewedEntry[] {
  const here = runnableEntries(current);
  const entries = runnableEntries(incoming);
  const commands: ReviewedEntry[] = entries
    .filter(
      (item) =>
        !here.some(
          (existing) => existing.label === item.label && existing.identity === item.identity,
        ),
    )
    .map((item) => ({
      ...item,
      // A named entry (not a hook) that is here with another definition is a change.
      change:
        !item.label.startsWith('hook ') && here.some((existing) => existing.label === item.label)
          ? ('changed' as const)
          : ('new' as const),
    }));

  const newOrChanged = (file: CollectedFile) => {
    const existing = current.find((item) => item.path === file.path);
    if (existing && sameBytes(existing.content, file.content)) return null;
    return existing ? ('changed' as const) : ('new' as const);
  };
  const scripts: ReviewedEntry[] = scriptsRun(incoming, [
    ...entries.map((item) => item.command),
    ...here.map((item) => item.command),
  ]).flatMap((file) => {
    const change = newOrChanged(file);
    if (change === null) return [];
    const shown = file.path.startsWith(HOME_SCRIPTS_PREFIX)
      ? `~/${file.path.slice(HOME_SCRIPTS_PREFIX.length)}`
      : file.path;
    return [{ ...entry(file.path, 'script', shown), change }];
  });

  // Settings of status line tools can hold commands of their own (ccstatusline's Custom
  // Command widget), so a new or changed copy is shown too.
  const toolSettings = new Set(
    Object.values(TOOL_CONFIG_FILES)
      .flat()
      .map((path) => HOME_SCRIPTS_PREFIX + path),
  );
  const tools: ReviewedEntry[] = incoming
    .filter((file) => toolSettings.has(file.path))
    .flatMap((file) => {
      const change = newOrChanged(file);
      if (change === null) return [];
      const shown = `~/${file.path.slice(HOME_SCRIPTS_PREFIX.length)}`;
      return [{ ...entry(file.path, 'tool settings (can run commands)', shown), change }];
    });
  return [...commands, ...scripts, ...tools];
}
