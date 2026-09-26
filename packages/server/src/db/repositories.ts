import type { AgentId, KdfParams, ScopeKey, Username } from '@agentnomad/contracts';

/** A stored account. Holds nothing that can decrypt the user's data. */
export interface UserRecord {
  readonly id: string;
  readonly username: Username;
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: KdfParams;
  /** Server-side hash of the auth key; the auth key itself is never stored. */
  readonly authHash: string;
  /** The data key, locked with the user's password key. */
  readonly wrappedDataKey: Uint8Array;
  readonly createdAt: Date;
}

export type NewUser = Omit<UserRecord, 'id' | 'createdAt'>;

/** Register with a username someone already has. */
export class UsernameTakenError extends Error {
  constructor() {
    super('That username is taken');
    this.name = 'UsernameTakenError';
  }
}

/** A list cursor that was not produced by this server (or was changed). */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/** Accounts (T14). */
export interface UserRepository {
  findByUsername(username: Username): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Throws UsernameTakenError when the username is taken. */
  create(user: NewUser): Promise<UserRecord>;
  /** Removes the user; their sessions and bundles go with them. */
  delete(id: string): Promise<void>;
}

/** A login on one device. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  /** Hash of the session token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly deviceName: string;
  /** Hard limit: the session ends here however often it is used. */
  readonly expiresAt: Date;
  /** For the idle timeout (T15). */
  readonly lastUsedAt: Date;
  readonly createdAt: Date;
}

export type NewSession = Omit<SessionRecord, 'id' | 'createdAt' | 'lastUsedAt'>;

/** Sessions (T14). */
export interface SessionRepository {
  create(session: NewSession): Promise<SessionRecord>;
  /** Returns only sessions that have not expired. */
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Records that the session was just used. */
  touch(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Deletes the user's sessions that can never be used again: expired, or unused for longer
   * than `idleTimeoutMs`. Their tokens are gone (e.g. logged out without internet), so
   * nothing else would ever remove them.
   */
  deleteStale(userId: string, idleTimeoutMs: number): Promise<void>;
}

/** Identifies one saved setup: one user, one agent, one scope. */
export interface BundleKey {
  readonly userId: string;
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
}

/** Everything about a saved setup except its encrypted bytes (those live in the BlobStore). */
export interface BundleMeta {
  readonly agent: AgentId;
  readonly scopeKey: ScopeKey;
  readonly nameEnc: Uint8Array | null;
  readonly contentHash: Uint8Array;
  readonly formatVersion: number;
  readonly revision: number;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
  /** The BlobStore file holding this revision's bytes. Internal: never sent to clients. */
  readonly blobId: string;
}

/** Metadata for a new revision. The bytes are written to the BlobStore first. */
export interface BundleMetaWrite {
  readonly key: BundleKey;
  /** Revision the client last saw; `0` means "must not exist yet". */
  readonly expectedRevision: number;
  readonly nameEnc: Uint8Array | null;
  readonly contentHash: Uint8Array;
  readonly formatVersion: number;
  readonly sizeBytes: number;
  /** The file just uploaded with BlobStore.put. */
  readonly blobId: string;
}

export type PutMetaResult =
  /**
   * Stored as a new revision (`expectedRevision + 1`), now pointing at the new file.
   * `replacedBlobId` is the previous revision's file, to delete; `null` on a first save.
   */
  | { readonly outcome: 'saved'; readonly meta: BundleMeta; readonly replacedBlobId: string | null }
  /**
   * The same bytes (same content hash) are already the current revision: a retry of a
   * save that went through, or an identical push. Nothing changed; delete the new file.
   */
  | { readonly outcome: 'unchanged'; readonly meta: BundleMeta }
  /** Someone saved a newer revision first. Nothing changed; delete the new file. */
  | { readonly outcome: 'conflict'; readonly currentRevision: number }
  /** Saving it would take the account past its storage limits (T47). Nothing changed. */
  | { readonly outcome: 'over-limit'; readonly reason: string };

export interface BundlePage {
  readonly items: readonly BundleMeta[];
  readonly nextCursor: string | null;
}

/** Saved-setup metadata with the revision check, done atomically (T14, T16). */
export interface BundleRepository {
  /**
   * Metadata only, newest first, one page at a time. Throws InvalidCursorError for a cursor
   * this server did not produce.
   */
  list(
    userId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): Promise<BundlePage>;
  get(key: BundleKey): Promise<BundleMeta | null>;
  /**
   * Saves the metadata of a new revision. Checked in the same transaction: the revision
   * and the account's storage limits (T47).
   */
  putMeta(write: BundleMetaWrite): Promise<PutMetaResult>;
  /** How many setups the user keeps and their encrypted bytes together (T47). */
  usage(userId: string): Promise<{ readonly setups: number; readonly bytes: number }>;
  /** Returns what was removed (so its file can be deleted next), or `null` if nothing was. */
  delete(key: BundleKey): Promise<BundleMeta | null>;
}
