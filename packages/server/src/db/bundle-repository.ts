import { and, desc, eq, sql } from 'drizzle-orm';

import { decodeBundleCursor, encodeBundleCursor } from './bundle-cursor.ts';
import type { Database } from './database.ts';
import type {
  BundleKey,
  BundleMeta,
  BundleMetaWrite,
  BundleRepository,
  PutMetaResult,
} from './repositories.ts';
import { USER_STORAGE_LIMITS } from '@agentnomad/contracts';

import { bundles, users } from './schema.ts';

/** Metadata columns only; `bundles` holds no bytes, but list stays explicit anyway. */
const metaColumns = {
  id: bundles.id,
  agent: bundles.agent,
  scopeKey: bundles.scopeKey,
  nameEnc: bundles.nameEnc,
  contentHash: bundles.contentHash,
  formatVersion: bundles.formatVersion,
  revision: bundles.revision,
  sizeBytes: bundles.sizeBytes,
  updatedAt: bundles.updatedAt,
  blobId: bundles.blobId,
};

type MetaRow = {
  [K in keyof typeof metaColumns]: (typeof bundles.$inferSelect)[K];
};

function toBundleMeta(row: MetaRow): BundleMeta {
  return {
    agent: row.agent,
    scopeKey: row.scopeKey,
    nameEnc: row.nameEnc,
    contentHash: row.contentHash,
    formatVersion: row.formatVersion,
    revision: row.revision,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
    blobId: row.blobId,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

const matchesKey = (key: BundleKey) =>
  and(
    eq(bundles.userId, key.userId),
    eq(bundles.agent, key.agent),
    eq(bundles.scopeKey, key.scopeKey),
  );

/** Saved-setup metadata in Postgres (T14). */
export function createBundleRepository(db: Database): BundleRepository {
  return {
    async list(userId, page) {
      const after = page.cursor === undefined ? undefined : decodeBundleCursor(page.cursor);
      // Newest first, served by the (user_id, updated_at desc, id desc) index. One extra
      // row tells whether another page exists.
      const rows = await db
        .select({ ...metaColumns, cursorTime: sql<string>`${bundles.updatedAt}::text` })
        .from(bundles)
        .where(
          and(
            eq(bundles.userId, userId),
            after &&
              sql`(${bundles.updatedAt}, ${bundles.id}) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`,
          ),
        )
        .orderBy(desc(bundles.updatedAt), desc(bundles.id))
        .limit(page.limit + 1);

      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > page.limit && last
          ? encodeBundleCursor({ updatedAt: last.cursorTime, id: last.id })
          : null;
      return { items: items.map(toBundleMeta), nextCursor };
    },

    async get(key) {
      const [row] = await db.select(metaColumns).from(bundles).where(matchesKey(key)).limit(1);
      return row ? toBundleMeta(row) : null;
    },

    putMeta(write) {
      return db.transaction(async (tx): Promise<PutMetaResult> => {
        // Lock the row, so a concurrent save of the same setup waits for this one.
        const lockCurrent = async () => {
          const [row] = await tx
            .select(metaColumns)
            .from(bundles)
            .where(matchesKey(write.key))
            .for('update');
          return row;
        };

        // One save at a time per account (the user row is locked first, then the setup, as
        // account delete does), so two saves at once cannot both slip under the limits (T47).
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, write.key.userId))
          .for('update');
        let current = await lockCurrent();

        const [used] = await tx
          .select({
            setups: sql<number>`count(*)::int`,
            bytes: sql<string>`coalesce(sum(${bundles.sizeBytes}), 0)::bigint`,
          })
          .from(bundles)
          .where(eq(bundles.userId, write.key.userId));
        const setups = (used?.setups ?? 0) + (current ? 0 : 1);
        const bytes = Number(used?.bytes ?? 0) - (current?.sizeBytes ?? 0) + write.sizeBytes;
        if (setups > USER_STORAGE_LIMITS.maxSetups) {
          return { outcome: 'over-limit', reason: overLimit('setups') };
        }
        // Saving a setup no bigger than before is always allowed, so nobody gets stuck.
        if (bytes > USER_STORAGE_LIMITS.maxBytes && write.sizeBytes > (current?.sizeBytes ?? 0)) {
          return { outcome: 'over-limit', reason: overLimit('bytes') };
        }

        if (!current) {
          if (write.expectedRevision !== 0) return { outcome: 'conflict', currentRevision: 0 };
          const [created] = await tx
            .insert(bundles)
            .values({ ...write.key, ...newRevision(write), revision: 1 })
            .onConflictDoNothing({ target: [bundles.userId, bundles.agent, bundles.scopeKey] })
            .returning(metaColumns);
          if (created) {
            return { outcome: 'saved', meta: toBundleMeta(created), replacedBlobId: null };
          }
          // Another first save won the race; judge this one against what it stored.
          current = await lockCurrent();
          if (!current) throw new Error('Saved setup vanished during a first save');
        }

        // Same bytes already current: a retry of a save that went through (revision is one
        // ahead) or an identical push (revision equal). Nothing to change.
        const isRetry =
          current.revision === write.expectedRevision ||
          current.revision === write.expectedRevision + 1;
        if (isRetry && sameBytes(current.contentHash, write.contentHash)) {
          return { outcome: 'unchanged', meta: toBundleMeta(current) };
        }

        if (current.revision !== write.expectedRevision) {
          return { outcome: 'conflict', currentRevision: current.revision };
        }

        const [saved] = await tx
          .update(bundles)
          .set({
            ...newRevision(write),
            revision: current.revision + 1,
            updatedAt: sql`now()`,
          })
          .where(eq(bundles.id, current.id))
          .returning(metaColumns);
        if (!saved) throw new Error('Saved setup vanished while locked');
        return { outcome: 'saved', meta: toBundleMeta(saved), replacedBlobId: current.blobId };
      });
    },

    async usage(userId) {
      const [row] = await db
        .select({
          setups: sql<number>`count(*)::int`,
          bytes: sql<string>`coalesce(sum(${bundles.sizeBytes}), 0)::bigint`,
        })
        .from(bundles)
        .where(eq(bundles.userId, userId));
      return { setups: row?.setups ?? 0, bytes: Number(row?.bytes ?? 0) };
    },

    async delete(key) {
      const [row] = await db.delete(bundles).where(matchesKey(key)).returning(metaColumns);
      return row ? toBundleMeta(row) : null;
    },
  };
}

/** Why a save is refused by the storage limits, in words the CLI shows as they are. */
export function overLimit(kind: 'setups' | 'bytes'): string {
  return kind === 'setups'
    ? `An account keeps at most ${String(USER_STORAGE_LIMITS.maxSetups)} saved setups. Delete some with \`agentnomad delete\` first.`
    : `An account keeps at most ${String(USER_STORAGE_LIMITS.maxBytes / 1024 / 1024)} MB of saved setups. Delete some with \`agentnomad delete\` or make this one smaller.`;
}

/** The columns a save writes, apart from the revision number. */
function newRevision(write: BundleMetaWrite) {
  return {
    nameEnc: write.nameEnc,
    contentHash: write.contentHash,
    formatVersion: write.formatVersion,
    sizeBytes: write.sizeBytes,
    blobId: write.blobId,
  };
}
