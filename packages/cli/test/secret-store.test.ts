import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configDir,
  createFileStore,
  createKeychainStore,
  createSecretStore,
  keychainAccount,
  osKeychain,
  SecretsFileError,
  type KeychainEntry,
  type KeychainEntryFactory,
} from '../src/index.ts';

const posix = process.platform !== 'win32';
const SERVER = 'agentnomad-api.onrender.com';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentnomad-secrets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A keychain in memory, recording which accounts were used. */
function memoryKeychain() {
  const saved = new Map<string, string>();
  const factory: KeychainEntryFactory = (service, account): KeychainEntry => {
    const key = `${service}/${account}`;
    return {
      getPassword: () => Promise.resolve(saved.get(key)),
      setPassword: (password) => {
        saved.set(key, password);
        return Promise.resolve();
      },
      deleteCredential: () => Promise.resolve(saved.delete(key)),
    };
  };
  return { saved, factory };
}

const noKeychain: KeychainEntryFactory = () => {
  throw new Error('Platform secure storage failure: no Secret Service');
};

describe('configDir', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      configDir({
        platform: 'win32',
        homedir: 'C:\\Users\\a',
        env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      }),
    ).toMatch(/AppData[\\/]Roaming[\\/]agentnomad$/);
  });

  it('uses XDG_CONFIG_HOME when absolute, else ~/.config', () => {
    const home = posix ? '/home/a' : 'C:\\home\\a';
    const xdg = posix ? '/xdg' : 'C:\\xdg';
    expect(configDir({ platform: 'linux', homedir: home, env: { XDG_CONFIG_HOME: xdg } })).toBe(
      join(xdg, 'agentnomad'),
    );
    expect(configDir({ platform: 'darwin', homedir: home, env: { XDG_CONFIG_HOME: 'rel' } })).toBe(
      join(home, '.config', 'agentnomad'),
    );
  });
});

describe('file store', () => {
  const path = () => join(dir, 'agentnomad', 'secrets.json');
  const store = (server = SERVER) => createFileStore({ path: path(), server });

  it('keeps, returns and forgets secrets', async () => {
    const secrets = store();
    expect(secrets.backend).toBe('file');
    expect(await secrets.get('session-token')).toBeNull();

    await secrets.set('session-token', 'token-1');
    await secrets.set('data-key', 'key-1');
    expect(await secrets.get('session-token')).toBe('token-1');
    expect(await secrets.get('data-key')).toBe('key-1');

    await secrets.delete('session-token');
    expect(await secrets.get('session-token')).toBeNull();
    expect(await secrets.get('data-key')).toBe('key-1');
  });

  it('keeps each server apart', async () => {
    await store().set('session-token', 'real');
    await store('localhost:3000').set('session-token', 'test');
    expect(await store().get('session-token')).toBe('real');
    await store('localhost:3000').delete('session-token');
    expect(await store().get('session-token')).toBe('real');
  });

  it('removes the file when nothing is left', async () => {
    await store().set('session-token', 'x');
    await store().delete('session-token');
    await expect(stat(path())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deleting a secret that is not there does nothing', async () => {
    await expect(store().delete('data-key')).resolves.toBeUndefined();
  });

  it('leaves no temporary files behind', async () => {
    await store().set('session-token', 'a');
    await store().set('session-token', 'b');
    expect(await readdir(join(dir, 'agentnomad'))).toEqual(['secrets.json']);
  });

  it('refuses a damaged file with a clear message', async () => {
    await store().set('session-token', 'x');
    await writeFile(path(), '{ not json');
    await expect(store().get('session-token')).rejects.toBeInstanceOf(SecretsFileError);
    await writeFile(path(), JSON.stringify({ version: 2, servers: {} }));
    await expect(store().get('session-token')).rejects.toThrow('Delete it and log in again');
  });

  it.runIf(posix)('is readable only by this user (file 600, folder 700)', async () => {
    await store().set('session-token', 'x');
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'agentnomad'))).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('takes back access others were given', async () => {
    await store().set('session-token', 'x');
    await chmod(path(), 0o644);
    await chmod(join(dir, 'agentnomad'), 0o755);
    expect(await store().get('session-token')).toBe('x');
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'agentnomad'))).mode & 0o777).toBe(0o700);
  });

  it('stores readable JSON with one section per server', async () => {
    await store().set('data-key', 'k');
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      version: 1,
      servers: { [SERVER]: { 'data-key': 'k' } },
    });
  });
});

describe('keychain store', () => {
  it('saves under "agentnomad" with one account per secret and server', async () => {
    const { saved, factory } = memoryKeychain();
    await createKeychainStore(SERVER, factory).set('session-token', 'real');
    await createKeychainStore('localhost:3000', factory).set('session-token', 'test');
    expect([...saved.keys()]).toEqual([
      'agentnomad/session-token@agentnomad-api.onrender.com',
      'agentnomad/session-token@localhost:3000',
    ]);
    expect(await createKeychainStore(SERVER, factory).get('session-token')).toBe('real');
  });

  it('returns null for a missing secret and deletes quietly', async () => {
    const store = createKeychainStore(SERVER, memoryKeychain().factory);
    expect(store.backend).toBe('keychain');
    expect(await store.get('data-key')).toBeNull();
    await expect(store.delete('data-key')).resolves.toBeUndefined();
  });
});

describe('createSecretStore', () => {
  const input = () => ({
    server: SERVER,
    platform: process.platform,
    homedir: dir,
    env: { APPDATA: join(dir, 'AppData'), XDG_CONFIG_HOME: join(dir, 'xdg') },
  });

  it('uses the keychain when it works', async () => {
    const store = await createSecretStore({ ...input(), keychain: memoryKeychain().factory });
    expect(store.backend).toBe('keychain');
  });

  it('falls back to the user-only file when there is no keychain', async () => {
    const store = await createSecretStore({ ...input(), keychain: noKeychain });
    expect(store.backend).toBe('file');
    await store.set('session-token', 'x');
    const file = join(configDir(input()), 'secrets.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      servers: { [SERVER]: { 'session-token': 'x' } },
    });
  });

  it('moves a login left in the file into the keychain once it works again (T46)', async () => {
    // A run while the keychain was locked saved the login in the file.
    const fallback = await createSecretStore({ ...input(), keychain: noKeychain });
    await fallback.set('session-token', 'token');
    await fallback.set('data-key', 'key');
    const keychain = memoryKeychain();
    const store = await createSecretStore({ ...input(), keychain: keychain.factory });
    expect(store.backend).toBe('keychain');
    expect(await store.get('session-token')).toBe('token');
    expect(await store.get('data-key')).toBe('key');
    // And the plain-text copy is gone.
    const file = createFileStore({
      path: join(configDir(input()), 'secrets.json'),
      server: SERVER,
      restrictAccess: () => Promise.resolve(),
    });
    expect(await file.get('data-key')).toBeNull();
  });

  it('on Windows, gives only this user access to the file (T46)', async () => {
    const restricted: string[] = [];
    const store = createFileStore({
      path: join(dir, 'secrets.json'),
      server: SERVER,
      platform: 'win32',
      restrictAccess: (file) => {
        restricted.push(file);
        return Promise.resolve();
      },
    });
    await store.set('data-key', 'key');
    expect(restricted).toHaveLength(1);
    expect(restricted[0]).toMatch(/secrets\.json\.[0-9a-f]+\.tmp$/);
  });

  it('falls back when the keychain fails to read (e.g. locked, no D-Bus)', async () => {
    const failing: KeychainEntryFactory = () => ({
      getPassword: () => Promise.reject(new Error('no storage access')),
      setPassword: () => Promise.reject(new Error('no storage access')),
      deleteCredential: () => Promise.reject(new Error('no storage access')),
    });
    expect((await createSecretStore({ ...input(), keychain: failing })).backend).toBe('file');
  });
});

/**
 * The real OS keychain: Windows Credential Manager and macOS Keychain in CI. Linux CI has
 * no Secret Service, so there this checks that the fallback is chosen instead.
 */
describe('real OS keychain', () => {
  const server = `test-${randomBytes(6).toString('hex')}.invalid`;
  const service = 'agentnomad-test';

  it('keeps, returns and forgets a secret, or is reported as missing', async () => {
    const store = createKeychainStore(server, osKeychain, service);
    let available = true;
    try {
      await store.get('session-token');
    } catch {
      available = false;
    }
    if (!available) {
      // Only acceptable where no keychain exists: Windows and macOS always have one, and the
      // CI step that starts GNOME Keyring on Linux sets AGENTNOMAD_EXPECT_KEYCHAIN.
      expect(process.platform).toBe('linux');
      expect(process.env['AGENTNOMAD_EXPECT_KEYCHAIN']).toBeUndefined();
      const fallback = await createSecretStore({
        server,
        platform: process.platform,
        homedir: dir,
        env: { XDG_CONFIG_HOME: join(dir, 'xdg') },
      });
      expect(fallback.backend).toBe('file');
      return;
    }
    try {
      await store.set('session-token', 'real-keychain-value');
      await store.set('data-key', 'second-secret');
      expect(await store.get('session-token')).toBe('real-keychain-value');
      expect(await store.get('data-key')).toBe('second-secret');
      expect(keychainAccount('session-token', server)).toContain(server);

      // With a working keychain, the CLI's own choice must be the keychain too.
      const chosen = await createSecretStore({
        server,
        platform: process.platform,
        homedir: dir,
        env: {},
      });
      expect(chosen.backend).toBe('keychain');
    } finally {
      await store.delete('data-key');
      await store.delete('session-token');
    }
    expect(await store.get('session-token')).toBeNull();
  });
});
