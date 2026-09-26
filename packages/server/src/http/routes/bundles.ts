import {
  API_HEADERS,
  API_ROUTES,
  BundleParamsSchema,
  ListBundlesQuerySchema,
  MAX_BUNDLE_BYTES,
  PutBundleRequestHeadersSchema,
  type BundleParams,
  type ListBundlesResponse,
  type PutBundleResponse,
} from '@agentnomad/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

import type { AuthService } from '../../auth/auth-service.ts';
import {
  BundleNotFoundError,
  StorageLimitError,
  InvalidUploadError,
  type BundleService,
} from '../../bundles/bundle-service.ts';
import { InvalidCursorError, type BundleKey, type BundleMeta } from '../../db/repositories.ts';
import { fromBase64, fromHex, toBase64, toHex } from '../../encoding.ts';
import { RATE_LIMITS, RateLimitedError, type RateLimiter } from '../../rate-limit/rate-limiter.ts';
import { ApiError } from '../errors.ts';
import { requireSession, type SessionVariables } from '../session.ts';
import { validHeaders, validParams, validQuery } from '../validate.ts';

const OCTET_STREAM = 'application/octet-stream';

const bundlePath = API_ROUTES.bundle(':agent', ':scopeKey');

const keyFor = (userId: string, params: BundleParams): BundleKey => ({
  userId,
  agent: params.agent,
  scopeKey: params.scopeKey,
});

/** Headers describing stored bytes (GET) — the client checks them before decrypting. */
function metaHeaders(meta: BundleMeta): Record<string, string> {
  return {
    [API_HEADERS.revision]: String(meta.revision),
    [API_HEADERS.contentSha256]: toHex(meta.contentHash),
    [API_HEADERS.formatVersion]: String(meta.formatVersion),
    ...(meta.nameEnc && { [API_HEADERS.nameEnc]: toBase64(meta.nameEnc) }),
  };
}

/** Translates service errors into API errors. */
function toApiError(error: unknown): unknown {
  if (error instanceof BundleNotFoundError) {
    return new ApiError(404, 'not_found', error.message);
  }
  // An existing code, so 1.0 CLIs understand it; the message says which limit (T47).
  if (error instanceof StorageLimitError) {
    return new ApiError(413, 'payload_too_large', error.message);
  }
  if (error instanceof InvalidUploadError || error instanceof InvalidCursorError) {
    return new ApiError(400, 'bad_request', error.message);
  }
  return error;
}

/** GET /bundles, GET/PUT/DELETE /bundles/:agent/:scopeKey (T16). All need a session. */
export function bundleRoutes(
  auth: AuthService,
  service: BundleService,
  limiter: RateLimiter,
): Hono<{ Variables: SessionVariables }> {
  const routes = new Hono<{ Variables: SessionVariables }>();
  routes.use(API_ROUTES.bundles, requireSession(auth));
  /** Saves and deletes per account (T47); runs after the session check, before the body. */
  const writeLimit = createMiddleware<{ Variables: SessionVariables }>(async (c, next) => {
    const status = await limiter.hit(RATE_LIMITS.writesPerAccount, c.get('session').userId);
    if (!status.allowed) throw new RateLimitedError(status.retryAfterSeconds);
    await next();
  });
  routes.use(`${API_ROUTES.bundles}/*`, requireSession(auth));

  return routes
    .get(API_ROUTES.bundles, validQuery(ListBundlesQuerySchema), async (c) => {
      const { cursor, limit } = c.req.valid('query');
      const page = await service
        .list(c.get('session').userId, { limit, ...(cursor !== undefined && { cursor }) })
        .catch((error: unknown) => {
          throw toApiError(error);
        });
      const body: ListBundlesResponse = {
        items: page.items.map((meta) => ({
          agent: meta.agent,
          scopeKey: meta.scopeKey,
          nameEnc: meta.nameEnc ? toBase64(meta.nameEnc) : null,
          revision: meta.revision,
          formatVersion: meta.formatVersion,
          sizeBytes: meta.sizeBytes,
          updatedAt: meta.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
      return c.json(body);
    })

    .get(bundlePath, validParams(BundleParamsSchema), async (c) => {
      const key = keyFor(c.get('session').userId, c.req.valid('param'));
      const { meta, ciphertext } = await service.download(key).catch((error: unknown) => {
        throw toApiError(error);
      });
      // A copy backed by a plain ArrayBuffer, which is what Response bodies accept.
      return c.body(new Uint8Array(ciphertext), 200, {
        'content-type': OCTET_STREAM,
        ...metaHeaders(meta),
      });
    })

    .put(
      bundlePath,
      writeLimit,
      // Raw bytes, never base64 JSON, so 5 MB is the real limit. Checked from
      // Content-Length or while streaming, before the body is buffered.
      bodyLimit({
        maxSize: MAX_BUNDLE_BYTES,
        onError: () => {
          throw new ApiError(413, 'payload_too_large', 'A saved setup can be at most 5 MB');
        },
      }),
      validParams(BundleParamsSchema),
      validHeaders(PutBundleRequestHeadersSchema),
      async (c) => {
        if (c.req.header('content-type') !== OCTET_STREAM) {
          throw new ApiError(400, 'bad_request', `Body must be ${OCTET_STREAM}`);
        }
        const headers = c.req.valid('header');
        const nameEnc = headers[API_HEADERS.nameEnc];
        const result = await service
          .upload({
            key: keyFor(c.get('session').userId, c.req.valid('param')),
            expectedRevision: headers[API_HEADERS.expectedRevision],
            ciphertext: new Uint8Array(await c.req.arrayBuffer()),
            contentHash: fromHex(headers[API_HEADERS.contentSha256]),
            formatVersion: headers[API_HEADERS.formatVersion],
            nameEnc: nameEnc === undefined ? null : fromBase64(nameEnc),
          })
          .catch((error: unknown) => {
            throw toApiError(error);
          });

        if (result.outcome === 'conflict') {
          throw new ApiError(
            409,
            'revision_conflict',
            result.currentRevision === 0
              ? 'This setup was deleted since you last pulled it'
              : 'A newer version was saved from another PC; pull it first',
            result.currentRevision === 0 ? undefined : result.currentRevision,
          );
        }
        const body: PutBundleResponse = {
          revision: result.meta.revision,
          updatedAt: result.meta.updatedAt.toISOString(),
        };
        return c.json(body);
      },
    )

    .delete(bundlePath, writeLimit, validParams(BundleParamsSchema), async (c) => {
      const key = keyFor(c.get('session').userId, c.req.valid('param'));
      await service.delete(key).catch((error: unknown) => {
        throw toApiError(error);
      });
      return c.body(null, 204);
    });
}
