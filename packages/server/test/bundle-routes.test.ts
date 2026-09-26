import { createHash } from 'node:crypto';

import {
  DEFAULT_KDF_PARAMS,
  ErrorResponseSchema,
  GetBundleResponseHeadersSchema,
  ListBundlesResponseSchema,
  MAX_BUNDLE_BYTES,
  PutBundleResponseSchema,
  SessionResponseSchema,
  USER_STORAGE_LIMITS,
} from '@agentnomad/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RATE_LIMITS } from '../src/rate-limit/rate-limiter.ts';
import { createTestApp, postJson, type TestApp } from './support/app.ts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const PROJECT = 'a'.repeat(64);
const GLOBAL_PATH = '/bundles/claude-code/global';
const PROJECT_PATH = `/bundles/claude-code/${PROJECT}`;

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.database.close();
});

async function register(username = 'ahmed'): Promise<string> {
  const res = await t.app.request(
    '/auth/register',
    postJson({
      username,
      kdfSalt: b64(bytes(16, 1)),
      kdfParams: DEFAULT_KDF_PARAMS,
      authKey: b64(bytes(32, 2)),
      wrappedDataKey: b64(bytes(72, 3)),
      deviceName: 'laptop',
    }),
  );
  return SessionResponseSchema.parse(await res.json()).sessionToken;
}

interface PutOptions {
  readonly expected: number;
  readonly body: Uint8Array;
  readonly path?: string;
  readonly nameEnc?: Uint8Array;
  readonly hash?: string;
  readonly contentType?: string;
  readonly omitHeader?: string;
}

async function put(token: string, options: PutOptions): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': options.contentType ?? 'application/octet-stream',
    'x-an-expected-revision': String(options.expected),
    'x-an-content-sha256': options.hash ?? sha256Hex(options.body),
    'x-an-format-version': '1',
    ...(options.nameEnc && { 'x-an-name-enc': b64(options.nameEnc) }),
  };
  return t.app.request(options.path ?? GLOBAL_PATH, {
    method: 'PUT',
    body: options.body,
    headers: Object.fromEntries(
      Object.entries(headers).filter(([name]) => name !== options.omitHeader),
    ),
  });
}

const as = (token: string, method = 'GET') => ({
  method,
  headers: { authorization: `Bearer ${token}` },
});

async function error(res: Response) {
  return ErrorResponseSchema.parse(await res.json()).error;
}

async function fileCount(): Promise<number> {
  const { rows } = await t.database.client.query<{ n: number }>(
    'select count(*)::int as n from bundle_blobs',
  );
  return rows[0]?.n ?? -1;
}

describe('access', () => {
  it.each([
    ['GET', '/bundles'],
    ['GET', GLOBAL_PATH],
    ['PUT', GLOBAL_PATH],
    ['DELETE', GLOBAL_PATH],
  ])('%s %s needs a session', async (method, path) => {
    const res = await t.app.request(path, { method });
    expect(res.status).toBe(401);
    expect((await error(res)).code).toBe('unauthorized');
  });

  it("never shows, returns or deletes another user's setup", async () => {
    const owner = await register('owner');
    const other = await register('other');
    expect((await put(owner, { expected: 0, body: bytes(64, 1) })).status).toBe(200);

    expect((await t.app.request(GLOBAL_PATH, as(other))).status).toBe(404);
    expect((await t.app.request(GLOBAL_PATH, as(other, 'DELETE'))).status).toBe(404);
    const list = ListBundlesResponseSchema.parse(
      await (await t.app.request('/bundles', as(other))).json(),
    );
    expect(list.items).toEqual([]);
    expect((await t.app.request(GLOBAL_PATH, as(owner))).status).toBe(200);
  });
});

describe('PUT then GET', () => {
  it('saves raw bytes and returns them byte for byte with their headers', async () => {
    const token = await register();
    const body = bytes(1000, 7);
    const res = await put(token, { expected: 0, body });
    expect(res.status).toBe(200);
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(1);

    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    const headers = GetBundleResponseHeadersSchema.parse(Object.fromEntries(got.headers));
    expect(headers['x-an-revision']).toBe(1);
    expect(headers['x-an-content-sha256']).toBe(sha256Hex(body));
    expect(headers['x-an-format-version']).toBe(1);
    expect(headers['x-an-name-enc']).toBeUndefined();
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
  });

  it('returns 404 for a setup that was never saved', async () => {
    const token = await register();
    const res = await t.app.request(GLOBAL_PATH, as(token));
    expect(res.status).toBe(404);
    expect((await error(res)).code).toBe('not_found');
  });

  it('keeps project names encrypted and returns them with the bytes', async () => {
    const token = await register();
    const nameEnc = bytes(60, 9);
    const res = await put(token, { expected: 0, body: bytes(64, 1), path: PROJECT_PATH, nameEnc });
    expect(res.status).toBe(200);
    const got = await t.app.request(PROJECT_PATH, as(token));
    expect(got.headers.get('x-an-name-enc')).toBe(b64(nameEnc));
  });
});

describe('PUT revision rules', () => {
  it('saves the next revision and deletes the file it replaced', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    const res = await put(token, { expected: 1, body: bytes(64, 2) });
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(2);
    expect(await fileCount()).toBe(1);
    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes(64, 2));
  });

  it('refuses a push from an old revision with 409 and the current revision', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    await put(token, { expected: 1, body: bytes(64, 2) });

    const stale = await put(token, { expected: 1, body: bytes(64, 3) });
    expect(stale.status).toBe(409);
    expect(await error(stale)).toMatchObject({ code: 'revision_conflict', currentRevision: 2 });
    expect(await fileCount()).toBe(1);
    const got = await t.app.request(GLOBAL_PATH, as(token));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes(64, 2));
  });

  it('answers a repeated PUT with the same bytes as success, without a new revision', async () => {
    const token = await register();
    const first = await put(token, { expected: 0, body: bytes(64, 1) });
    const retry = await put(token, { expected: 0, body: bytes(64, 1) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await fileCount()).toBe(1);
  });

  it('reports 409 without a revision when the setup was deleted meanwhile', async () => {
    const token = await register();
    const res = await put(token, { expected: 3, body: bytes(64, 1) });
    expect(res.status).toBe(409);
    const body = await error(res);
    expect(body.code).toBe('revision_conflict');
    expect(body.currentRevision).toBeUndefined();
    expect(await fileCount()).toBe(0);
  });
});

describe('PUT checks', () => {
  it('refuses bytes that do not match their content hash, keeping nothing', async () => {
    const token = await register();
    const res = await put(token, { expected: 0, body: bytes(64, 1), hash: 'b'.repeat(64) });
    expect(res.status).toBe(400);
    expect(await fileCount()).toBe(0);
  });

  it('accepts exactly 5 MB and refuses one byte more with 413', async () => {
    const token = await register();
    const max = await put(token, { expected: 0, body: bytes(MAX_BUNDLE_BYTES, 1) });
    expect(max.status).toBe(200);
    const over = await put(token, { expected: 1, body: bytes(MAX_BUNDLE_BYTES + 1, 2) });
    expect(over.status).toBe(413);
    expect((await error(over)).code).toBe('payload_too_large');
  });

  it.each([
    ['a body too small to be encrypted', { body: bytes(39, 1) }],
    ['a JSON content type', { body: bytes(64, 1), contentType: 'application/json' }],
    ['a missing revision header', { body: bytes(64, 1), omitHeader: 'x-an-expected-revision' }],
    ['a project name on the global setup', { body: bytes(64, 1), nameEnc: bytes(40, 1) }],
    ['a project setup without its name', { body: bytes(64, 1), path: PROJECT_PATH }],
    ['an invalid agent', { body: bytes(64, 1), path: '/bundles/Claude/global' }],
    ['an invalid scope key', { body: bytes(64, 1), path: '/bundles/claude-code/my-project' }],
  ])('refuses %s with 400', async (_, options) => {
    const token = await register();
    const res = await put(token, { expected: 0, ...options });
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe('bad_request');
    expect(await fileCount()).toBe(0);
  });
});

describe('GET /bundles', () => {
  it('lists metadata only, newest first, page by page', async () => {
    const token = await register();
    for (let index = 0; index < 5; index++) {
      const scopeKey = index.toString(16).padStart(64, '0');
      await put(token, {
        expected: 0,
        body: bytes(64, index),
        path: `/bundles/claude-code/${scopeKey}`,
        nameEnc: bytes(40, index),
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = ListBundlesResponseSchema.parse(
        await (await t.app.request(`/bundles${query}`, as(token))).json(),
      );
      seen.push(...page.items.map((item) => item.scopeKey));
      expect(page.items.every((item) => item.nameEnc !== null && item.sizeBytes === 64)).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
  });

  it.each(['?cursor=bad-cursor', '?limit=0', '?limit=101'])(
    'refuses %s with 400',
    async (query) => {
      const token = await register();
      const res = await t.app.request(`/bundles${query}`, as(token));
      expect(res.status).toBe(400);
      expect((await error(res)).code).toBe('bad_request');
    },
  );
});

describe('DELETE', () => {
  it('removes the setup and its file; a second delete is 404', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(204);
    expect((await t.app.request(GLOBAL_PATH, as(token))).status).toBe(404);
    expect(await fileCount()).toBe(0);
    expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(404);
  });

  it('lets the setup be saved fresh again afterwards', async () => {
    const token = await register();
    await put(token, { expected: 0, body: bytes(64, 1) });
    await t.app.request(GLOBAL_PATH, as(token, 'DELETE'));
    const res = await put(token, { expected: 0, body: bytes(64, 2) });
    expect(PutBundleResponseSchema.parse(await res.json()).revision).toBe(1);
  });
});

describe('limits per account (T47)', () => {
  it(`refuses a new setup past ${String(USER_STORAGE_LIMITS.maxSetups)} with 413 and says why, storing nothing`, async () => {
    const token = await register();
    for (let index = 0; index < USER_STORAGE_LIMITS.maxSetups; index++) {
      const path = `/bundles/claude-code/${index.toString(16).padStart(64, '0')}`;
      const res = await put(token, {
        expected: 0,
        body: bytes(64, 1),
        path,
        nameEnc: bytes(40, 1),
      });
      expect(res.status).toBe(200);
    }
    const files = await fileCount();
    const res = await put(token, { expected: 0, body: bytes(64, 2) });
    expect(res.status).toBe(413);
    const body = await error(res);
    expect(body.code).toBe('payload_too_large');
    expect(body.message).toContain(`at most ${String(USER_STORAGE_LIMITS.maxSetups)} saved setups`);
    expect(await fileCount()).toBe(files);
  });

  it(`allows ${String(RATE_LIMITS.writesPerAccount.limit)} saves and deletes an hour per account, then 429`, async () => {
    const token = await register();
    for (let index = 0; index < RATE_LIMITS.writesPerAccount.limit; index++) {
      expect((await t.app.request(GLOBAL_PATH, as(token, 'DELETE'))).status).toBe(404);
    }
    const res = await t.app.request(GLOBAL_PATH, as(token, 'DELETE'));
    expect(res.status).toBe(429);
    expect((await error(res)).code).toBe('rate_limited');
    // Reading is not limited this way.
    expect((await t.app.request('/bundles', as(token))).status).toBe(200);
  });
});
