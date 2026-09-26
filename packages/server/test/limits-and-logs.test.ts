import {
  DEFAULT_KDF_PARAMS,
  ErrorResponseSchema,
  SessionResponseSchema,
} from '@agentnomad/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeError } from '../src/logging/logger.ts';
import { RATE_LIMITS } from '../src/rate-limit/rate-limiter.ts';
import { createServerFromEnv } from '../src/server.ts';
import { TEST_IP_HEADER, createTestApp, postJson, type TestApp } from './support/app.ts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
const goodKey = b64(bytes(32, 1));
const badKey = b64(bytes(32, 2));

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.database.close();
});

const fromIp = (ip: string) => ({ [TEST_IP_HEADER]: ip });

async function register(username: string, ip = '198.51.100.1'): Promise<Response> {
  return t.app.request(
    '/auth/register',
    postJson(
      {
        username,
        kdfSalt: b64(bytes(16, 1)),
        kdfParams: DEFAULT_KDF_PARAMS,
        authKey: goodKey,
        wrappedDataKey: b64(bytes(72, 3)),
        deviceName: 'laptop',
      },
      fromIp(ip),
    ),
  );
}

async function login(username: string, authKey: string, ip = '198.51.100.1'): Promise<Response> {
  return t.app.request(
    '/auth/login',
    postJson({ username, authKey, deviceName: 'pc' }, fromIp(ip)),
  );
}

async function expectRateLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(ErrorResponseSchema.parse(await res.json()).error.code).toBe('rate_limited');
  expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
}

describe('per-IP limits', () => {
  it(`allows ${String(RATE_LIMITS.authPerIp.limit)} auth requests a minute per IP, then 429`, async () => {
    const prelogin = (ip: string) =>
      t.app.request('/auth/prelogin', postJson({ username: 'ghost' }, fromIp(ip)));
    for (let index = 0; index < RATE_LIMITS.authPerIp.limit; index++) {
      expect((await prelogin('198.51.100.1')).status).toBe(200);
    }
    await expectRateLimited(await prelogin('198.51.100.1'));
    expect((await prelogin('198.51.100.2')).status).toBe(200);
  });

  it(`allows ${String(RATE_LIMITS.registerPerIp.limit)} registrations an hour per IP`, async () => {
    for (let index = 0; index < RATE_LIMITS.registerPerIp.limit; index++) {
      expect((await register(`user${String(index)}`)).status).toBe(201);
    }
    await expectRateLimited(await register('one-too-many'));
    expect((await register('elsewhere', '198.51.100.9')).status).toBe(201);
  });
});

describe('per-IP limits count an IPv6 /64 as one visitor (T47)', () => {
  it('rotating addresses inside one /64 gives no fresh limit', async () => {
    const prelogin = (ip: string) =>
      t.app.request('/auth/prelogin', postJson({ username: 'ghost' }, fromIp(ip)));
    for (let index = 0; index < RATE_LIMITS.authPerIp.limit; index++) {
      expect((await prelogin(`2001:db8:0:1::${index.toString(16)}`)).status).toBe(200);
    }
    await expectRateLimited(await prelogin('2001:db8:0:1:ffff::1'));
    expect((await prelogin('2001:db8:0:2::1')).status).toBe(200);
  });
});

describe('failed logins per account', () => {
  const limit = RATE_LIMITS.failedLoginsPerAccount.limit;

  it(`pauses an account after ${String(limit)} failures, even for the right password`, async () => {
    await register('ahmed');
    for (let index = 0; index < limit; index++) {
      // A different IP each time: rotating IPs does not help an attacker.
      expect((await login('ahmed', badKey, `203.0.113.${String(index)}`)).status).toBe(401);
    }
    await expectRateLimited(await login('ahmed', goodKey, '203.0.113.200'));
  });

  it('clears the count after a successful login', async () => {
    await register('ahmed');
    for (let index = 0; index < limit - 1; index++) await login('ahmed', badKey);
    expect((await login('ahmed', goodKey)).status).toBe(200);
    for (let index = 0; index < limit - 1; index++) await login('ahmed', badKey);
    expect((await login('ahmed', goodKey, '198.51.100.3')).status).toBe(200);
  });

  it('counts guesses sent all at once, never more than the limit (T47)', async () => {
    await register('ahmed');
    const answers = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        login('ahmed', badKey, `203.0.113.${String(index)}`),
      ),
    );
    const tried = answers.filter((res) => res.status === 401).length;
    expect(tried).toBe(limit);
    expect(answers.filter((res) => res.status === 429)).toHaveLength(25 - limit);
  });

  it('failed logins by someone else never block the owner deleting the account (T47)', async () => {
    const token = SessionResponseSchema.parse(await (await register('ahmed')).json()).sessionToken;
    for (let index = 0; index < limit; index++) await login('ahmed', badKey);
    const res = await t.app.request('/account', {
      method: 'DELETE',
      body: JSON.stringify({ authKey: goodKey }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
  });

  it('treats unknown usernames the same way, so the pause reveals nothing', async () => {
    for (let index = 0; index < limit; index++) {
      expect((await login('ghost', badKey, `203.0.113.${String(index)}`)).status).toBe(401);
    }
    await expectRateLimited(await login('ghost', badKey, '203.0.113.200'));
  });

  it('also limits wrong-password account deletes', async () => {
    const token = SessionResponseSchema.parse(await (await register('ahmed')).json()).sessionToken;
    const del = (authKey: string) =>
      t.app.request('/account', {
        method: 'DELETE',
        body: JSON.stringify({ authKey }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
    for (let index = 0; index < limit; index++) expect((await del(badKey)).status).toBe(401);
    await expectRateLimited(await del(goodKey));
  });
});

describe('describeError never logs query parameters (T47)', () => {
  it('keeps the SQL text and the database error, not the values', () => {
    const cause = Object.assign(new Error('connection lost'), { code: '08006' });
    const failed = Object.assign(
      new Error('Failed query: insert into "users" values ($1, $2)\nparams: ahmed,SECRET-HASH'),
      {
        name: 'DrizzleQueryError',
        query: 'insert into "users" values ($1, $2)',
        params: ['ahmed', 'SECRET-HASH'],
        cause,
      },
    );
    const fields = describeError(failed);
    expect(JSON.stringify(fields)).not.toContain('SECRET-HASH');
    expect(fields).toEqual({
      errorName: 'DrizzleQueryError',
      query: 'insert into "users" values ($1, $2)',
      causeName: 'Error',
      causeMessage: 'connection lost',
      causeCode: '08006',
    });
  });
});

describe('logging', () => {
  it('writes one line per request with the id the client sees', async () => {
    const res = await t.app.request('/health');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        event: 'request',
        requestId: id,
        method: 'GET',
        path: '/health',
        status: 200,
      }),
    );
  });

  it('ignores a request id sent by the client, so log entries cannot be forged', async () => {
    const res = await t.app.request('/health', { headers: { 'x-request-id': 'forged' } });
    expect(res.headers.get('x-request-id')).not.toBe('forged');
  });

  it('never logs tokens, keys or bodies', async () => {
    const token = SessionResponseSchema.parse(await (await register('ahmed')).json()).sessionToken;
    await login('ahmed', goodKey);
    await t.app.request('/bundles?cursor=secret-cursor', {
      headers: { authorization: `Bearer ${token}` },
    });
    const everything = JSON.stringify(t.logs);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(goodKey);
    expect(everything).not.toContain('secret-cursor');
    expect(everything).not.toContain('ahmed');
  });

  it('logs an unexpected error with its request id and hides it from the client', async () => {
    await t.database.close(); // every database call now fails
    const res = await t.app.request('/auth/prelogin', postJson({ username: 'ahmed' }));
    expect(res.status).toBe(500);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.error).toEqual({
      code: 'internal_error',
      message: 'Something went wrong on the server',
    });
    expect(t.logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        event: 'unhandled_error',
        requestId: res.headers.get('x-request-id'),
      }),
    );
    t = await createTestApp(); // afterEach closes this one instead
  });
});

describe('createServerFromEnv', () => {
  const secret = Buffer.alloc(32, 7).toString('base64');
  const url = 'postgresql://user:hunter2@ep-example.eu-central-1.aws.neon.tech/neondb';

  it('refuses to start without valid settings, never printing their values', async () => {
    await expect(
      createServerFromEnv({ DATABASE_URL: url }, { clientIp: () => undefined }),
    ).rejects.toThrow(/SERVER_SECRET/);
    await expect(
      createServerFromEnv(
        { SERVER_SECRET: secret, DATABASE_URL: 'nope' },
        { clientIp: () => undefined },
      ),
    ).rejects.toThrow(/DATABASE_URL/);
    await createServerFromEnv(
      { DATABASE_URL: 'mysql://u:hunter2@h/db', SERVER_SECRET: secret },
      {
        clientIp: () => undefined,
      },
    ).catch((error: unknown) => {
      expect(String(error)).not.toContain('hunter2');
    });
  });

  it('builds the whole API from valid settings (no database needed for /health)', async () => {
    const server = await createServerFromEnv(
      { DATABASE_URL: url, SERVER_SECRET: secret },
      { clientIp: () => undefined, logger: { info: () => undefined, error: () => undefined } },
    );
    const res = await server.app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    await server.close();
  });
});
