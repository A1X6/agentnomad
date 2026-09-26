import {
  GLOBAL_SCOPE_KEY,
  type AgentId,
  type Bundle,
  type BundleSummary,
} from '@agentnomad/contracts';
import {
  DecryptionError,
  decryptProjectName,
  openBundle,
  scopeKeyFor,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';

import type { ApiClient } from '../api/api-client.ts';

/** One saved setup as listed, with its project name decrypted on this PC. */
export interface SavedSetup {
  readonly agent: AgentId;
  readonly scopeKey: string;
  /** `null` for the global setup. */
  readonly projectName: string | null;
  readonly revision: number;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

/** A download that is not what it claims to be (wrong key, moved, or damaged). */
export class SetupUnreadableError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(
      `The saved ${what} could not be opened with your key. It may be damaged; nothing was written.`,
      options,
    );
    this.name = 'SetupUnreadableError';
  }
}

/**
 * The server labelled a copy with another revision than the one sealed inside it (T38):
 * an older copy passed off as the current one.
 */
export class MislabelledSetupError extends Error {
  constructor(what: string, sealed: number, reported: number) {
    super(
      `The server sent the saved ${what} as revision ${String(reported)}, but it was saved as revision ${String(sealed)}. It may be an old copy; nothing was written.`,
    );
    this.name = 'MislabelledSetupError';
  }
}

/** Every saved setup of the account (all pages), names decrypted; unreadable names are left out. */
/** Pages of 100: far more than one person saves, and a stop for a server that never ends. */
const MAX_PAGES = 100;

/**
 * Every saved setup's metadata, page by page (T46): stops at a repeated cursor or after
 * MAX_PAGES, so a broken or hostile server cannot keep the CLI listing forever.
 */
export async function listAllBundles(api: ApiClient): Promise<BundleSummary[]> {
  const items: BundleSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await api.bundles.list(
      cursor === null ? { limit: 100 } : { cursor, limit: 100 },
    );
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) return items;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new Error('The server kept sending more pages of saved setups; try again later.');
}

/** `<agent>/<scopeKey>` → its revision on the server, for push's checks (T46). */
export async function listSavedRevisions(api: ApiClient): Promise<Map<string, number>> {
  const items = await listAllBundles(api);
  return new Map(items.map((item) => [`${item.agent}/${item.scopeKey}`, item.revision]));
}

export async function listSavedSetups(
  api: ApiClient,
  crypto: CryptoService,
  dataKey: Uint8Array,
): Promise<SavedSetup[]> {
  const items = await listAllBundles(api);
  const setups: SavedSetup[] = [];
  for (const item of items) {
    let projectName: string | null = null;
    if (item.scopeKey !== GLOBAL_SCOPE_KEY) {
      if (item.nameEnc === null) continue;
      try {
        projectName = decryptProjectName(
          crypto,
          new Uint8Array(Buffer.from(item.nameEnc, 'base64')),
          dataKey,
          {
            agent: item.agent,
            scopeKey: item.scopeKey,
          },
        );
      } catch (error) {
        if (error instanceof DecryptionError) continue;
        throw error;
      }
    }
    setups.push({
      agent: item.agent,
      scopeKey: item.scopeKey,
      projectName,
      revision: item.revision,
      sizeBytes: item.sizeBytes,
      updatedAt: item.updatedAt,
    });
  }
  return setups;
}

/**
 * Downloads, decrypts and checks one setup: the bundle must be for the same agent and scope
 * it was listed under (encryption binds them, and the contents are checked too).
 */
export async function downloadSetup(
  setup: SavedSetup,
  deps: { api: ApiClient; crypto: CryptoService; codec: BundleCodec; dataKey: Uint8Array },
): Promise<{ bundle: Bundle; revision: number }> {
  const what = setup.projectName === null ? 'global setup' : `project "${setup.projectName}"`;
  const downloaded = await deps.api.bundles.get({ agent: setup.agent, scopeKey: setup.scopeKey });
  let bundle: Bundle;
  try {
    const plain = openBundle(deps.crypto, downloaded.ciphertext, deps.dataKey, {
      formatVersion: downloaded.formatVersion,
      agent: setup.agent,
      scopeKey: setup.scopeKey,
    });
    bundle = await deps.codec.decode(plain);
  } catch (error) {
    throw new SetupUnreadableError(what, { cause: error });
  }
  const expectedScopeKey = scopeKeyFor(deps.crypto, deps.dataKey, bundle.scope);
  if (bundle.agent !== setup.agent || expectedScopeKey !== setup.scopeKey) {
    throw new SetupUnreadableError(what);
  }
  if (bundle.revision !== downloaded.revision) {
    throw new MislabelledSetupError(what, bundle.revision, downloaded.revision);
  }
  return { bundle, revision: bundle.revision };
}
