import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import * as z from 'zod';

import type { SecretName, SecretStore } from './secret-store.ts';

/** File name of the fallback store inside the config folder. */
export const SECRETS_FILE = 'secrets.json';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const SecretsSchema = z.strictObject({
  'session-token': z.string().min(1).optional(),
  'data-key': z.string().min(1).optional(),
});

const SecretsFileSchema = z.strictObject({
  version: z.literal(1),
  /** One set of secrets per server, keyed by host (e.g. `agentnomad-api.onrender.com`). */
  servers: z.record(z.string().min(1), SecretsSchema),
});

type SecretsFile = z.infer<typeof SecretsFileSchema>;

export interface FileStoreOptions {
  /** Full path of the secrets file. */
  readonly path: string;
  readonly server: string;
  readonly platform?: NodeJS.Platform;
  /**
   * Windows: gives only the current user access to a file (T46), since file modes there
   * only control writing. Injectable for tests.
   */
  readonly restrictAccess?: (file: string) => Promise<void>;
}

/** Runs a Windows tool without a shell; its standard output, or a rejection. */
function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(`${command} failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    });
  });
}

/**
 * Windows: removes inherited access and grants the current user (by SID, from `whoami`)
 * full control, so the file stays private wherever the config folder is (T46).
 */
export async function windowsOwnerOnly(file: string): Promise<void> {
  // By full path: Git for Windows puts a Unix `whoami` earlier on PATH.
  const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
  const csv = await run(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[0-9-]+)"/.exec(csv)?.[1];
  if (sid === undefined) throw new Error('Could not find the current user.');
  await run(join(system32, 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`]);
}

export class SecretsFileError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`The secrets file is damaged: ${path}. Delete it and log in again.`, options);
    this.name = 'SecretsFileError';
  }
}

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * SecretStore in a file only this user can read, for PCs without a keychain (servers,
 * WSL, SSH). The secrets are not encrypted here: the file permissions are the protection,
 * like an SSH private key without a passphrase.
 */
export function createFileStore(options: FileStoreOptions): SecretStore {
  const { path, server } = options;
  const posix = (options.platform ?? process.platform) !== 'win32';
  const restrictAccess = options.restrictAccess ?? (posix ? null : windowsOwnerOnly);

  /** On macOS/Linux, takes back access others were given to the file or its folder. */
  async function lockDown(): Promise<void> {
    if (!posix) return;
    for (const [target, mode] of [
      [dirname(path), DIR_MODE],
      [path, FILE_MODE],
    ] as const) {
      const { mode: current } = await stat(target);
      if ((current & 0o077) !== 0) await chmod(target, mode);
    }
  }

  async function load(): Promise<SecretsFile> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return { version: 1, servers: {} };
      throw error;
    }
    await lockDown();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new SecretsFileError(path, { cause: error });
    }
    const parsed = SecretsFileSchema.safeParse(json);
    if (!parsed.success) throw new SecretsFileError(path, { cause: parsed.error });
    return parsed.data;
  }

  /** Writes a new file next to the old one, then swaps it in, so a crash never leaves half a file. */
  async function save(file: SecretsFile): Promise<void> {
    if (Object.keys(file.servers).length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    const temp = join(dirname(path), `.${SECRETS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
        mode: FILE_MODE,
        flag: 'wx',
      });
      // Before it takes the real name, so the secrets are never readable by others. Best
      // effort: without the tools the folder's own permissions still apply.
      await restrictAccess?.(temp).catch(() => undefined);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await lockDown();
  }

  return {
    backend: 'file',
    async get(name) {
      return (await load()).servers[server]?.[name] ?? null;
    },
    async set(name, value) {
      const file = await load();
      file.servers[server] = { ...file.servers[server], [name]: value };
      await save(file);
    },
    async delete(name: SecretName) {
      const file = await load();
      const secrets = file.servers[server];
      if (secrets?.[name] === undefined) return;
      const rest = Object.fromEntries(Object.entries(secrets).filter(([key]) => key !== name));
      if (Object.keys(rest).length === 0) {
        file.servers = Object.fromEntries(
          Object.entries(file.servers).filter(([host]) => host !== server),
        );
      } else {
        file.servers[server] = rest;
      }
      await save(file);
    },
  };
}
