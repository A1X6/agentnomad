import * as z from 'zod';

/** Byte sizes fixed by the crypto design (see docs/decisions/0001-libraries.md and T08). */
export const KDF_SALT_BYTES = 16;
export const AUTH_KEY_BYTES = 32;
/** XChaCha20-Poly1305 over the 32-byte data key: 24-byte nonce + 32-byte key + 16-byte tag. */
export const WRAPPED_DATA_KEY_BYTES = 72;
/** Largest encrypted project name accepted (nonce + up to 400 bytes of name + tag). */
export const MAX_NAME_ENC_BYTES = 512;
/**
 * The message of the 401 that DELETE /account sends for a wrong password, so the CLI can
 * tell it from an ended session (T46). Part of the API: 1.0 CLIs know only the `unauthorized`
 * code, so a new code would break them.
 */
export const WRONG_PASSWORD_MESSAGE = 'Wrong password';

/**
 * What one account may keep (T47), so a single account cannot fill the database that every
 * user shares: saved setups, and their encrypted bytes together.
 */
export const USER_STORAGE_LIMITS = { maxSetups: 100, maxBytes: 50 * 1024 * 1024 } as const;

/** Largest encrypted bundle accepted by PUT /bundles. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

/** Every API path. Bundle paths are built from validated params only. */
export const API_ROUTES = {
  health: '/health',
  prelogin: '/auth/prelogin',
  register: '/auth/register',
  login: '/auth/login',
  logout: '/auth/logout',
  bundles: '/bundles',
  bundle: (agent: string, scopeKey: string) => `/bundles/${agent}/${scopeKey}`,
  account: '/account',
} as const;

/**
 * Custom headers for raw-bytes bundle transfer. Lowercase because `fetch` and Hono
 * normalise header names to lowercase.
 */
export const API_HEADERS = {
  /** PUT: revision the client last saw; `0` means "create, must not exist yet". */
  expectedRevision: 'x-an-expected-revision',
  /** GET: revision of the returned bytes. */
  revision: 'x-an-revision',
  /** PUT and GET: lowercase hex SHA-256 of the ciphertext; makes PUT retries idempotent. */
  contentSha256: 'x-an-content-sha256',
  /** PUT and GET: bundle format version inside the ciphertext. */
  formatVersion: 'x-an-format-version',
  /** PUT and GET: base64 encrypted project name (project scopes only). */
  nameEnc: 'x-an-name-enc',
} as const;

/** `Authorization: Bearer <token>` carries the session token on authenticated routes. */
export const AUTHORIZATION_SCHEME = 'Bearer';

/** Machine-readable error codes returned by the API. */
export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'not_found',
  'username_taken',
  'revision_conflict',
  'payload_too_large',
  'rate_limited',
  'internal_error',
]);

/** Body of every non-2xx response. */
export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    /** Short by design: shown to the user, so a server cannot flood the terminal (T44). */
    message: z.string().max(1000),
    /** Set on `revision_conflict` so the CLI can tell the user a newer copy exists. */
    currentRevision: z.int().min(1).optional(),
  }),
});

export const HealthResponseSchema = z.strictObject({ status: z.literal('ok') });

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
