import { API_ROUTES, type HealthResponse } from '@agentnomad/contracts';
import { Hono } from 'hono';
import { requestId, type RequestIdVariables } from 'hono/request-id';

import type { AuthService } from '../auth/auth-service.ts';
import type { BundleService } from '../bundles/bundle-service.ts';
import type { Logger } from '../logging/logger.ts';
import type { RateLimiter } from '../rate-limit/rate-limiter.ts';
import { createErrorHandler, handleNotFound } from './errors.ts';
import type { ClientIp } from './rate-limit.ts';
import { accountRoutes } from './routes/account.ts';
import { authRoutes } from './routes/auth.ts';
import { bundleRoutes } from './routes/bundles.ts';

export interface AppDeps {
  readonly auth: AuthService;
  readonly bundles: BundleService;
  readonly limiter: RateLimiter;
  /** How to read the visitor's IP on this host (T19). */
  readonly clientIp: ClientIp;
  readonly logger: Logger;
}

/**
 * The agentnomad API. Built from injected services, so tests run it against PGlite with a
 * fixed clock and hosts wire in Neon.
 *
 * No CORS headers on purpose: the only client is the CLI, and without them browsers refuse
 * to let any website read these responses. Tokens travel in the Authorization header, never
 * in cookies, so cross-site request forgery does not apply either.
 */
export function createApp(deps: AppDeps): Hono<{ Variables: RequestIdVariables }> {
  const { logger } = deps;
  return (
    new Hono<{ Variables: RequestIdVariables }>()
      // A fresh id for every request, returned as X-Request-Id and put in every log line.
      // Client-sent ids are ignored (headerName ''), so nobody can forge log entries.
      .use('*', requestId({ headerName: '' }))
      .use('*', async (c, next) => {
        const started = performance.now();
        await next();
        c.header('X-Request-Id', c.get('requestId'));
        // OWASP REST guidance: never cache API responses (they carry tokens and keys), and
        // never let a client guess a different content type.
        c.header('Cache-Control', 'no-store');
        c.header('X-Content-Type-Options', 'nosniff');
        // One line per request. No headers, bodies or query strings: they carry tokens,
        // keys and cursors.
        logger.info('request', {
          requestId: c.get('requestId'),
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: Math.round(performance.now() - started),
        });
      })
      .get(API_ROUTES.health, (c) => c.json({ status: 'ok' } satisfies HealthResponse))
      .route('/', authRoutes(deps.auth, deps))
      .route('/', bundleRoutes(deps.auth, deps.bundles, deps.limiter))
      .route('/', accountRoutes(deps.auth))
      .notFound(handleNotFound)
      .onError(createErrorHandler(logger))
  );
}
