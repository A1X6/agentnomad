import { and, eq, lt, notExists, sql } from 'drizzle-orm';

import { FOREIGN_KEY_VIOLATION, postgresErrorCode, type Database } from '../db/database.ts';
import { bundleBlobs, bundles } from '../db/schema.ts';
import { BlobInUseError, type BlobRef, type BlobStore } from './blob-store.ts';

const matchesRef = (ref: BlobRef) =>
  and(eq(bundleBlobs.id, ref.blobId), eq(bundleBlobs.userId, ref.userId));

/** Encrypted bundle bytes in the `bundle_blobs` table (T14). */
export function createPostgresBlobStore(db: Database): BlobStore {
  return {
    async put(userId, bytes) {
      const [row] = await db
        .insert(bundleBlobs)
        .values({ userId, ciphertext: bytes })
        .returning({ blobId: bundleBlobs.id });
      if (!row) throw new Error('File insert returned no row');
      return { userId, blobId: row.blobId };
    },

    async get(ref) {
      const [row] = await db
        .select({ ciphertext: bundleBlobs.ciphertext })
        .from(bundleBlobs)
        .where(matchesRef(ref))
        .limit(1);
      return row ? row.ciphertext : null;
    },

    async delete(ref) {
      try {
        await db.delete(bundleBlobs).where(matchesRef(ref));
      } catch (error) {
        // The database refuses to delete the file a setup points to (bundles_blob_fk).
        if (postgresErrorCode(error) === FOREIGN_KEY_VIOLATION) throw new BlobInUseError();
        throw error;
      }
    },

    async deleteOrphans(olderThanSeconds) {
      // Old enough that no upload is still between storing its file and saving its setup.
      const removed = await db
        .delete(bundleBlobs)
        .where(
          and(
            lt(bundleBlobs.createdAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
            notExists(
              db.select({ id: bundles.id }).from(bundles).where(eq(bundles.blobId, bundleBlobs.id)),
            ),
          ),
        )
        .returning({ id: bundleBlobs.id });
      return removed.length;
    },
  };
}
