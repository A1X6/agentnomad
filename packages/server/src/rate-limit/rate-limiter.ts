/** A limit: at most `limit` hits per subject in each window of `windowSeconds`. */
export interface RateLimitRule {
  /** Part of the stored key, so each rule counts separately. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitStatus {
  readonly allowed: boolean;
  /** Seconds until the current window ends (for Retry-After); 0 when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Counts requests per rule and subject (T18). Postgres in v1 so every server instance
 * shares the counts; Redis or a platform limiter could replace it with no route changes.
 */
export interface RateLimiter {
  /** Counts one hit and says whether it is within the limit. */
  hit(rule: RateLimitRule, subject: string): Promise<RateLimitStatus>;
  /** Says whether the limit is already reached, without counting. */
  check(rule: RateLimitRule, subject: string): Promise<RateLimitStatus>;
  /** Forgets the count, e.g. after a successful login. */
  reset(rule: RateLimitRule, subject: string): Promise<void>;
}

/** Too many requests; the client may retry after `retryAfterSeconds`. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Too many attempts. Try again in ${String(retryAfterSeconds)} seconds`);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The limits from the T18 plan (OWASP authentication guidance). */
export const RATE_LIMITS = {
  /** Any prelogin, register or login from one IP: slows username probing and hammering. */
  authPerIp: { name: 'auth-ip', limit: 30, windowSeconds: 60 },
  /** Account creation from one IP: stops mass sign-ups. */
  registerPerIp: { name: 'register-ip', limit: 5, windowSeconds: 60 * 60 },
  /**
   * Failed logins or account deletes per account (not per IP, which attackers rotate).
   * A pause, never a lockout, so nobody can lock another user out for long.
   */
  failedLoginsPerAccount: { name: 'login-fail', limit: 10, windowSeconds: 15 * 60 },
  /**
   * Account deletes with a wrong password, per account (T47): kept apart from logins, so
   * someone guessing logins for a username cannot stop its owner from deleting the account.
   */
  failedDeletesPerAccount: { name: 'delete-fail', limit: 10, windowSeconds: 15 * 60 },
  /**
   * Saves and deletes of setups per account (T47): far more than anyone pushes by hand, few
   * enough that one account cannot churn the database.
   */
  writesPerAccount: { name: 'bundle-write', limit: 120, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;
