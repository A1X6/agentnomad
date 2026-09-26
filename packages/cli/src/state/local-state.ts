import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { ProjectNameSchema } from '@agentnomad/contracts';
import * as z from 'zod';

/** Suffix of the note that a pull left out declined commands (T46). */
const PARTIAL = '#partial';

/** File name of the local state inside the agentnomad config folder. */
export const STATE_FILE = 'state.json';

const ServerStateSchema = z.strictObject({
  /** Project folder on this PC → the name it is saved under (T33 folder map). */
  projects: z.record(z.string(), ProjectNameSchema),
  /**
   * `<agent>/<scopeKey>` → the revision this PC last pushed or pulled. A pull that left out
   * commands the user declined is also noted as `<agent>/<scopeKey>#partial` (T46); kept in
   * this map so older versions still read the file.
   */
  revisions: z.record(z.string(), z.int().min(1)),
});

const StateFileSchema = z.strictObject({
  version: z.literal(1),
  /** One section per server host, like the secret store (T22). */
  servers: z.record(z.string(), ServerStateSchema),
});
type StateFile = z.infer<typeof StateFileSchema>;

export class LocalStateError extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(
      `agentnomad's local state file is damaged: ${path}. Delete it; you will be asked for project names again.`,
      options,
    );
    this.name = 'LocalStateError';
  }
}

/**
 * What this PC remembers between commands (T33): the name each project folder was saved
 * under, and the last revision it pushed or pulled of each setup (so the server can refuse
 * an upload that would overwrite a newer copy). Nothing secret is kept here.
 */
export interface LocalState {
  projectNameFor(folder: string): Promise<string | null>;
  rememberProject(folder: string, name: string): Promise<void>;
  revisionOf(agent: string, scopeKey: string): Promise<number | null>;
  /** `partial`: the pull left out commands the user declined (T46). */
  setRevision(
    agent: string,
    scopeKey: string,
    revision: number,
    options?: { partial?: boolean },
  ): Promise<void>;
  /** Whether this PC's last pull of the setup left out commands the user declined (T46). */
  isPartial(agent: string, scopeKey: string): Promise<boolean>;
  /** Every revision this PC knows, by `<agent>/<scopeKey>` (T35 status). */
  knownRevisions(): Promise<Readonly<Record<string, number>>>;
  /** Forgets one setup (after it was deleted on the server). */
  forgetRevision(agent: string, scopeKey: string): Promise<void>;
  /** Forgets everything about this server (after the account was deleted). */
  forgetServer(): Promise<void>;
}

export interface LocalStateOptions {
  readonly path: string;
  /** The API server host; each server has its own state. */
  readonly server: string;
  readonly platform: NodeJS.Platform;
}

export function createLocalState(options: LocalStateOptions): LocalState {
  const path = options.platform === 'win32' ? win32 : posix;
  /** Windows paths ignore case, so `E:\Projects` and `e:\projects` are the same folder. */
  const folderKey = (folder: string) => {
    const resolved = path.resolve(folder);
    return options.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };

  async function load(): Promise<StateFile> {
    let text: string;
    try {
      text = await readFile(options.path, 'utf8');
    } catch {
      return { version: 1, servers: {} };
    }
    try {
      return StateFileSchema.parse(JSON.parse(text));
    } catch (error) {
      throw new LocalStateError(options.path, { cause: error });
    }
  }

  async function update(
    change: (server: z.infer<typeof ServerStateSchema>) => void,
    remove = false,
  ): Promise<void> {
    const state = await load();
    const server = state.servers[options.server] ?? { projects: {}, revisions: {} };
    change(server);
    state.servers = remove
      ? Object.fromEntries(
          Object.entries(state.servers).filter(([host]) => host !== options.server),
        )
      : { ...state.servers, [options.server]: server };
    await mkdir(path.dirname(options.path), { recursive: true, mode: 0o700 });
    const temp = `${options.path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      await rename(temp, options.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  const server = async () => (await load()).servers[options.server];

  return {
    async projectNameFor(folder) {
      return (await server())?.projects[folderKey(folder)] ?? null;
    },
    async rememberProject(folder, name) {
      await update((state) => {
        state.projects[folderKey(folder)] = ProjectNameSchema.parse(name);
      });
    },
    async revisionOf(agent, scopeKey) {
      return (await server())?.revisions[`${agent}/${scopeKey}`] ?? null;
    },
    async setRevision(agent, scopeKey, revision, setOptions = {}) {
      const key = `${agent}/${scopeKey}`;
      await update((state) => {
        state.revisions = Object.fromEntries(
          Object.entries(state.revisions).filter(([name]) => name !== `${key}${PARTIAL}`),
        );
        state.revisions[key] = revision;
        if (setOptions.partial === true) state.revisions[`${key}${PARTIAL}`] = 1;
      });
    },
    async isPartial(agent, scopeKey) {
      return (await server())?.revisions[`${agent}/${scopeKey}${PARTIAL}`] !== undefined;
    },
    async knownRevisions() {
      return Object.fromEntries(
        Object.entries((await server())?.revisions ?? {}).filter(([key]) => !key.endsWith(PARTIAL)),
      );
    },
    async forgetRevision(agent, scopeKey) {
      const key = `${agent}/${scopeKey}`;
      await update((state) => {
        state.revisions = Object.fromEntries(
          Object.entries(state.revisions).filter(
            ([name]) => name !== key && name !== `${key}${PARTIAL}`,
          ),
        );
      });
    },
    async forgetServer() {
      await update(() => undefined, true);
    },
  };
}
