import { createHash } from 'node:crypto';

import {
  API_HEADERS,
  API_ROUTES,
  AUTHORIZATION_SCHEME,
  BundleParamsSchema,
  ErrorResponseSchema,
  GetBundleResponseHeadersSchema,
  HealthResponseSchema,
  ListBundlesResponseSchema,
  LoginResponseSchema,
  MAX_BUNDLE_BYTES,
  PreloginResponseSchema,
  PutBundleResponseSchema,
  SessionResponseSchema,
  type BundleParams,
} from '@agentnomad/contracts';
import type * as z from 'zod';

import { CLI_VERSION } from '../version.ts';
import type { ApiClient, BundleUpload, DownloadedBundle } from './api-client.ts';
import {
  ApiError,
  InvalidResponseError,
  NetworkError,
  NotLoggedInError,
  OutcomeUnknownError,
} from './api-errors.ts';
import {
  createTransport,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  realSleep,
  type RetryPolicy,
  type Sleep,
  type TransportRequest,
  type TransportResponse,
} from './transport.ts';

export interface ApiTimeouts {
  /** JSON requests. */
  readonly requestMs: number;
  /** Bundle upload and download: this much for any size … */
  readonly transferBaseMs: number;
  /** … plus this much per MB, so a 5 MB setup still fits on a slow (~0.2 Mbps) connection. */
  readonly transferPerMbMs: number;
  /** The first health check, which may wait for the free host to wake up (about a minute). */
  readonly wakeMs: number;
  /** How long the first health check may take before the user is told the server is waking. */
  readonly wakeNoticeMs: number;
}

export const DEFAULT_API_TIMEOUTS: ApiTimeouts = {
  requestMs: 30_000,
  transferBaseMs: 60_000,
  transferPerMbMs: 30_000,
  wakeMs: 90_000,
  wakeNoticeMs: 2_000,
};

/** Lets the command show "Waking up the server…" while the free host starts. */
export interface WakeUpListener {
  onWaking(): void;
  onAwake(): void;
}

export interface HttpApiClientOptions {
  readonly baseUrl: URL;
  /** The stored session token (T22 keychain), or `null` when not logged in. */
  readonly getSessionToken: () => Promise<string | null>;
  readonly wakeUp?: WakeUpListener;
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly timeouts?: Partial<ApiTimeouts>;
  readonly retryPolicy?: RetryPolicy;
}

type NoRetryOperation = OutcomeUnknownError['operation'];

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };
const OCTET_STREAM = 'application/octet-stream';
/** Largest answer: a whole bundle, plus room for headers of error pages. */
const MAX_RESPONSE_BYTES = MAX_BUNDLE_BYTES + 64 * 1024;

/**
 * Time allowed to move `bytes` in one attempt. Measured on Render (T21): a 5 MB upload
 * took ~10 s on a normal connection; the limit leaves room for very slow ones.
 */
export function transferTimeoutMs(bytes: number, timeouts: ApiTimeouts): number {
  return Math.round(timeouts.transferBaseMs + (bytes / (1024 * 1024)) * timeouts.transferPerMbMs);
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function parseJson<S extends z.ZodType>(response: TransportResponse, schema: S): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(response.body));
  } catch (error) {
    throw new InvalidResponseError('The server sent an answer that is not JSON.', {
      cause: error,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidResponseError(
      'The server sent an unexpected answer. Is agentnomad up to date?',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** The error for a non-success answer: the API's own error, or a host/proxy failure. */
function failure(response: TransportResponse, noRetry?: NoRetryOperation): Error {
  const parsed = (() => {
    try {
      return ErrorResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(response.body)));
    } catch {
      return undefined;
    }
  })();
  if (parsed?.success) {
    const { code, message, currentRevision } = parsed.data.error;
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    return new ApiError(response.status, code, message, {
      ...(currentRevision !== undefined && { currentRevision }),
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    });
  }
  if (response.status >= 500) {
    const error = new NetworkError(
      'server_unavailable',
      `The server is not available right now (HTTP ${String(response.status)}). Try again later.`,
    );
    return noRetry ? new OutcomeUnknownError(noRetry, { cause: error }) : error;
  }
  return new InvalidResponseError(
    `The server sent an unexpected answer (HTTP ${String(response.status)}).`,
  );
}

function expect(response: TransportResponse, status: number, noRetry?: NoRetryOperation): void {
  if (response.status !== status) throw failure(response, noRetry);
}

/**
 * The ApiClient over HTTP (T21). Before its first request it checks /health with a long
 * timeout, because the free host sleeps when idle. Every answer is checked against the
 * shared contracts, and downloads against their SHA-256.
 */
export function createHttpApiClient(options: HttpApiClientOptions): ApiClient {
  const timeouts = { ...DEFAULT_API_TIMEOUTS, ...options.timeouts };
  const sleep = options.sleep ?? realSleep;
  const transport = createTransport({
    baseUrl: options.baseUrl,
    fetch: options.fetch ?? globalThis.fetch,
    sleep,
    random: options.random ?? Math.random,
    retryPolicy: options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    userAgent: `agentnomad/${CLI_VERSION}`,
  });

  let awake: Promise<void> | undefined;

  async function wakeUp(): Promise<void> {
    const notice = new AbortController();
    // An object, since the flag is set in a callback that flow analysis does not follow.
    const waking = { shown: false };
    void sleep(timeouts.wakeNoticeMs, notice.signal).then(
      () => {
        waking.shown = true;
        options.wakeUp?.onWaking();
      },
      () => undefined,
    );
    try {
      const response = await transport.send({
        method: 'GET',
        path: API_ROUTES.health,
        headers: { accept: 'application/json' },
        timeoutMs: timeouts.wakeMs,
        retry: true,
      });
      expect(response, 200);
      parseJson(response, HealthResponseSchema);
    } finally {
      notice.abort();
      if (waking.shown) options.wakeUp?.onAwake();
    }
  }

  /** Once per client; a failed wake-up is tried again by the next request. */
  function ensureAwake(): Promise<void> {
    awake ??= wakeUp().catch((error: unknown) => {
      awake = undefined;
      throw error;
    });
    return awake;
  }

  async function authorization(): Promise<Record<string, string>> {
    const token = await options.getSessionToken();
    if (token === null) throw new NotLoggedInError();
    return { authorization: `${AUTHORIZATION_SCHEME} ${token}` };
  }

  async function send(
    request: Omit<TransportRequest, 'timeoutMs'> & { readonly timeoutMs?: number },
    noRetry?: NoRetryOperation,
  ): Promise<TransportResponse> {
    await ensureAwake();
    try {
      return await transport.send({ timeoutMs: timeouts.requestMs, ...request });
    } catch (error) {
      if (noRetry && error instanceof NetworkError) {
        throw new OutcomeUnknownError(noRetry, { cause: error });
      }
      throw error;
    }
  }

  const postJson = (path: string, body: unknown, retry: boolean, noRetry?: NoRetryOperation) =>
    send(
      { method: 'POST', path, headers: JSON_HEADERS, body: JSON.stringify(body), retry },
      noRetry,
    );

  /** Bundle paths are built only from validated params, never from raw strings. */
  const bundlePath = (params: BundleParams) => {
    const { agent, scopeKey } = BundleParamsSchema.parse(params);
    return API_ROUTES.bundle(agent, scopeKey);
  };

  return {
    auth: {
      async prelogin(request) {
        const response = await postJson(API_ROUTES.prelogin, request, true);
        expect(response, 200);
        return parseJson(response, PreloginResponseSchema);
      },

      async register(request) {
        const response = await postJson(API_ROUTES.register, request, false, 'register');
        expect(response, 201, 'register');
        return parseJson(response, SessionResponseSchema);
      },

      async login(request) {
        const response = await postJson(API_ROUTES.login, request, true);
        expect(response, 200);
        return parseJson(response, LoginResponseSchema);
      },

      async logout() {
        const response = await send({
          method: 'POST',
          path: API_ROUTES.logout,
          headers: await authorization(),
          retry: true,
        });
        // A retry after a lost answer finds the session already gone: that is the goal.
        if (response.status === 401 && response.lostAnswer) return;
        expect(response, 204);
      },

      async deleteAccount(request) {
        const response = await send(
          {
            method: 'DELETE',
            path: API_ROUTES.account,
            headers: { ...JSON_HEADERS, ...(await authorization()) },
            body: JSON.stringify(request),
            retry: false,
          },
          'delete-account',
        );
        expect(response, 204, 'delete-account');
      },
    },

    bundles: {
      async list(listOptions = {}) {
        const response = await send({
          method: 'GET',
          path: API_ROUTES.bundles,
          query: {
            ...(listOptions.cursor !== undefined && { cursor: listOptions.cursor }),
            ...(listOptions.limit !== undefined && { limit: String(listOptions.limit) }),
          },
          headers: { accept: 'application/json', ...(await authorization()) },
          retry: true,
        });
        expect(response, 200);
        return parseJson(response, ListBundlesResponseSchema);
      },

      async get(params): Promise<DownloadedBundle> {
        const response = await send({
          method: 'GET',
          path: bundlePath(params),
          headers: await authorization(),
          // The size is only known from the answer, so allow for the largest setup.
          timeoutMs: transferTimeoutMs(MAX_BUNDLE_BYTES, timeouts),
          retry: true,
        });
        expect(response, 200);
        const headers = GetBundleResponseHeadersSchema.safeParse(
          Object.fromEntries(response.headers),
        );
        if (!headers.success) {
          throw new InvalidResponseError('The server sent a setup without its details.', {
            cause: headers.error,
          });
        }
        const meta = headers.data;
        if (sha256Hex(response.body) !== meta[API_HEADERS.contentSha256]) {
          throw new InvalidResponseError('The downloaded setup was damaged on the way. Try again.');
        }
        return {
          ciphertext: response.body,
          revision: meta[API_HEADERS.revision],
          contentSha256: meta[API_HEADERS.contentSha256],
          formatVersion: meta[API_HEADERS.formatVersion],
          nameEnc: meta[API_HEADERS.nameEnc] ?? null,
        };
      },

      async put(params, upload: BundleUpload) {
        if (upload.ciphertext.byteLength > MAX_BUNDLE_BYTES) {
          throw new RangeError('A saved setup can be at most 5 MB');
        }
        // The hash is how the server recognises a retry; a wrong one would break that.
        if (sha256Hex(upload.ciphertext) !== upload.contentSha256) {
          throw new Error('contentSha256 does not match the ciphertext');
        }
        const response = await send({
          method: 'PUT',
          path: bundlePath(params),
          headers: {
            'content-type': OCTET_STREAM,
            accept: 'application/json',
            [API_HEADERS.expectedRevision]: String(upload.expectedRevision),
            [API_HEADERS.contentSha256]: upload.contentSha256,
            [API_HEADERS.formatVersion]: String(upload.formatVersion),
            ...(upload.nameEnc !== undefined && { [API_HEADERS.nameEnc]: upload.nameEnc }),
            ...(await authorization()),
          },
          body: upload.ciphertext,
          timeoutMs: transferTimeoutMs(upload.ciphertext.byteLength, timeouts),
          retry: true,
        });
        expect(response, 200);
        return parseJson(response, PutBundleResponseSchema);
      },

      async delete(params) {
        const response = await send({
          method: 'DELETE',
          path: bundlePath(params),
          headers: await authorization(),
          retry: true,
        });
        // A retry after a lost answer finds the setup already deleted: that is the goal. After
        // only 502/503/504 nothing was done, so a 404 means it was never there (T46).
        if (response.status === 404 && response.lostAnswer) return;
        expect(response, 204);
      },
    },
  };
}
