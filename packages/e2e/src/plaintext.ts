import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

import type { RecordedRequest } from './local-server.ts';

/**
 * The forms a leaked string could take in a request: as is, JSON-escaped, URL-encoded, hex,
 * and base64 or base64url encoded at any of the three byte alignments (only the part that
 * does not depend on its neighbours is kept, so it is found inside a longer encoded value too).
 */
function encodedForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const hex = bytes.toString('hex');
  const forms = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    hex,
    hex.toUpperCase(),
  ];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    // Characters touched by the zero prefix or the padding depend on what surrounds it.
    const core = encoded.slice(offset === 0 ? 0 : 4, -4);
    if (core.length >= 8) forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return forms;
}

/** What `bytes` inflates to as gzip, zlib or raw deflate, whichever works (T48). */
function inflated(bytes: Uint8Array): Buffer[] {
  const found: Buffer[] = [];
  for (const inflate of [gunzipSync, inflateSync, inflateRawSync]) {
    try {
      const out = inflate(bytes, { maxOutputLength: 64 * 1024 * 1024 });
      if (out.length > 0) found.push(out);
    } catch {
      // Not in this format.
    }
  }
  return found;
}

/**
 * Every view of a request body worth searching (T48): the bytes, what they inflate to (so an
 * upload that were only compressed, not encrypted, is caught), and each base64 value inside
 * the body, decoded and inflated in turn.
 */
function bodyViews(body: Uint8Array): Buffer[] {
  const views = [Buffer.from(body), ...inflated(body)];
  const text = Buffer.from(body).toString('latin1');
  for (const token of text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(token, 'base64');
    views.push(decoded, ...inflated(decoded));
  }
  return views;
}

/**
 * Which secrets appear in any request (T38, T48: no plaintext leaves the PC). Every URL,
 * header and body is searched, bodies byte for byte, as text, inflated and base64-decoded.
 * `exceptHeader`: a header whose value may hold a secret (the session token in
 * `authorization`), left out of the search.
 */
export function plaintextLeaks(
  requests: readonly RecordedRequest[],
  secrets: readonly string[],
  exceptHeader?: string,
): string[] {
  const leaks = new Set<string>();
  for (const request of requests) {
    const headers = request.headers
      .split('\n')
      .filter(
        (line) => exceptHeader === undefined || !line.toLowerCase().startsWith(`${exceptHeader}:`),
      )
      .join('\n');
    const views = bodyViews(request.body);
    const texts = [
      request.method,
      request.url,
      headers,
      ...views.map((view) => view.toString('utf8')),
    ];
    for (const secret of secrets) {
      const needle = Buffer.from(secret, 'utf8');
      const forms = encodedForms(secret);
      if (views.some((view) => view.includes(needle))) leaks.add(secret);
      if (texts.some((text) => forms.some((form) => text.includes(form)))) leaks.add(secret);
    }
  }
  return [...leaks];
}

/** gzip's first two bytes: an upload that starts with them was never encrypted (T48). */
export function looksCompressedOnly(body: Uint8Array): boolean {
  return body[0] === 0x1f && body[1] === 0x8b;
}
