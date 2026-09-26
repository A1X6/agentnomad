import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import * as z from 'zod';

/**
 * Plugins are reinstalled, never copied (T29): push saves which marketplaces and plugins
 * are installed, and pull runs Claude Code's own `claude plugin` commands.
 */

/** A marketplace to add on the other PC; `add` is the `claude plugin marketplace add` source. */
export interface MarketplaceEntry {
  readonly name: string;
  readonly add: string;
}

export type PluginScope = 'user' | 'project' | 'local';

export interface PluginEntry {
  /** `plugin@marketplace`. */
  readonly id: string;
  readonly scope: PluginScope;
  /** Built by running a command on install: needs the user's own yes. */
  readonly commandSource: boolean;
}

/** What `.agentnomad/plugins.json` holds. */
export interface PluginManifest {
  readonly marketplaces: readonly MarketplaceEntry[];
  readonly plugins: readonly PluginEntry[];
  /** Left out, with why, so push can say so. */
  readonly skipped: readonly { readonly what: string; readonly reason: string }[];
}

export const PluginManifestSchema = z.strictObject({
  marketplaces: z.array(
    z.strictObject({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      // Passed to `claude plugin marketplace add`: only the forms push writes (a GitHub
      // `owner/repo`, an https or git@ URL, each with an optional `#ref`), so never an
      // option, a local path or plain http (T44).
      add: z
        .string()
        .regex(
          /^([A-Za-z0-9][\w.-]*\/[\w.-]+|https:\/\/[^\s"'`&|<>^%;]+|git@[^\s"'`&|<>^%;]+)(#[^\s"'`&|<>^%;]+)?$/,
        ),
    }),
  ),
  plugins: z.array(
    z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/),
      scope: z.enum(['user', 'project', 'local']),
      commandSource: z.boolean(),
    }),
  ),
  skipped: z.array(z.strictObject({ what: z.string(), reason: z.string() })),
});

const SourceSchema = z.looseObject({
  source: z.string(),
  repo: z.string().optional(),
  url: z.string().optional(),
  ref: z.string().optional(),
});
const KnownMarketplacesSchema = z.record(
  z.string(),
  z.looseObject({ source: SourceSchema, installLocation: z.string().optional() }),
);
const InstalledPluginsSchema = z.looseObject({
  plugins: z.record(
    z.string(),
    z.array(
      z.looseObject({
        scope: z.enum(['user', 'project', 'local', 'managed']).or(z.string()),
        projectPath: z.string().optional(),
      }),
    ),
  ),
});
const MarketplaceJsonSchema = z.looseObject({
  plugins: z.array(z.looseObject({ name: z.string(), source: z.unknown().optional() })).optional(),
});

type Source = z.infer<typeof SourceSchema>;

/**
 * The `claude plugin marketplace add` argument for a saved source: `owner/repo#ref`, a git
 * or https URL. `null` for local folders and files (they exist only on the old PC) and for
 * anything else this version does not know.
 */
export function marketplaceAddArgument(source: Source): string | null {
  const withRef = (base: string) => (source.ref ? `${base}#${source.ref}` : base);
  switch (source.source) {
    case 'github':
      return source.repo && /^[\w.-]+\/[\w.-]+$/.test(source.repo) ? withRef(source.repo) : null;
    case 'git':
      return source.url && /^(https:\/\/|git@)/.test(source.url) ? withRef(source.url) : null;
    case 'url':
      return source.url?.startsWith('https://') ? source.url : null;
    default:
      return null;
  }
}

async function readJson<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S> | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface PluginManifestInput {
  /** Claude Code's base folder (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  /** `global`: user-scope plugins; a project folder: plugins installed for that project. */
  readonly scope:
    { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectDir: string };
}

/** Reads the installed plugins and their marketplaces; `null` when there are none to save. */
export async function readPluginManifest(
  input: PluginManifestInput,
): Promise<PluginManifest | null> {
  const path = input.platform === 'win32' ? win32 : posix;
  const pluginsDir = path.join(input.baseDir, 'plugins');
  const installed = await readJson(
    path.join(pluginsDir, 'installed_plugins.json'),
    InstalledPluginsSchema,
  );
  if (installed === null) return null;
  const known =
    (await readJson(path.join(pluginsDir, 'known_marketplaces.json'), KnownMarketplacesSchema)) ??
    {};

  const samePath = (a: string, b: string) => {
    const [x, y] = [path.resolve(a), path.resolve(b)];
    return input.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  const wanted = (entry: { scope: string; projectPath?: string | undefined }) =>
    input.scope.kind === 'global'
      ? entry.scope === 'user'
      : (entry.scope === 'project' || entry.scope === 'local') &&
        entry.projectPath !== undefined &&
        samePath(entry.projectPath, input.scope.projectDir);

  const marketplaces = new Map<string, MarketplaceEntry>();
  const plugins: PluginEntry[] = [];
  const skipped: { what: string; reason: string }[] = [];

  for (const [id, installs] of Object.entries(installed.plugins)) {
    for (const install of installs.filter(wanted)) {
      const marketplaceName = id.split('@')[1] ?? '';
      const marketplace = known[marketplaceName];
      const add = marketplace ? marketplaceAddArgument(marketplace.source) : null;
      if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(id)) {
        skipped.push({ what: id, reason: 'unexpected plugin name' });
        continue;
      }
      if (marketplaceName.startsWith('claudeai-')) {
        skipped.push({ what: id, reason: 'comes with your claude.ai account' });
        continue;
      }
      if (!marketplace || add === null) {
        skipped.push({
          what: id,
          reason: marketplace
            ? 'its marketplace is a local folder or unknown source'
            : 'its marketplace is missing',
        });
        continue;
      }
      marketplaces.set(marketplaceName, { name: marketplaceName, add });

      // A `command` source builds the plugin by running a command: flag it for an extra yes.
      const catalog = marketplace.installLocation
        ? await readJson(
            path.join(marketplace.installLocation, '.claude-plugin', 'marketplace.json'),
            MarketplaceJsonSchema,
          )
        : null;
      const pluginName = id.split('@')[0];
      const source = catalog?.plugins?.find((entry) => entry.name === pluginName)?.source;
      const commandSource =
        typeof source === 'object' &&
        source !== null &&
        'source' in source &&
        source.source === 'command';
      const scope: PluginScope | null =
        install.scope === 'user' || install.scope === 'project' || install.scope === 'local'
          ? install.scope
          : null;
      if (scope !== null) plugins.push({ id, scope, commandSource });
    }
  }

  if (plugins.length === 0 && skipped.length === 0) return null;
  const byName = (a: { name?: string; id?: string }, b: { name?: string; id?: string }) =>
    (a.name ?? a.id ?? '').localeCompare(b.name ?? b.id ?? '');
  return {
    marketplaces: [...marketplaces.values()].sort(byName),
    plugins: plugins.sort(byName),
    skipped,
  };
}
