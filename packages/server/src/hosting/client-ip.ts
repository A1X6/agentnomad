import type { ClientIp } from '../http/rate-limit.ts';

/** An IPv4 or IPv6 address: only these characters, and a sane length. */
const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The visitor's IP on Render (T19). Cloudflare always sits in front of Render. It sets
 * CF-Connecting-IP on every request; True-Client-IP only where a zone turns on that managed
 * transform (Cloudflare's docs), so CF-Connecting-IP is read first (T47) and True-Client-IP
 * (verified live in T19) only when it is missing.
 * X-Forwarded-For is NOT used: Render's proxy only appends to it, so its first entry is
 * whatever the client wrote (verified live: faking it dodged the per-IP limit).
 * Anything that does not look like an IP counts as unknown (one shared, stricter bucket).
 */
export const renderClientIp: ClientIp = (c) => {
  const ip = (c.req.header('cf-connecting-ip') ?? c.req.header('true-client-ip'))?.trim();
  return ip && IP_PATTERN.test(ip) ? ip : undefined;
};
