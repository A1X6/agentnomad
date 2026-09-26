import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { BlobRef, BlobStore, PutMetaResult } from '../src/index.ts';

/** In-memory BlobStore, the kind of fake later route tests will use. */
function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  const id = (ref: BlobRef) => `${ref.userId}/${ref.blobId}`;
  return {
    put: (userId, bytes) => {
      const ref = { userId, blobId: randomUUID() };
      blobs.set(id(ref), bytes);
      return Promise.resolve(ref);
    },
    get: (ref) => Promise.resolve(blobs.get(id(ref)) ?? null),
    delete: (ref) => {
      blobs.delete(id(ref));
      return Promise.resolve();
    },
  };
}

/** What a PUT route does with each repository outcome. */
function statusFor(result: PutMetaResult): number {
  switch (result.outcome) {
    case 'saved':
    case 'unchanged':
      return 200;
    case 'conflict':
      return 409;
    case 'over-limit':
      return 413;
  }
}

describe('server interfaces', () => {
  it('a BlobStore gives every upload its own id', async () => {
    const store = memoryBlobStore();
    const first = await store.put('u1', new Uint8Array([1, 2, 3]));
    const second = await store.put('u1', new Uint8Array([4]));
    expect(first.blobId).not.toBe(second.blobId);
    expect(await store.get(first)).toEqual(new Uint8Array([1, 2, 3]));
    await store.delete(first);
    expect(await store.get(first)).toBeNull();
    expect(await store.get(second)).toEqual(new Uint8Array([4]));
  });

  it('every repository put outcome maps to an HTTP status', () => {
    expect(statusFor({ outcome: 'conflict', currentRevision: 4 })).toBe(409);
  });
});
