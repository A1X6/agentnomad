import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { renderClientIp } from '../src/hosting/client-ip.ts';
import { rateLimitSubject } from '../src/http/rate-limit.ts';
import { readPort } from '../src/port.ts';

async function ipFor(headers: Record<string, string>): Promise<string | undefined> {
  let seen: string | undefined = 'not called';
  const app = new Hono().get('/', (c) => {
    seen = renderClientIp(c);
    return c.body(null, 204);
  });
  await app.request('/', { headers });
  return seen;
}

describe('renderClientIp', () => {
  it('reads CF-Connecting-IP first, which Cloudflare sets on every request (T47)', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.8' })).toBe('203.0.113.8');
    expect(
      await ipFor({ 'cf-connecting-ip': '203.0.113.8', 'true-client-ip': '198.51.100.66' }),
    ).toBe('203.0.113.8');
  });

  it('falls back to True-Client-IP', async () => {
    expect(await ipFor({ 'true-client-ip': '203.0.113.7' })).toBe('203.0.113.7');
    expect(await ipFor({ 'true-client-ip': '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('never trusts X-Forwarded-For, which clients can fake on Render', async () => {
    expect(await ipFor({ 'x-forwarded-for': '198.51.100.1' })).toBeUndefined();
    expect(
      await ipFor({ 'x-forwarded-for': '198.51.100.1', 'true-client-ip': '203.0.113.7' }),
    ).toBe('203.0.113.7');
  });

  it.each([
    ['no header', {}],
    ['an empty header', { 'true-client-ip': '' }],
    ['something that is not an IP', { 'true-client-ip': 'evil"}; drop table' }],
    ['a far too long value', { 'true-client-ip': '1'.repeat(100) }],
  ])('treats %s as unknown', async (_, headers) => {
    expect(await ipFor(headers)).toBeUndefined();
  });
});

describe('rateLimitSubject: who a per-IP limit counts (T47)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:0:1::1', '2001:db8:0:1::/64'],
    ['2001:db8:0:1:ffff:ffff:ffff:ffff', '2001:db8:0:1::/64'],
    ['2001:0db8:0000:0001:0:0:0:9', '2001:db8:0:1::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s → %s', (ip, subject) => {
    expect(rateLimitSubject(ip)).toBe(subject);
  });
});

describe('readPort', () => {
  it('uses Render’s PORT, or 10000 when it is not set', () => {
    expect(readPort({ PORT: '8080' })).toBe(8080);
    expect(readPort({})).toBe(10_000);
  });

  it.each(['abc', '0', '70000', '80.5'])('refuses PORT=%j', (PORT) => {
    expect(() => readPort({ PORT })).toThrow(/PORT/);
  });
});
