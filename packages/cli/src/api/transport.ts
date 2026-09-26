import type { ReadableStreamReadResult } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';

import { InvalidResponseError, NetworkError } from './api-errors.ts';

/** Waits `ms`; rejects early when `signal` aborts. Injected so tests never really wait. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, signal ? { signal } : undefined);

export interface RetryPolicy {
  /** Tries in total, including the first. */
  readonly attempts: number;
  /** First wait; doubles each retry, plus up to one more `baseDelayMs` of random jitter. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

/** Gateway answers from the host while the app restarts or wakes up; nothing was processed. */
const RETRY_STATUSES = new Set([502, 503, 504]);

export interface TransportRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path from API_ROUTES, e.g. `/auth/login`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Per attempt, covering the whole answer including its body. */
  readonly timeoutMs: number;
  /** Only for requests that are safe to send twice. */
  readonly retry: boolean;
}

/** A complete answer: the body is already read, so a slow body is retried like a slow start. */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  /** Which attempt produced this answer (1 = first try). */
  readonly attempts: number;
  /**
   * An earlier attempt got no answer (network error or timeout), so the server may have
   * done it already. A 502/503/504 before means it did not (T46).
   */
  readonly lostAnswer: boolean;
}

export interface TransportDeps {
  readonly baseUrl: URL;
  readonly fetch: typeof fetch;
  readonly sleep: Sleep;
  /** Returns a number in [0, 1), like Math.random. */
  readonly random: () => number;
  readonly retryPolicy: RetryPolicy;
  /** Largest answer body accepted, so a wrong server cannot fill the memory. */
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** Wait before retry number `retry` (1-based): 0.5 s, 1 s, 2 s … plus jitter, capped. */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number): number {
  const exponential = policy.baseDelayMs * 2 ** (retry - 1);
  return Math.min(policy.maxDelayMs, exponential + random() * policy.baseDelayMs);
}

/** Retry-After in whole seconds (the form this API sends); `undefined` when absent or odd. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

function toNetworkError(error: unknown): NetworkError {
  if (error instanceof NetworkError) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new NetworkError('timeout', 'The server took too long to answer.', { cause: error });
  }
  return new NetworkError(
    'unreachable',
    'Could not reach the server. Check your internet connection.',
    { cause: error },
  );
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new InvalidResponseError('The server sent a larger answer than expected.');
  }
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    // Node types stream chunks as any; checked here instead of trusted.
    const result: ReadableStreamReadResult<unknown> = await reader.read();
    if (result.done) break;
    const value = result.value;
    if (!(value instanceof Uint8Array)) throw new InvalidResponseError('Unreadable answer.');
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new InvalidResponseError('The server sent a larger answer than expected.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Sends requests with a timeout per attempt, retrying network errors, timeouts and
 * 502/503/504 with backoff when `retry` is set. Never retries other statuses: a 4xx or
 * 500 is a real answer. The body is sent unchanged on every attempt.
 */
export function createTransport(deps: TransportDeps): Transport {
  return {
    async send(request) {
      const url = new URL(request.path, deps.baseUrl);
      for (const [name, value] of Object.entries(request.query ?? {})) {
        url.searchParams.set(name, value);
      }
      const headers = { 'user-agent': deps.userAgent, ...request.headers };
      // One copy backed by a plain ArrayBuffer (what fetch accepts), reused by every attempt.
      const body = request.body instanceof Uint8Array ? new Uint8Array(request.body) : request.body;
      const attempts = request.retry ? deps.retryPolicy.attempts : 1;

      let lostAnswer = false;
      for (let attempt = 1; ; attempt++) {
        const last = attempt >= attempts;
        let waitMs = backoffDelay(attempt, deps.retryPolicy, deps.random);
        try {
          const response = await deps.fetch(url, {
            method: request.method,
            headers,
            ...(body !== undefined && { body }),
            // The API never redirects; refusing keeps the session token on this server.
            redirect: 'error',
            signal: AbortSignal.timeout(request.timeoutMs),
          });
          if (!last && RETRY_STATUSES.has(response.status)) {
            await response.body?.cancel();
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            if (retryAfter !== undefined) {
              waitMs = Math.min(deps.retryPolicy.maxDelayMs, Math.max(waitMs, retryAfter * 1000));
            }
          } else {
            return {
              status: response.status,
              headers: response.headers,
              body: await readCapped(response, deps.maxResponseBytes),
              attempts: attempt,
              lostAnswer,
            };
          }
        } catch (error) {
          if (error instanceof InvalidResponseError) throw error;
          if (last) throw toNetworkError(error);
          lostAnswer = true;
        }
        await deps.sleep(waitMs);
      }
    },
  };
}
