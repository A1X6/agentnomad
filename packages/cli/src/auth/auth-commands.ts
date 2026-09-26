import { DEFAULT_KDF_PARAMS, UsernameSchema, WRONG_PASSWORD_MESSAGE } from '@agentnomad/contracts';
import {
  DATA_KEY_BYTES,
  DecryptionError,
  unwrapDataKey,
  wrapDataKey,
  type CryptoService,
} from '@agentnomad/core';

import type { ApiClient } from '../api/api-client.ts';
import { ApiError } from '../api/api-errors.ts';
import type { CommandHandlers, CredentialOptions } from '../cli/commands.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import { clearLocalSession, hasLocalSession, saveLocalSession } from './local-session.ts';
import type { PasswordChecker } from './password-policy.ts';

const KDF_SALT_BYTES = 16;

export const NO_RECOVERY_WARNING =
  'There is no password reset. Your setups are encrypted with your password on this PC, ' +
  'so nobody (not even the server) can unlock them without it. Forget it and they are gone.';

export const FILE_BACKEND_NOTE =
  'No keychain found on this PC, so your login is kept in a private file only you can read ' +
  '(in your agentnomad config folder).';

/** Everything register, login and logout need; each part is created only when used. */
export interface AuthCommandDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly api: () => ApiClient;
  readonly secrets: () => Promise<SecretStore>;
  readonly crypto: () => Promise<CryptoService>;
  readonly passwordChecker: () => Promise<PasswordChecker>;
  /** Shown in the server's session list, e.g. the PC's host name. */
  readonly deviceName: string;
  /** This PC's remembered revisions and project names; cleared by account delete. */
  readonly localState?: () => LocalState;
  /** `--password-stdin` (T36): the first line of standard input. */
  readonly readPasswordStdin?: () => Promise<string>;
}

export const ACCOUNT_DELETE_WARNING =
  'This deletes your agentnomad account and every setup saved in it, on every PC. ' +
  'Files on your PCs are not touched. It cannot be undone.';

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

function validateUsername(value: string): string | undefined {
  const parsed = UsernameSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

const notEmpty = (value: string) => (value.length > 0 ? undefined : 'Enter your password.');

/** register, login and logout (T23), account delete (T35); scriptable with flags (T36). */
export function createAuthCommands(
  deps: AuthCommandDeps,
): Pick<CommandHandlers, 'register' | 'login' | 'logout' | 'accountDelete'> {
  const { prompter, reporter } = deps;

  /** `--username`, checked like a typed one; asked only when the flag is not given. */
  async function usernameFrom(options: CredentialOptions, question: string): Promise<string> {
    if (options.username === undefined) {
      return prompter.text(question, {
        ...(question === 'Choose a username' && {
          placeholder: 'lowercase letters, digits, . _ -',
        }),
        validate: validateUsername,
      });
    }
    const problem = validateUsername(options.username);
    if (problem !== undefined) throw new Error(problem);
    return options.username;
  }

  /**
   * `--password-stdin`, held to the same rules as a typed one; a rejected password stops
   * the command (there is nobody to ask again). Asked only when the flag is not given.
   */
  async function passwordFrom(
    options: CredentialOptions,
    question: string,
    validate: (value: string) => string | undefined,
  ): Promise<string> {
    if (!options.passwordStdin) return prompter.password(question, { validate });
    if (!deps.readPasswordStdin) throw new Error('--password-stdin is not available here.');
    const password = await deps.readPasswordStdin();
    if (password === '') throw new Error('--password-stdin: no password on standard input.');
    const problem = validate(password);
    if (problem !== undefined) throw new Error(problem);
    return password;
  }

  /** Slow on purpose (Argon2id, 64 MiB); a spinner shows it is working. */
  async function deriveKeys(
    crypto: CryptoService,
    password: string,
    salt: Uint8Array,
    params: Parameters<CryptoService['deriveKeys']>[2],
  ) {
    const spinner = reporter.spinner();
    spinner.start('Securing your password (takes a few seconds)…');
    try {
      return await crypto.deriveKeys(password, salt, params);
    } finally {
      spinner.stop('Password secured.');
    }
  }

  /**
   * One PC holds one login. When one exists, offers to log out first, so two accounts'
   * keys never mix. Returns false when the user keeps the current login.
   */
  async function readyForNewLogin(secrets: SecretStore, yes: boolean): Promise<boolean> {
    if (!(await hasLocalSession(secrets))) return true;
    const replace =
      yes ||
      (await prompter.confirm(
        'You are already logged in on this PC. Log out and continue?',
        false,
      ));
    if (!replace) {
      reporter.info('Nothing changed.');
      return false;
    }
    await logOut(secrets);
    return true;
  }

  function finish(secrets: SecretStore, message: string): void {
    reporter.success(message);
    if (secrets.backend === 'file') reporter.warn(FILE_BACKEND_NOTE);
  }

  /** Ends the session on the server if possible; always forgets it on this PC. */
  async function logOut(secrets: SecretStore): Promise<void> {
    try {
      await deps.api().auth.logout();
    } catch (error) {
      // unauthorized = the session had already ended on the server: nothing to do there.
      if (!(error instanceof ApiError && error.code === 'unauthorized')) {
        reporter.warn(
          'Could not reach the server, so only this PC was logged out. ' +
            'The session on the server ends by itself after 30 days unused.',
        );
      }
    } finally {
      await clearLocalSession(secrets);
    }
  }

  return {
    async register(options) {
      const secrets = await deps.secrets();
      if (!(await readyForNewLogin(secrets, options.yes))) return;

      const username = await usernameFrom(options, 'Choose a username');

      reporter.warn(NO_RECOVERY_WARNING);
      if (!options.yes && !(await prompter.confirm('I understand. Continue?', false))) {
        reporter.info('No account was created.');
        return;
      }

      const checkPassword = await deps.passwordChecker();
      const password = await passwordFrom(options, 'Choose a password (12+ characters)', (value) =>
        checkPassword(value, [username]),
      );
      // Typed twice to catch a typo; a piped password was not typed here.
      if (!options.passwordStdin) {
        await prompter.password('Type the password again', {
          validate: (value) => (value === password ? undefined : 'The passwords do not match.'),
        });
      }

      const crypto = await deps.crypto();
      const salt = crypto.randomBytes(KDF_SALT_BYTES);
      const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
      const keys = await deriveKeys(crypto, password, salt, DEFAULT_KDF_PARAMS);
      try {
        const session = await deps.api().auth.register({
          username,
          kdfSalt: toBase64(salt),
          kdfParams: DEFAULT_KDF_PARAMS,
          authKey: toBase64(keys.authKey),
          wrappedDataKey: toBase64(wrapDataKey(crypto, dataKey, keys.passwordKey)),
          deviceName: deps.deviceName,
        });
        await saveLocalSession(secrets, {
          sessionToken: session.sessionToken,
          dataKey: toBase64(dataKey),
        });
      } finally {
        keys.passwordKey.fill(0);
        dataKey.fill(0);
      }
      finish(secrets, `Account "${username}" created. You are logged in on this PC.`);
    },

    async login(options) {
      const secrets = await deps.secrets();
      if (!(await readyForNewLogin(secrets, options.yes))) return;

      const username = await usernameFrom(options, 'Username');
      const password = await passwordFrom(options, 'Password', notEmpty);

      const api = deps.api();
      // First, so a sleeping server's "waking up" notice never overlaps the key spinner.
      const prelogin = await api.auth.prelogin({ username });
      const crypto = await deps.crypto();
      const keys = await deriveKeys(
        crypto,
        password,
        fromBase64(prelogin.kdfSalt),
        prelogin.kdfParams,
      );
      try {
        const answer = await api.auth.login({
          username,
          authKey: toBase64(keys.authKey),
          deviceName: deps.deviceName,
        });
        let dataKey: Uint8Array;
        try {
          dataKey = unwrapDataKey(crypto, fromBase64(answer.wrappedDataKey), keys.passwordKey);
        } catch (error) {
          if (!(error instanceof DecryptionError)) throw error;
          throw new Error(
            'Logged in, but your data key could not be unlocked with this password.',
            {
              cause: error,
            },
          );
        }
        await saveLocalSession(secrets, {
          sessionToken: answer.sessionToken,
          dataKey: toBase64(dataKey),
        });
        dataKey.fill(0);
      } finally {
        keys.passwordKey.fill(0);
      }
      finish(secrets, `Logged in as "${username}".`);
    },

    async logout() {
      const secrets = await deps.secrets();
      if (!(await hasLocalSession(secrets))) {
        reporter.info('You are not logged in on this PC.');
        return;
      }
      await logOut(secrets);
      reporter.success('Logged out. Your login was removed from this PC.');
    },

    /**
     * Needs the username typed out, then the password, which the server needs as proof (a
     * stolen session alone cannot delete the account). --yes never skips them; from a
     * script they come from --username and --password-stdin, and then --yes must be given.
     */
    async accountDelete(options) {
      const secrets = await deps.secrets();
      if (!(await hasLocalSession(secrets))) {
        reporter.info('Log in first (`agentnomad login`) to delete your account.');
        return;
      }
      reporter.warn(ACCOUNT_DELETE_WARNING);
      // Typing the username is the confirmation; given by flags, --yes confirms instead.
      if ((options.username !== undefined || options.passwordStdin) && !options.yes) {
        throw new Error('Nothing was deleted. Add --yes to confirm deleting the account.');
      }
      const username = await usernameFrom(options, 'Type your username to confirm');
      const password = await passwordFrom(options, 'Password', notEmpty);

      const api = deps.api();
      const prelogin = await api.auth.prelogin({ username });
      const crypto = await deps.crypto();
      const keys = await deriveKeys(
        crypto,
        password,
        fromBase64(prelogin.kdfSalt),
        prelogin.kdfParams,
      );
      try {
        await api.auth.deleteAccount({ authKey: toBase64(keys.authKey) });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'unauthorized') {
          // "Wrong password" keeps the login; any other 401 means the session itself ended.
          if (error.message === WRONG_PASSWORD_MESSAGE) {
            throw new Error('Wrong username or password. Nothing was deleted.', { cause: error });
          }
          await clearLocalSession(secrets);
          throw new Error('Your session has expired. Log in again, then delete the account.', {
            cause: error,
          });
        }
        // OutcomeUnknownError (a lost answer) passes through with its own advice (T21).
        throw error;
      } finally {
        keys.passwordKey.fill(0);
        keys.authKey.fill(0);
      }
      await clearLocalSession(secrets);
      await deps.localState?.().forgetServer();
      reporter.success(
        `Account "${username}" and all its saved setups were deleted. Your login was removed from this PC.`,
      );
    },
  };
}
