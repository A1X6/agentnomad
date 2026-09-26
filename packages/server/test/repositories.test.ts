import { MAX_BUNDLE_BYTES, USER_STORAGE_LIMITS, type KdfParams } from '@agentnomad/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BlobInUseError,
  InvalidCursorError,
  UsernameTakenError,
  createBundleRepository,
  createPostgresBlobStore,
  createSessionRepository,
  createUserRepository,
  sessions,
  type BlobStore,
  type BundleKey,
  type BundleMetaWrite,
  type BundleRepository,
  type NewUser,
  type SessionRepository,
  type UserRepository,
} from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './support/database.ts';

const kdfParams: KdfParams = {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  passes: 3,
  parallelism: 1,
};

const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);
const hash = (fill: number) => bytes(32, fill);

const newUser = (username: string): NewUser => ({
  username,
  kdfSalt: bytes(16),
  kdfParams,
  authHash: 'auth-hash',
  wrappedDataKey: bytes(72),
});

let database: TestDatabase;
let userRepo: UserRepository;
let sessionRepo: SessionRepository;
let bundleRepo: BundleRepository;
let blobs: BlobStore;

beforeEach(async () => {
  database = await createTestDatabase();
  userRepo = createUserRepository(database.db);
  sessionRepo = createSessionRepository(database.db);
  bundleRepo = createBundleRepository(database.db);
  blobs = createPostgresBlobStore(database.db);
});

afterEach(async () => {
  await database.close();
});

describe('UserRepository', () => {
  it('creates a user and finds it by username and by id', async () => {
    const created = await userRepo.create(newUser('ahmed'));
    expect(created.username).toBe('ahmed');
    expect(created.kdfSalt).toEqual(bytes(16));
    expect(created.kdfParams).toEqual(kdfParams);
    expect(await userRepo.findByUsername('ahmed')).toEqual(created);
    expect(await userRepo.findById(created.id)).toEqual(created);
  });

  it('returns null for an unknown user', async () => {
    expect(await userRepo.findByUsername('nobody')).toBeNull();
    expect(await userRepo.findById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('throws UsernameTakenError for a taken username', async () => {
    await userRepo.create(newUser('ahmed'));
    await expect(userRepo.create(newUser('ahmed'))).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it('deletes a user with their sessions, setups and files', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const session = await sessionRepo.create({
      userId: user.id,
      tokenHash: 'token',
      deviceName: 'laptop',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, blob.blobId, 1));

    await userRepo.delete(user.id);

    expect(await userRepo.findById(user.id)).toBeNull();
    expect(await sessionRepo.findByTokenHash(session.tokenHash)).toBeNull();
    expect(await bundleRepo.get(globalKey(user.id))).toBeNull();
    expect(await blobs.get(blob)).toBeNull();
  });
});

describe('SessionRepository', () => {
  it('finds a live session by its token hash and forgets it after delete', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const session = await sessionRepo.create({
      userId: user.id,
      tokenHash: 'token',
      deviceName: 'laptop',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await sessionRepo.findByTokenHash('token')).toEqual(session);
    await sessionRepo.delete(session.id);
    expect(await sessionRepo.findByTokenHash('token')).toBeNull();
  });

  it("deletes only this user's expired and idle sessions", async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const other = await userRepo.create(newUser('other'));
    const day = 24 * 60 * 60 * 1000;
    const make = (userId: string, tokenHash: string, expiresInMs: number) =>
      sessionRepo.create({
        userId,
        tokenHash,
        deviceName: 'laptop',
        expiresAt: new Date(Date.now() + expiresInMs),
      });
    await make(user.id, 'live', day);
    await make(user.id, 'expired', -1000);
    const idle = await make(user.id, 'idle', 60 * day);
    await make(other.id, 'other-expired', -1000);
    await database.db
      .update(sessions)
      .set({ lastUsedAt: new Date(Date.now() - 31 * day) })
      .where(eq(sessions.id, idle.id));

    await sessionRepo.deleteStale(user.id, 30 * day);

    const left = await database.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
    expect(left.map((row) => row.tokenHash).sort()).toEqual(['live', 'other-expired']);
  });

  it('ignores an expired session', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    await sessionRepo.create({
      userId: user.id,
      tokenHash: 'old',
      deviceName: 'laptop',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await sessionRepo.findByTokenHash('old')).toBeNull();
  });
});

const globalKey = (userId: string): BundleKey => ({
  userId,
  agent: 'claude-code',
  scopeKey: 'global',
});

function write(
  key: Partial<BundleKey> & { userId: string },
  expectedRevision: number,
  blobId: string,
  hashFill: number,
): BundleMetaWrite {
  return {
    key: { ...globalKey(key.userId), ...key },
    expectedRevision,
    nameEnc: null,
    contentHash: hash(hashFill),
    formatVersion: 1,
    sizeBytes: 40,
    blobId,
  };
}

describe('BlobStore (Postgres)', () => {
  it('stores bytes under a new id each time and reads them back', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const first = await blobs.put(user.id, bytes(40, 1));
    const second = await blobs.put(user.id, bytes(40, 1));
    expect(first.blobId).not.toBe(second.blobId);
    const read = await blobs.get(first);
    expect(read).toBeInstanceOf(Uint8Array);
    expect(read).toEqual(bytes(40, 1));
  });

  it("never returns another user's file", async () => {
    const owner = await userRepo.create(newUser('owner'));
    const other = await userRepo.create(newUser('other'));
    const blob = await blobs.put(owner.id, bytes(40));
    expect(await blobs.get({ userId: other.id, blobId: blob.blobId })).toBeNull();
    await blobs.delete({ userId: other.id, blobId: blob.blobId });
    expect(await blobs.get(blob)).toEqual(bytes(40));
  });

  it('does nothing when deleting a file that is already gone', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const blob = await blobs.put(user.id, bytes(40));
    await blobs.delete(blob);
    await expect(blobs.delete(blob)).resolves.toBeUndefined();
  });

  it('throws BlobInUseError instead of deleting the current file of a setup', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, blob.blobId, 1));
    await expect(blobs.delete(blob)).rejects.toBeInstanceOf(BlobInUseError);
    expect(await blobs.get(blob)).toEqual(bytes(40));
  });
});

describe('BundleRepository.putMeta', () => {
  it('saves a first revision and points it at the uploaded file', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const blob = await blobs.put(user.id, bytes(40));
    const result = await bundleRepo.putMeta(write({ userId: user.id }, 0, blob.blobId, 1));
    expect(result).toMatchObject({ outcome: 'saved', replacedBlobId: null });
    expect(result.outcome === 'saved' && result.meta).toMatchObject({
      revision: 1,
      blobId: blob.blobId,
      contentHash: hash(1),
    });
  });

  it('saves the next revision and reports the file it replaced', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const first = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, first.blobId, 1));
    const second = await blobs.put(user.id, bytes(40, 2));
    const result = await bundleRepo.putMeta(write({ userId: user.id }, 1, second.blobId, 2));
    expect(result).toMatchObject({ outcome: 'saved', replacedBlobId: first.blobId });
    expect((await bundleRepo.get(globalKey(user.id)))?.revision).toBe(2);
  });

  it('refuses a save based on an old revision (conflict)', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const first = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, first.blobId, 1));
    const second = await blobs.put(user.id, bytes(40, 2));
    await bundleRepo.putMeta(write({ userId: user.id }, 1, second.blobId, 2));

    const stale = await blobs.put(user.id, bytes(40, 3));
    const result = await bundleRepo.putMeta(write({ userId: user.id }, 1, stale.blobId, 3));
    expect(result).toEqual({ outcome: 'conflict', currentRevision: 2 });
    expect((await bundleRepo.get(globalKey(user.id)))?.blobId).toBe(second.blobId);
  });

  it('refuses a "must not exist yet" save when the setup exists, and vice versa', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const missing = await blobs.put(user.id, bytes(40));
    expect(await bundleRepo.putMeta(write({ userId: user.id }, 3, missing.blobId, 1))).toEqual({
      outcome: 'conflict',
      currentRevision: 0,
    });

    await bundleRepo.putMeta(write({ userId: user.id }, 0, missing.blobId, 1));
    const again = await blobs.put(user.id, bytes(40, 2));
    expect(await bundleRepo.putMeta(write({ userId: user.id }, 0, again.blobId, 2))).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
  });

  it('treats a retry of a save that already went through as unchanged', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const upload = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, upload.blobId, 1));

    // The response was lost; the CLI sends the same bytes again (a new file id).
    const retry = await blobs.put(user.id, bytes(40));
    const result = await bundleRepo.putMeta(write({ userId: user.id }, 0, retry.blobId, 1));
    expect(result).toMatchObject({ outcome: 'unchanged', meta: { revision: 1 } });
    expect((await bundleRepo.get(globalKey(user.id)))?.blobId).toBe(upload.blobId);
  });

  it('keeps separate setups per agent and scope', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const global = await blobs.put(user.id, bytes(40));
    const project = await blobs.put(user.id, bytes(40));
    const projectKey = { userId: user.id, scopeKey: 'a'.repeat(64) };
    await bundleRepo.putMeta(write({ userId: user.id }, 0, global.blobId, 1));
    const result = await bundleRepo.putMeta(write(projectKey, 0, project.blobId, 2));
    expect(result.outcome).toBe('saved');
  });

  it('never loses the saved file when two PCs push at the same moment', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const start = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, start.blobId, 1));

    // Both PCs saw revision 1 and upload before either revision check runs.
    const fromA = await blobs.put(user.id, bytes(40, 0xa));
    const fromB = await blobs.put(user.id, bytes(40, 0xb));

    const resultA = await bundleRepo.putMeta(write({ userId: user.id }, 1, fromA.blobId, 0xa));
    const resultB = await bundleRepo.putMeta(write({ userId: user.id }, 1, fromB.blobId, 0xb));
    expect(resultA).toMatchObject({ outcome: 'saved', replacedBlobId: start.blobId });
    expect(resultB).toEqual({ outcome: 'conflict', currentRevision: 2 });

    // Each follows the upload order: A deletes the file it replaced, B deletes its own.
    if (resultA.outcome === 'saved' && resultA.replacedBlobId) {
      await blobs.delete({ userId: user.id, blobId: resultA.replacedBlobId });
    }
    await blobs.delete(fromB);

    const current = await bundleRepo.get(globalKey(user.id));
    expect(current?.blobId).toBe(fromA.blobId);
    expect(await blobs.get({ userId: user.id, blobId: fromA.blobId })).toEqual(bytes(40, 0xa));
    expect(await blobs.get(start)).toBeNull();
    expect(await blobs.get(fromB)).toBeNull();
  });
});

describe('storage limits per account (T47)', () => {
  it(`refuses a new setup past ${String(USER_STORAGE_LIMITS.maxSetups)}, never an update`, async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const scopeKey = (index: number) => index.toString(16).padStart(64, '0');
    for (let index = 0; index < USER_STORAGE_LIMITS.maxSetups; index++) {
      const blob = await blobs.put(user.id, bytes(40));
      await bundleRepo.putMeta(
        write({ userId: user.id, scopeKey: scopeKey(index) }, 0, blob.blobId, 1),
      );
    }
    const one = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(
        write({ userId: user.id, scopeKey: scopeKey(999) }, 0, one.blobId, 1),
      ),
    ).toMatchObject({ outcome: 'over-limit' });
    // A new revision of an existing setup still saves.
    const update = await blobs.put(user.id, bytes(40, 2));
    expect(
      await bundleRepo.putMeta(
        write({ userId: user.id, scopeKey: scopeKey(0) }, 1, update.blobId, 2),
      ),
    ).toMatchObject({ outcome: 'saved' });
    expect(await bundleRepo.usage(user.id)).toEqual({
      setups: USER_STORAGE_LIMITS.maxSetups,
      bytes: 40 * USER_STORAGE_LIMITS.maxSetups,
    });
  });

  it('refuses growing past the byte limit, but never a save that does not grow', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const big = (key: Partial<BundleKey>, revision: number, blobId: string, size: number) => ({
      ...write({ userId: user.id, ...key }, revision, blobId, revision + 1),
      sizeBytes: size,
    });
    // Each setup is at most 5 MB, so the limit is reached with full ones.
    const full = Math.floor(USER_STORAGE_LIMITS.maxBytes / MAX_BUNDLE_BYTES);
    const scopeKey = (index: number) => index.toString(16).padStart(64, '0');
    for (let index = 0; index < full; index++) {
      const blob = await blobs.put(user.id, bytes(40));
      await bundleRepo.putMeta(
        big({ scopeKey: scopeKey(index) }, 0, blob.blobId, MAX_BUNDLE_BYTES),
      );
    }
    const extra = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKey(999) }, 0, extra.blobId, 40)),
    ).toMatchObject({
      outcome: 'over-limit',
    });
    // The same size again, or smaller: always saved, so nobody gets stuck at the limit.
    const same = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKey(0) }, 1, same.blobId, MAX_BUNDLE_BYTES)),
    ).toMatchObject({ outcome: 'saved' });
    const smaller = await blobs.put(user.id, bytes(40));
    expect(
      await bundleRepo.putMeta(big({ scopeKey: scopeKey(1) }, 1, smaller.blobId, 40)),
    ).toMatchObject({
      outcome: 'saved',
    });
  });
});

describe('BlobStore.deleteOrphans (T47)', () => {
  it('deletes old files no setup points to, and nothing else', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const current = await blobs.put(user.id, bytes(40, 1));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, current.blobId, 1));
    const orphan = await blobs.put(user.id, bytes(40, 2));
    const fresh = await blobs.put(user.id, bytes(40, 3));
    await database.db.execute(
      sql`update bundle_blobs set created_at = now() - interval '2 hours' where id in (${current.blobId}, ${orphan.blobId})`,
    );
    expect(await blobs.deleteOrphans?.(60 * 60)).toBe(1);
    expect(await blobs.get(orphan)).toBeNull();
    expect(await blobs.get(current)).not.toBeNull();
    expect(await blobs.get(fresh)).not.toBeNull();
  });
});

describe('BundleRepository.list', () => {
  async function saveSetups(userId: string, count: number) {
    for (let index = 0; index < count; index++) {
      const blob = await blobs.put(userId, bytes(40));
      await bundleRepo.putMeta(
        write({ userId, scopeKey: index.toString(16).padStart(64, '0') }, 0, blob.blobId, 1),
      );
    }
  }

  it('lists newest first, one page at a time, with no gaps or repeats', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    await saveSetups(user.id, 7);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await bundleRepo.list(user.id, { limit: 3, ...(cursor && { cursor }) });
      seen.push(...page.items.map((item) => item.scopeKey));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const all = await bundleRepo.list(user.id, { limit: 100 });
    expect(all.items.map((item) => item.scopeKey)).toEqual(seen);
    const times = all.items.map((item) => item.updatedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all.nextCursor).toBeNull();
  });

  it('pages correctly when several setups share the exact same time', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    await saveSetups(user.id, 5);
    await database.client.query(`update bundles set updated_at = '2026-09-25 10:00:00.123456+00'`);

    const first = await bundleRepo.list(user.id, { limit: 2 });
    const second = await bundleRepo.list(user.id, { limit: 2, cursor: first.nextCursor ?? '' });
    const third = await bundleRepo.list(user.id, { limit: 2, cursor: second.nextCursor ?? '' });
    const keys = [...first.items, ...second.items, ...third.items].map((item) => item.scopeKey);
    expect(new Set(keys).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("lists only the user's own setups", async () => {
    const owner = await userRepo.create(newUser('owner'));
    const other = await userRepo.create(newUser('other'));
    await saveSetups(owner.id, 2);
    expect((await bundleRepo.list(other.id, { limit: 10 })).items).toEqual([]);
  });

  it.each(['not-a-cursor', 'W10', Buffer.from('["x","y"]').toString('base64url')])(
    'throws InvalidCursorError for cursor %j',
    async (cursor) => {
      const user = await userRepo.create(newUser('ahmed'));
      await expect(bundleRepo.list(user.id, { limit: 3, cursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    },
  );
});

describe('BundleRepository.delete', () => {
  it('returns what it removed, so the file can be deleted next', async () => {
    const user = await userRepo.create(newUser('ahmed'));
    const blob = await blobs.put(user.id, bytes(40));
    await bundleRepo.putMeta(write({ userId: user.id }, 0, blob.blobId, 1));

    const removed = await bundleRepo.delete(globalKey(user.id));
    expect(removed?.blobId).toBe(blob.blobId);
    await blobs.delete(blob);
    expect(await blobs.get(blob)).toBeNull();
    expect(await bundleRepo.delete(globalKey(user.id))).toBeNull();
  });
});
