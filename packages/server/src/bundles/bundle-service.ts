import { GLOBAL_SCOPE_KEY, USER_STORAGE_LIMITS } from '@agentnomad/contracts';

import { overLimit } from '../db/bundle-repository.ts';
import type { BundleKey, BundleMeta, BundlePage, BundleRepository } from '../db/repositories.ts';
import type { BlobStore } from '../storage/blob-store.ts';

/** Nonce (24) + Poly1305 tag (16): anything shorter cannot be an encrypted bundle. */
export const MIN_CIPHERTEXT_BYTES = 40;

/** The upload does not match what its headers claim (hash, size or name rules). */
export class InvalidUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUploadError';
  }
}

/** Saving would take the account past its storage limits (T47); the message says which. */
export class StorageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLimitError';
  }
}

/** No saved setup for that agent and scope. */
export class BundleNotFoundError extends Error {
  constructor() {
    super('No saved setup for that agent and scope');
    this.name = 'BundleNotFoundError';
  }
}

export interface BundleUploadInput {
  readonly key: BundleKey;
  readonly expectedRevision: number;
  readonly ciphertext: Uint8Array;
  /** SHA-256 the client computed; must match the bytes that arrived. */
  readonly contentHash: Uint8Array;
  readonly formatVersion: number;
  /** Required for a project scope, absent for the global scope. */
  readonly nameEnc: Uint8Array | null;
}

export type UploadResult =
  /** Stored (`saved`) or already stored by an earlier try of the same upload (`unchanged`). */
  | { readonly outcome: 'stored'; readonly meta: BundleMeta }
  /** Someone saved a newer revision first; `currentRevision` is 0 if the setup is gone. */
  | { readonly outcome: 'conflict'; readonly currentRevision: number };

export interface DownloadedBundle {
  readonly meta: BundleMeta;
  readonly ciphertext: Uint8Array;
}

/** Saved setups (T16), free of HTTP. Owns the safe upload order from T14. */
export interface BundleService {
  list(
    userId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): Promise<BundlePage>;
  /** Throws BundleNotFoundError. */
  download(key: BundleKey): Promise<DownloadedBundle>;
  /** Throws InvalidUploadError, or StorageLimitError (T47). */
  upload(input: BundleUploadInput): Promise<UploadResult>;
  /** Throws BundleNotFoundError. */
  delete(key: BundleKey): Promise<void>;
}

export interface BundleServiceDeps {
  readonly bundles: BundleRepository;
  readonly blobs: BlobStore;
  /** Reports cleanup failures; the request itself still succeeds. */
  readonly logError: (message: string, error: unknown) => void;
  /**
   * Whether this save also sweeps files no setup points to (T47); about one save in 50 by
   * default, so the work is spread thin. Injectable for tests.
   */
  readonly shouldSweep?: () => boolean;
}

/** Files left unused for this long are swept: far longer than any upload takes. */
const ORPHAN_AGE_SECONDS = 60 * 60;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function createBundleService(deps: BundleServiceDeps): BundleService {
  const { bundles, blobs, logError } = deps;
  const shouldSweep = deps.shouldSweep ?? (() => Math.random() < 0.02);

  async function sweepQuietly(): Promise<void> {
    try {
      await blobs.deleteOrphans?.(ORPHAN_AGE_SECONDS);
    } catch (error) {
      logError('Could not sweep unused bundle files', error);
    }
  }

  /** A failed cleanup only leaves an unused file behind; never fail the request for it. */
  async function deleteQuietly(userId: string, blobId: string): Promise<void> {
    try {
      await blobs.delete({ userId, blobId });
    } catch (error) {
      logError(`Could not delete unused bundle file ${blobId}`, error);
    }
  }

  function checkUpload(input: BundleUploadInput): void {
    if (input.ciphertext.length < MIN_CIPHERTEXT_BYTES) {
      throw new InvalidUploadError('Body is too small to be an encrypted bundle');
    }
    const isGlobal = input.key.scopeKey === GLOBAL_SCOPE_KEY;
    if (isGlobal && input.nameEnc) {
      throw new InvalidUploadError('The global setup has no project name');
    }
    if (!isGlobal && !input.nameEnc) {
      throw new InvalidUploadError('A project setup needs its encrypted project name');
    }
  }

  return {
    list: (userId, page) => bundles.list(userId, page),

    async download(key) {
      const meta = await bundles.get(key);
      if (!meta) throw new BundleNotFoundError();
      const ciphertext = await blobs.get({ userId: key.userId, blobId: meta.blobId });
      // The foreign key keeps the current file alive, so this means the database is broken.
      if (!ciphertext) throw new Error(`Current file ${meta.blobId} of a saved setup is missing`);
      return { meta, ciphertext };
    },

    async upload(input) {
      checkUpload(input);
      // Integrity: the bytes that arrived must be the bytes the client hashed.
      if (!sameBytes(await sha256(input.ciphertext), input.contentHash)) {
        throw new InvalidUploadError('Content hash does not match the uploaded bytes');
      }

      // 0. Over the account's limits already: refuse before storing anything (T47). The
      // same check runs again inside the save, where it cannot be raced.
      const { userId } = input.key;
      const used = await bundles.usage(userId);
      const current = await bundles.get(input.key);
      if (!current && used.setups >= USER_STORAGE_LIMITS.maxSetups) {
        throw new StorageLimitError(overLimit('setups'));
      }
      const growth = input.ciphertext.length - (current?.sizeBytes ?? 0);
      if (growth > 0 && used.bytes + growth > USER_STORAGE_LIMITS.maxBytes) {
        throw new StorageLimitError(overLimit('bytes'));
      }

      // 1. Store the bytes under a new random id; the current copy is untouched.
      const uploaded = await blobs.put(userId, input.ciphertext);

      let result;
      try {
        // 2. Revision check; on success the setup now points at the new file.
        result = await bundles.putMeta({
          key: input.key,
          expectedRevision: input.expectedRevision,
          nameEnc: input.nameEnc,
          contentHash: input.contentHash,
          formatVersion: input.formatVersion,
          sizeBytes: input.ciphertext.length,
          blobId: uploaded.blobId,
        });
      } catch (error) {
        await deleteQuietly(userId, uploaded.blobId);
        throw error;
      }

      // 3. Delete whichever file is no longer current.
      switch (result.outcome) {
        case 'saved':
          if (result.replacedBlobId) await deleteQuietly(userId, result.replacedBlobId);
          if (shouldSweep()) await sweepQuietly();
          return { outcome: 'stored', meta: result.meta };
        case 'unchanged':
          await deleteQuietly(userId, uploaded.blobId);
          return { outcome: 'stored', meta: result.meta };
        case 'conflict':
          await deleteQuietly(userId, uploaded.blobId);
          return { outcome: 'conflict', currentRevision: result.currentRevision };
        case 'over-limit':
          await deleteQuietly(userId, uploaded.blobId);
          throw new StorageLimitError(result.reason);
      }
    },

    async delete(key) {
      const removed = await bundles.delete(key);
      if (!removed) throw new BundleNotFoundError();
      await deleteQuietly(key.userId, removed.blobId);
    },
  };
}
