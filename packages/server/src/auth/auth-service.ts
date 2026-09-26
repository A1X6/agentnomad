import { DEFAULT_KDF_PARAMS, type KdfParams, type Username } from '@agentnomad/contracts';

import type { NewUser, SessionRepository, UserRepository } from '../db/repositories.ts';
import {
  RATE_LIMITS,
  RateLimitedError,
  type RateLimiter,
  type RateLimitRule,
} from '../rate-limit/rate-limiter.ts';
import type { ServerKeys } from './server-keys.ts';
import { hashSessionToken, newSessionToken } from './session-tokens.ts';

/** A session ends this long after login, however often it is used. */
export const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** A session unused for this long ends early (a forgotten old PC). */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_used_at` is refreshed at most this often, to avoid a write on every request. */
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Wrong username or wrong password: deliberately the same error for both. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Wrong username or password');
    this.name = 'InvalidCredentialsError';
  }
}

export interface PreloginResult {
  readonly kdfSalt: Uint8Array;
  readonly kdfParams: KdfParams;
}

export interface IssuedSession {
  /** Shown to the client once; only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface LoginResult extends IssuedSession {
  readonly wrappedDataKey: Uint8Array;
}

export interface RegisterInput extends Omit<NewUser, 'authHash'> {
  readonly authKey: Uint8Array;
  readonly deviceName: string;
}

/** Who a valid session token belongs to. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
}

/** Account and session logic (T15), free of HTTP so it can be tested and reused directly. */
export interface AuthService {
  prelogin(username: Username): Promise<PreloginResult>;
  /** Throws UsernameTakenError when the name is taken. */
  register(input: RegisterInput): Promise<IssuedSession>;
  /** Throws InvalidCredentialsError for an unknown user or a wrong auth key. */
  login(username: Username, authKey: Uint8Array, deviceName: string): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;
  /**
   * Deletes the account with its sessions, setups and files (T17). Needs the auth key as well
   * as a session, so a stolen token alone cannot do it. Throws InvalidCredentialsError.
   */
  deleteAccount(userId: string, authKey: Uint8Array): Promise<void>;
  /** `null` for an unknown, expired or idle session. */
  authenticate(token: string): Promise<AuthenticatedSession | null>;
}

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly keys: ServerKeys;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
  /** Counts failed logins and account deletes per account (T18). */
  readonly limiter: RateLimiter;
}

const FAILED = RATE_LIMITS.failedLoginsPerAccount;

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { users, sessions, keys, now, randomBytes, limiter } = deps;

  /**
   * Runs a password check with the per-account failure limit: refused while the account has
   * too many recent failures, a failure counts, a success clears the count. Unknown usernames
   * are counted the same way, so the limit reveals nothing either.
   */
  async function guardedCheck(
    rule: RateLimitRule,
    subject: string,
    check: () => Promise<boolean>,
  ): Promise<void> {
    // Counted before the check, in one atomic step (T47): many guesses sent at once cannot
    // all pass a count read before any of them was added.
    const status = await limiter.hit(rule, subject);
    if (!status.allowed) throw new RateLimitedError(status.retryAfterSeconds);
    if (!(await check())) throw new InvalidCredentialsError();
    await limiter.reset(rule, subject);
  }

  async function issueSession(userId: string, deviceName: string): Promise<IssuedSession> {
    const token = newSessionToken(randomBytes);
    const expiresAt = new Date(now().getTime() + SESSION_LIFETIME_MS);
    await sessions.create({
      userId,
      tokenHash: await hashSessionToken(token),
      deviceName,
      expiresAt,
    });
    return { token, expiresAt };
  }

  return {
    async prelogin(username) {
      const user = await users.findByUsername(username);
      if (user) return { kdfSalt: user.kdfSalt, kdfParams: user.kdfParams };
      // Same shape and default settings as a real account, and the same salt every time
      // for the same name, so repeated prelogins cannot tell it apart from a real one.
      return { kdfSalt: await keys.fakeSalt(username), kdfParams: DEFAULT_KDF_PARAMS };
    },

    async register(input) {
      const user = await users.create({
        username: input.username,
        kdfSalt: input.kdfSalt,
        kdfParams: input.kdfParams,
        authHash: await keys.hashAuthKey(input.authKey),
        wrappedDataKey: input.wrappedDataKey,
      });
      return issueSession(user.id, input.deviceName);
    },

    async login(username, authKey, deviceName) {
      const user = await users.findByUsername(username);
      // Do the same hashing work for an unknown user, so response time does not reveal
      // whether the account exists.
      await guardedCheck(
        FAILED,
        username,
        async () => (await keys.verifyAuthKey(authKey, user?.authHash ?? '')) && user !== null,
      );
      if (!user) throw new InvalidCredentialsError();
      // Housekeeping: sessions whose token was lost (e.g. a logout without internet) or that
      // ran out are otherwise never removed.
      await sessions.deleteStale(user.id, SESSION_IDLE_TIMEOUT_MS);
      const session = await issueSession(user.id, deviceName);
      return { ...session, wrappedDataKey: user.wrappedDataKey };
    },

    async logout(sessionId) {
      await sessions.delete(sessionId);
    },

    async deleteAccount(userId, authKey) {
      const user = await users.findById(userId);
      if (!user) throw new InvalidCredentialsError();
      // Its own count, keyed by the account (only its sessions can reach this), so failed
      // logins by others never block the owner (T47).
      await guardedCheck(RATE_LIMITS.failedDeletesPerAccount, user.id, () =>
        keys.verifyAuthKey(authKey, user.authHash),
      );
      // ON DELETE CASCADE removes sessions, setups and files in the same statement.
      await users.delete(user.id);
    },

    async authenticate(token) {
      const session = await sessions.findByTokenHash(await hashSessionToken(token));
      if (!session) return null;

      const idleFor = now().getTime() - session.lastUsedAt.getTime();
      if (idleFor > SESSION_IDLE_TIMEOUT_MS) {
        await sessions.delete(session.id);
        return null;
      }
      if (idleFor > TOUCH_INTERVAL_MS) await sessions.touch(session.id);
      return { sessionId: session.id, userId: session.userId };
    },
  };
}
