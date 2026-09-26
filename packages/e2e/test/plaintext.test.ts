import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { RecordedRequest } from '../src/local-server.ts';
import { looksCompressedOnly, plaintextLeaks } from '../src/plaintext.ts';

const request = (body: string, headers = ''): RecordedRequest => ({
  method: 'PUT',
  url: 'http://127.0.0.1/bundles/claude-code/abc',
  headers,
  body: new TextEncoder().encode(body),
});

/** The check itself must catch a leak in every form it claims to, or its passing means nothing. */
describe('plaintext leak check', () => {
  const secret = 'Run the deploy script';

  it.each([
    ['as is, in the body', request(`{"content":"${secret}"}`)],
    ['in a header', request('', `x-note: ${secret}`)],
    ...[0, 1, 2].map((offset): [string, RecordedRequest] => [
      `base64 at offset ${String(offset)}`,
      request(Buffer.from('ab'.slice(0, offset) + secret + 'tail').toString('base64')),
    ]),
    ['base64url', request(Buffer.from(`??${secret}??`).toString('base64url'))],
  ])('finds it %s', (_, leaked) => {
    expect(plaintextLeaks([leaked], [secret])).toEqual([secret]);
  });

  it('finds nothing in unrelated or random data', () => {
    const random = request(
      Buffer.from(crypto.getRandomValues(new Uint8Array(4096))).toString('latin1'),
    );
    expect(plaintextLeaks([random, request('{"username":"e2e-user"}')], [secret])).toEqual([]);
  });
});

/** T48: forms the first version of the check could not see. */
describe('plaintext leak check: compressed, hex, escaped', () => {
  const secret = 'Run the deploy script';
  const bundle = JSON.stringify({ files: [{ path: 'skills/a/SKILL.md', content: secret }] });

  it('finds a bundle that was only compressed, never encrypted', () => {
    const upload: RecordedRequest = { ...request(''), body: new Uint8Array(gzipSync(bundle)) };
    expect(plaintextLeaks([upload], [secret])).toEqual([secret]);
    expect(looksCompressedOnly(upload.body)).toBe(true);
  });

  it('finds compressed data inside a base64 JSON field', () => {
    const inner = gzipSync(bundle).toString('base64');
    expect(plaintextLeaks([request(`{"blob":"${inner}"}`)], [secret])).toEqual([secret]);
  });

  it.each([
    ['hex', Buffer.from(secret).toString('hex')],
    ['JSON-escaped', JSON.stringify(`a\n${secret}"`)],
    ['URL-encoded', encodeURIComponent(secret)],
  ])('finds it %s', (_, body) => {
    const tricky = body === JSON.stringify(`a\n${secret}"`) ? `a\n${secret}"` : secret;
    expect(plaintextLeaks([request(body)], [tricky])).toEqual([tricky]);
  });

  it('leaves out the one header a secret may travel in, and only that one', () => {
    const token = 'tok_0123456789abcdef0123456789';
    const withAuth = request('', `authorization: Bearer ${token}`);
    expect(plaintextLeaks([withAuth], [token], 'authorization')).toEqual([]);
    const elsewhere = request('', `x-other: ${token}`);
    expect(plaintextLeaks([elsewhere], [token], 'authorization')).toEqual([token]);
  });

  it('an encrypted-looking upload is not taken for a compressed one', () => {
    expect(looksCompressedOnly(crypto.getRandomValues(new Uint8Array(64)).fill(0x00, 0, 1))).toBe(
      false,
    );
  });
});
