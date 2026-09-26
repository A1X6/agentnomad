import { join } from 'node:path';

import { configDir, type ConfigDirInput } from '../config/config-dir.ts';
import { createFileStore, SECRETS_FILE } from './file-store.ts';
import { createKeychainStore, osKeychain, type KeychainEntryFactory } from './keychain-store.ts';
import type { SecretStore } from './secret-store.ts';

export interface CreateSecretStoreOptions extends ConfigDirInput {
  /** The API server these secrets belong to (its URL host, e.g. `localhost:3000`). */
  readonly server: string;
  readonly keychain?: KeychainEntryFactory;
  /** For tests: see FileStoreOptions. */
  readonly restrictAccess?: (file: string) => Promise<void>;
}

/**
 * The OS keychain when it works on this PC, otherwise the user-only file (T22). The
 * keychain is tried once by reading the session token: that fails fast where there is no
 * keychain (Linux without Secret Service, WSL, SSH sessions). Check `backend` to tell the
 * user when the file is used.
 *
 * A keychain can also fail for a while (locked, a "Deny" click, slow at login), and the file
 * is used then. When it works again, a login left in the file is moved into it and removed
 * from the file (T46), so it is neither stranded nor left in plain text.
 */
export async function createSecretStore(options: CreateSecretStoreOptions): Promise<SecretStore> {
  const keychain = createKeychainStore(options.server, options.keychain ?? osKeychain);
  const file = createFileStore({
    path: join(configDir(options), SECRETS_FILE),
    server: options.server,
    platform: options.platform,
    ...(options.restrictAccess && { restrictAccess: options.restrictAccess }),
  });
  let token: string | null;
  try {
    token = await keychain.get('session-token');
  } catch {
    return file;
  }
  if (token === null) {
    const [fileToken, fileKey] = await Promise.all([
      file.get('session-token'),
      file.get('data-key'),
    ]).catch(() => [null, null] as const);
    if (fileToken !== null && fileKey !== null) {
      try {
        await keychain.set('session-token', fileToken);
        await keychain.set('data-key', fileKey);
      } catch {
        return file;
      }
      await file.delete('session-token');
      await file.delete('data-key');
    }
  }
  return keychain;
}
