/**
 * One stored file of encrypted bundle bytes. `blobId` is random and never reused, so two
 * uploads (even of the same setup at the same moment) can never overwrite each other.
 */
export interface BlobRef {
  readonly userId: string;
  readonly blobId: string;
}

/**
 * Stores encrypted bundle bytes (T14). Postgres in v1, Cloudflare R2 later, with no change
 * to the API or CLI. Which file is current is decided by the `bundles` row, never by the
 * file's name.
 *
 * Upload order, so a failed or rejected upload never damages the current copy:
 * 1. `put` the bytes; they get a new random id.
 * 2. `BundleRepository.putMeta` checks the revision and, if it passes, points the setup at
 *    the new id in the same step.
 * 3. On `saved`, `delete` the file it replaced; on `unchanged` or `conflict`, `delete` the
 *    new file (it never became current).
 */
export interface BlobStore {
  /** Stores the bytes under a new random id and returns where they are. */
  put(userId: string, bytes: Uint8Array): Promise<BlobRef>;
  /** `null` when no such file exists for that user. */
  get(ref: BlobRef): Promise<Uint8Array | null>;
  /**
   * Does nothing when the file is already gone. Throws BlobInUseError for a file a setup
   * still points to, so a bug can never delete the current copy.
   */
  delete(ref: BlobRef): Promise<void>;
  /**
   * Deletes files no setup points to that are older than `olderThanSeconds` (T47): left
   * behind when a server stopped between storing a file and saving its setup, or when a
   * cleanup failed. Returns how many were deleted.
   */
  deleteOrphans?(olderThanSeconds: number): Promise<number>;
}

/** Tried to delete the file a saved setup currently points to. */
export class BlobInUseError extends Error {
  constructor() {
    super('This file is the current copy of a saved setup and cannot be deleted');
    this.name = 'BlobInUseError';
  }
}
