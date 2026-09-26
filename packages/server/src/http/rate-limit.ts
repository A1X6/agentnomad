import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import {
  RateLimitedError,
  type RateLimiter,
  type RateLimitRule,
} from '../rate-limit/rate-limiter.ts';

/**
 * Reads the visitor's IP. Host-specific (each host passes it in its own proxy header), so
 * it is chosen where the server is wired up (T19). `undefined` when it cannot be known.
 */
export type ClientIp = (c: Context) => string | undefined;

/** The eight 16-bit groups of an IPv6 address, or `null` when it is not one. */
function ipv6Groups(ip: string): string[] | null {
  if (!ip.includes(':')) return null;
  const [head = '', tail, ...extra] = ip.toLowerCase().split('::');
  if (extra.length > 0) return null;
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  // An IPv4 tail (`::ffff:1.2.3.4`) takes two groups.
  const last = right.at(-1) ?? left.at(-1) ?? '';
  const v4 = last.includes('.') ? 1 : 0;
  const missing = 8 - left.length - right.length - v4;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  return [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
}

/**
 * Who a per-IP limit counts (T47). One IPv6 home or server connection gets a whole /64, so
 * an address from it is counted by its /64: rotating addresses inside it gives no fresh
 * limits. IPv4 (and IPv4 written as IPv6, `::ffff:1.2.3.4`) is counted per address.
 */
export function rateLimitSubject(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped !== undefined) return mapped;
  const groups = ipv6Groups(ip);
  if (groups === null) return ip;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Refuses the request with 429 once this IP has used up the rule's limit. */
export function limitPerIp(limiter: RateLimiter, rule: RateLimitRule, clientIp: ClientIp) {
  return createMiddleware(async (c, next) => {
    // Visitors whose IP cannot be read share one bucket: stricter, never looser.
    const ip = clientIp(c);
    const status = await limiter.hit(rule, ip === undefined ? 'unknown' : rateLimitSubject(ip));
    if (!status.allowed) throw new RateLimitedError(status.retryAfterSeconds);
    await next();
  });
}
