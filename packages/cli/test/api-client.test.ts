import { createHash } from 'node:crypto';

import { API_HEADERS, DEFAULT_KDF_PARAMS, type BundleParams } from '@agentnomad/contracts';
import { describe, expect, it } from 'vitest';

import {
  ApiError,
  backoffDelay,
  createHttpApiClient,
  DEFAULT_API_TIMEOUTS,
  DEFAULT_RETRY_POLICY,
  InvalidResponseError,
  NetworkError,
  NotLoggedInError,
  OutcomeUnknownError,
  resolveApiUrl,
  transferTimeoutMs,
  type HttpApiClientOptions,
  type Sleep,
} from '../src/index.ts';

const BASE = new URL('https://api.test');
const TOKEN = 'a'.repeat(43);
const SALT = Buffer.alloc(16, 1).toString('base64');
const AUTH_KEY = Buffer.alloc(32, 2).toString('base64');
const WRAPPED = Buffer.alloc(72, 3).toString('base64');
const SESSION = { sessionToken: TOKEN, expiresAt: '2026-12-24T00:00:00Z' };
const PARAMS: BundleParams = { agent: 'claude-code', scopeKey: 'global' };

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  json({ error: { code, message: `server says ${code}` } }, status, headers);
const health = () => json({ status: 'ok' });
const empty = (status: number) => new Response(null, { status });
const networkDown = () => Promise.reject(new TypeError('fetch failed'));
const timedOut = () =>
  Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

type Step = Response | (() => Promise<Response>);

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

/**
 * A fake server: answers /health with ok (unless `health` steps are given), and every other
 * request with the next step in order. Records every call and every retry wait.
 */
function fakeServer(
  steps: Step[],
  setup: Partial<HttpApiClientOptions> & { health?: Step[] } = {},
) {
  const calls: Call[] = [];
  const waits: number[] = [];
  const healthSteps = setup.health ?? [];
  const next = (queue: Step[], fallback?: () => Response) => {
    const step = queue.shift() ?? fallback?.();
    if (step === undefined) throw new Error('unexpected request');
    return step instanceof Response ? Promise.resolve(step) : step();
  };
  const fakeFetch = ((input: URL, init: RequestInit) => {
    calls.push({ url: input, init });
    return input.pathname === '/health' ? next(healthSteps, health) : next(steps);
  }) as typeof fetch;
  // Retry waits resolve at once; the wake-up notice timer never fires unless a test says so.
  const sleep: Sleep = (ms, signal) => {
    if (!signal) {
      waits.push(ms);
      return Promise.resolve();
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  };
  const client = createHttpApiClient({
    baseUrl: BASE,
    getSessionToken: () => Promise.resolve(TOKEN),
    fetch: fakeFetch,
    sleep,
    random: () => 0,
    ...setup,
  });
  const apiCalls = () => calls.filter((call) => call.url.pathname !== '/health');
  return { client, calls, apiCalls, waits };
}

const loginRequest = { username: 'ahmed', authKey: AUTH_KEY, deviceName: 'laptop' };
const registerRequest = {
  username: 'ahmed',
  kdfSalt: SALT,
  kdfParams: DEFAULT_KDF_PARAMS,
  authKey: AUTH_KEY,
  wrappedDataKey: WRAPPED,
  deviceName: 'laptop',
};

function upload(bytes = new Uint8Array([1, 2, 3, 4])) {
  return {
    ciphertext: bytes,
    expectedRevision: 0,
    contentSha256: sha256Hex(bytes),
    formatVersion: 1,
  };
}

describe('ApiClient: requests and answers', () => {
  it('logs in: posts JSON and returns the checked answer', async () => {
    const { client, apiCalls } = fakeServer([json({ ...SESSION, wrappedDataKey: WRAPPED })]);
    const answer = await client.auth.login(loginRequest);

    expect(answer.wrappedDataKey).toBe(WRAPPED);
    const [call] = apiCalls();
    expect(call?.url.href).toBe('https://api.test/auth/login');
    expect(call?.init.method).toBe('POST');
    expect(JSON.parse(call?.init.body as string)).toEqual(loginRequest);
    expect(call?.init.redirect).toBe('error');
  });

  it('sends the session token only as a Bearer header', async () => {
    const { client, apiCalls } = fakeServer([json({ items: [], nextCursor: null })]);
    await client.bundles.list({ cursor: 'abc', limit: 10 });

    const [call] = apiCalls();
    expect(call?.url.search).toBe('?cursor=abc&limit=10');
    expect((call?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses before any request when not logged in', async () => {
    const { client, calls } = fakeServer([], { getSessionToken: () => Promise.resolve(null) });
    await expect(client.bundles.list()).rejects.toBeInstanceOf(NotLoggedInError);
    expect(calls.filter((call) => call.url.pathname !== '/health')).toHaveLength(0);
  });

  it('turns an API error into ApiError with its code and currentRevision', async () => {
    const { client } = fakeServer([
      json({ error: { code: 'revision_conflict', message: 'newer', currentRevision: 7 } }, 409),
    ]);
    const error = await client.bundles.put(PARAMS, upload()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'revision_conflict', currentRevision: 7 });
  });

  it('rejects an answer that breaks the contract', async () => {
    const { client } = fakeServer([json({ sessionToken: 'short', expiresAt: 'soon' })]);
    await expect(client.auth.login(loginRequest)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects an answer that is not JSON (e.g. a proxy page)', async () => {
    const { client } = fakeServer([new Response('<html>hi</html>', { status: 200 })]);
    await expect(client.auth.prelogin({ username: 'ahmed' })).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it('builds bundle paths only from valid params', async () => {
    const { client } = fakeServer([]);
    await expect(
      client.bundles.get({ agent: 'claude-code', scopeKey: '../../account' }),
    ).rejects.toThrow();
  });
});

describe('ApiClient: bundles', () => {
  it('uploads raw bytes with the revision, hash and format headers', async () => {
    const { client, apiCalls } = fakeServer([
      json({ revision: 1, updatedAt: '2026-09-25T10:00:00Z' }),
    ]);
    const bundle = { ...upload(), nameEnc: 'bmFtZQ==' };
    expect(await client.bundles.put(PARAMS, bundle)).toEqual({
      revision: 1,
      updatedAt: '2026-09-25T10:00:00Z',
    });

    const [call] = apiCalls();
    const headers = call?.init.headers as Record<string, string>;
    expect(call?.init.method).toBe('PUT');
    expect(call?.url.pathname).toBe('/bundles/claude-code/global');
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers[API_HEADERS.expectedRevision]).toBe('0');
    expect(headers[API_HEADERS.contentSha256]).toBe(bundle.contentSha256);
    expect(headers[API_HEADERS.nameEnc]).toBe('bmFtZQ==');
    expect(call?.init.body).toEqual(bundle.ciphertext);
  });

  it('refuses to upload when the hash does not match the bytes', async () => {
    const { client, calls } = fakeServer([]);
    await expect(
      client.bundles.put(PARAMS, { ...upload(), contentSha256: '0'.repeat(64) }),
    ).rejects.toThrow('contentSha256');
    expect(calls).toHaveLength(0);
  });

  it('downloads a bundle and checks it against its SHA-256', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const { client } = fakeServer([
      new Response(bytes, {
        headers: {
          [API_HEADERS.revision]: '3',
          [API_HEADERS.contentSha256]: sha256Hex(bytes),
          [API_HEADERS.formatVersion]: '1',
        },
      }),
    ]);
    expect(await client.bundles.get(PARAMS)).toEqual({
      ciphertext: bytes,
      revision: 3,
      contentSha256: sha256Hex(bytes),
      formatVersion: 1,
      nameEnc: null,
    });
  });

  it('rejects a download damaged on the way', async () => {
    const { client } = fakeServer([
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          [API_HEADERS.revision]: '3',
          [API_HEADERS.contentSha256]: sha256Hex(new Uint8Array([1, 2, 4])),
          [API_HEADERS.formatVersion]: '1',
        },
      }),
    ]);
    await expect(client.bundles.get(PARAMS)).rejects.toThrow('damaged');
  });

  it('rejects an answer larger than any bundle', async () => {
    const { client } = fakeServer([
      new Response(null, { headers: { 'content-length': String(6 * 1024 * 1024) } }),
    ]);
    await expect(client.bundles.get(PARAMS)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('ApiClient: retries', () => {
  it('retries network errors and timeouts with growing waits, then succeeds', async () => {
    const { client, apiCalls, waits } = fakeServer([
      networkDown,
      timedOut,
      json({ items: [], nextCursor: null }),
    ]);
    await client.bundles.list();
    expect(apiCalls()).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('gives up after 3 tries with a NetworkError', async () => {
    const { client, apiCalls } = fakeServer([timedOut, timedOut, timedOut]);
    const error = await client.bundles.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ failure: 'timeout' });
    expect(apiCalls()).toHaveLength(3);
  });

  it('retries 502/503/504 from the host', async () => {
    const { client, apiCalls } = fakeServer([
      empty(502),
      empty(503),
      json({ items: [], nextCursor: null }),
    ]);
    await client.bundles.list();
    expect(apiCalls()).toHaveLength(3);
  });

  it('reports a host outage that lasts as server_unavailable', async () => {
    const { client } = fakeServer([empty(503), empty(503), empty(503)]);
    await expect(client.bundles.list()).rejects.toMatchObject({ failure: 'server_unavailable' });
  });

  it('never retries a 4xx or a 500', async () => {
    for (const answer of [apiError(401, 'unauthorized'), apiError(500, 'internal_error')]) {
      const { client, apiCalls } = fakeServer([answer]);
      await expect(client.bundles.list()).rejects.toBeInstanceOf(ApiError);
      expect(apiCalls()).toHaveLength(1);
    }
  });

  it('resends the same bytes and hash when an upload is retried', async () => {
    const { client, apiCalls } = fakeServer([
      networkDown,
      json({ revision: 1, updatedAt: '2026-09-25T10:00:00Z' }),
    ]);
    const bundle = upload(new Uint8Array([5, 6, 7]));
    await client.bundles.put(PARAMS, bundle);

    const [first, second] = apiCalls();
    expect(second?.init.body).toEqual(first?.init.body);
    expect(second?.init.body).toEqual(bundle.ciphertext);
    const hash = (call?: Call) =>
      (call?.init.headers as Record<string, string>)[API_HEADERS.contentSha256];
    expect(hash(second)).toBe(hash(first));
  });

  it('treats "already deleted" after a lost answer as done', async () => {
    const { client } = fakeServer([networkDown, apiError(404, 'not_found')]);
    await expect(client.bundles.delete(PARAMS)).resolves.toBeUndefined();
  });

  it('reports not_found after a 503: nothing was deleted then (T46)', async () => {
    const { client } = fakeServer([empty(503), apiError(404, 'not_found')]);
    await expect(client.bundles.delete(PARAMS)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('still reports not_found when the first try finds nothing', async () => {
    const { client } = fakeServer([apiError(404, 'not_found')]);
    await expect(client.bundles.delete(PARAMS)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('treats "session gone" after a lost logout answer as done', async () => {
    const { client } = fakeServer([timedOut, apiError(401, 'unauthorized')]);
    await expect(client.auth.logout()).resolves.toBeUndefined();
  });

  it('keeps each retry wait between the base and the cap', () => {
    const waits = [1, 2, 3, 4, 5].map((retry) =>
      backoffDelay(retry, DEFAULT_RETRY_POLICY, () => 0.99),
    );
    expect(waits[0]).toBeGreaterThanOrEqual(500);
    expect(Math.max(...waits)).toBe(4000);
  });
});

describe('ApiClient: requests that are never retried', () => {
  it('register: a lost answer is reported as "result unknown", not retried', async () => {
    const { client, apiCalls } = fakeServer([networkDown]);
    const error = await client.auth.register(registerRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect((error as Error).message).toContain('agentnomad login');
    expect(apiCalls()).toHaveLength(1);
  });

  it('register: a host 502 is also "result unknown"', async () => {
    const { client, apiCalls } = fakeServer([empty(502)]);
    await expect(client.auth.register(registerRequest)).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(apiCalls()).toHaveLength(1);
  });

  it('register: a clear answer is passed on (e.g. username taken)', async () => {
    const { client } = fakeServer([apiError(409, 'username_taken')]);
    await expect(client.auth.register(registerRequest)).rejects.toMatchObject({
      code: 'username_taken',
    });
  });

  it('register: success returns the session', async () => {
    const { client } = fakeServer([json(SESSION, 201)]);
    expect(await client.auth.register(registerRequest)).toEqual(SESSION);
  });

  it('account delete: a timeout is "result unknown", sent once', async () => {
    const { client, apiCalls } = fakeServer([timedOut]);
    const error = await client.auth.deleteAccount({ authKey: AUTH_KEY }).catch((e: unknown) => e);
    expect(error).toMatchObject({ operation: 'delete-account' });
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0]?.init.method).toBe('DELETE');
  });
});

describe('ApiClient: rate limits', () => {
  it('does not retry a 429 and passes on Retry-After', async () => {
    const { client, apiCalls } = fakeServer([
      apiError(429, 'rate_limited', { 'retry-after': '240' }),
    ]);
    const error = await client.auth.login(loginRequest).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 240 });
    expect(apiCalls()).toHaveLength(1);
  });

  it('waits as long as a 503 Retry-After asks, within the cap', async () => {
    const { client, waits } = fakeServer([
      new Response(null, { status: 503, headers: { 'retry-after': '3' } }),
      new Response(null, { status: 503, headers: { 'retry-after': '60' } }),
      json({ items: [], nextCursor: null }),
    ]);
    await client.bundles.list();
    expect(waits).toEqual([3000, 4000]);
  });
});

describe('ApiClient: waking the free server', () => {
  it('checks /health once before the first request', async () => {
    const { client, calls } = fakeServer([
      json({ items: [], nextCursor: null }),
      json({ items: [], nextCursor: null }),
    ]);
    await client.bundles.list();
    await client.bundles.list();
    expect(calls.map((call) => call.url.pathname)).toEqual(['/health', '/bundles', '/bundles']);
  });

  it('gives the first health check the long wake-up timeout', async () => {
    const seen: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = (ms: number) => {
      seen.push(ms);
      return realTimeout(ms);
    };
    AbortSignal.timeout = spy;
    try {
      const { client } = fakeServer([json({ items: [], nextCursor: null })]);
      await client.bundles.list();
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(seen).toEqual([90_000, 30_000]);
  });

  it('gives uploads time by size and downloads time for the largest setup', async () => {
    const seen: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      seen.push(ms);
      return realTimeout(ms);
    };
    const bytes = new Uint8Array(1024 * 1024);
    try {
      const { client } = fakeServer([
        json({ revision: 1, updatedAt: '2026-09-25T10:00:00Z' }),
        apiError(404, 'not_found'),
      ]);
      await client.bundles.put(PARAMS, upload(bytes));
      await client.bundles.get(PARAMS).catch(() => undefined);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    // health, 1 MB upload (60 s + 30 s), download (60 s + 5 × 30 s)
    expect(seen).toEqual([90_000, 90_000, 210_000]);
  });

  it('allows 60 s for a tiny setup and 3.5 min for a 5 MB one', () => {
    expect(transferTimeoutMs(1_000, DEFAULT_API_TIMEOUTS)).toBeLessThan(61_000);
    expect(transferTimeoutMs(5 * 1024 * 1024, DEFAULT_API_TIMEOUTS)).toBe(210_000);
  });

  it('tells the user when the server is slow to wake, and when it is up', async () => {
    const events: string[] = [];
    let wake: (response: Response) => void = () => undefined;
    const { client } = fakeServer([json({ items: [], nextCursor: null })], {
      health: [() => new Promise<Response>((resolve) => (wake = resolve))],
      // The notice timer fires at once in this test.
      sleep: () => Promise.resolve(),
      wakeUp: {
        onWaking: () => events.push('waking'),
        onAwake: () => events.push('awake'),
      },
    });
    const listing = client.bundles.list();
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['waking']);
    wake(health());
    await listing;
    expect(events).toEqual(['waking', 'awake']);
  });

  it('says nothing when the server answers quickly', async () => {
    const events: string[] = [];
    const { client } = fakeServer([json({ items: [], nextCursor: null })], {
      wakeUp: { onWaking: () => events.push('waking'), onAwake: () => events.push('awake') },
    });
    await client.bundles.list();
    expect(events).toEqual([]);
  });

  it('a failed wake-up is not "result unknown" and is tried again next time', async () => {
    const { client, calls } = fakeServer([json(SESSION, 201)], {
      health: [networkDown, networkDown, networkDown],
    });
    const error = await client.auth.register(registerRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(calls.every((call) => call.url.pathname === '/health')).toBe(true);
    expect(await client.auth.register(registerRequest)).toEqual(SESSION);
  });
});

describe('ApiClient: real timeouts', () => {
  it('aborts a request that hangs longer than its timeout', async () => {
    const hangingFetch = ((input: URL, init: RequestInit) =>
      input.pathname === '/health'
        ? Promise.resolve(health())
        : new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          })) as typeof fetch;
    const client = createHttpApiClient({
      baseUrl: BASE,
      getSessionToken: () => Promise.resolve(TOKEN),
      fetch: hangingFetch,
      sleep: () => Promise.resolve(),
      timeouts: { requestMs: 20 },
    });
    await expect(client.bundles.list()).rejects.toMatchObject({ failure: 'timeout' });
  });
});

describe('resolveApiUrl', () => {
  it('uses the hosted API by default', () => {
    expect(resolveApiUrl({}).href).toBe('https://agentnomad-api.onrender.com/');
  });

  it('accepts https and local http', () => {
    expect(resolveApiUrl({ AGENTNOMAD_API_URL: 'https://example.com' }).host).toBe('example.com');
    expect(resolveApiUrl({ AGENTNOMAD_API_URL: 'http://localhost:3000' }).port).toBe('3000');
  });

  it.each([
    'not a url',
    'http://example.com',
    'ftp://example.com',
    'https://user:pw@example.com',
    'https://example.com/api',
    'https://example.com/?x=1',
  ])('refuses %s', (value) => {
    expect(() => resolveApiUrl({ AGENTNOMAD_API_URL: value })).toThrow('AGENTNOMAD_API_URL');
  });
});
