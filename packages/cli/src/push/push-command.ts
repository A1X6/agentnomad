import { basename, posix, win32 } from 'node:path';

import {
  BUNDLE_FORMAT_VERSION,
  MAX_BUNDLE_BYTES,
  ProjectNameSchema,
  type Bundle,
  type BundleScope,
  type SourceOs,
} from '@agentnomad/contracts';
import {
  createPathResolver,
  encryptProjectName,
  scopeKeyFor,
  sealBundle,
  type BundleCodec,
  type CryptoService,
} from '@agentnomad/core';

import type { AgentAdapter, AgentRegistry, CollectedFile, ScopeTarget } from '../agents/adapter.ts';
import { unknownEntriesNotice } from '../agents/claude-code/unknown-files.ts';
import type { ApiClient } from '../api/api-client.ts';
import { ApiError } from '../api/api-errors.ts';
import { withSession } from '../auth/local-session.ts';
import type { CommandHandlers, PushOptions } from '../cli/commands.ts';
import { scanEnvReferences } from '../env/env-references.ts';
import { chooseEnvValues, envSectionFile } from '../env/env-section.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import { listSavedRevisions } from '../pull/saved-setups.ts';
import { AnswerNeededError } from '../ui/no-terminal-prompter.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import { toBundleFiles } from './bundle-files.ts';

export interface PushDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly registry: () => AgentRegistry;
  readonly secrets: () => Promise<SecretStore>;
  readonly api: () => ApiClient;
  readonly crypto: () => Promise<CryptoService>;
  readonly codec: BundleCodec;
  readonly localState: () => LocalState;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder push runs in: the project, when a project is chosen. */
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

/** Not logged in on this PC (no session or no unlocked data key). */
export class NotLoggedInPushError extends Error {
  constructor() {
    super('You are not logged in on this PC. Run `agentnomad login` first.');
    this.name = 'NotLoggedInPushError';
  }
}

type ScopeChoice = 'global' | 'project' | 'both';

/** One save: an agent and a scope. */
interface PushItem {
  readonly adapter: AgentAdapter;
  readonly version: string | null;
  readonly scope: BundleScope;
  readonly target: ScopeTarget;
}

/** An encrypted bundle, ready to upload. */
interface Sealed {
  readonly ciphertext: Uint8Array;
  readonly contentSha256: string;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const sizeOf = (bytes: number) =>
  bytes < 1024
    ? `${String(bytes)} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `darwin` / `win32` stay; anything else counts as Linux for the bundle's source OS. */
const sourceOsOf = (platform: NodeJS.Platform): SourceOs =>
  platform === 'darwin' || platform === 'win32' ? platform : 'linux';

const describe = (item: PushItem) =>
  `${item.adapter.displayName} ${item.scope.kind === 'global' ? 'global setup' : `project "${item.scope.name}"`}`;

/**
 * `agentnomad push` (T33): choose agents and scopes, collect, make paths portable, stamp,
 * compress, encrypt on this PC and upload. The server only ever receives ciphertext and a
 * keyed hash of each project name.
 */
export function createPushCommand(deps: PushDeps): Pick<CommandHandlers, 'push'> {
  const { prompter, reporter } = deps;
  const path = deps.platform === 'win32' ? win32 : posix;
  const samePath = (a: string, b: string) =>
    deps.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);

  async function chooseAgents(
    options: PushOptions,
  ): Promise<{ adapter: AgentAdapter; version: string | null }[]> {
    const registry = deps.registry();
    const detected = await Promise.all(
      registry.list().map(async (adapter) => ({ adapter, found: await adapter.detector.detect() })),
    );
    const installed = detected.filter((entry) => entry.found.installed);
    if (options.agents) {
      return options.agents.map((id) => {
        const match = detected.find((entry) => entry.adapter.id === id);
        if (!match)
          throw new Error(
            `Unknown agent "${id}". Run \`agentnomad agents\` to see the supported ones.`,
          );
        if (!match.found.installed)
          throw new Error(`${match.adapter.displayName} is not installed on this PC.`);
        return { adapter: match.adapter, version: match.found.version };
      });
    }
    if (installed.length === 0) return [];
    if (installed.length === 1 || options.yes) {
      return installed.map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
    }
    const chosen = await prompter.multiselect(
      'Which agents?',
      installed.map((entry) => ({
        value: entry.adapter.id,
        label: entry.adapter.displayName,
        ...(entry.found.version !== null && { hint: entry.found.version }),
      })),
      { required: true, initial: installed.map((entry) => entry.adapter.id) },
    );
    return installed
      .filter((entry) => chosen.includes(entry.adapter.id))
      .map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
  }

  async function chooseScope(adapter: AgentAdapter, options: PushOptions): Promise<ScopeChoice> {
    const inHome = samePath(deps.cwd, deps.homedir);
    if (options.global && options.project !== undefined) return 'both';
    if (options.global) return 'global';
    if (options.project !== undefined) return 'project';
    // The home folder is never offered as a project: it would sweep up the whole user folder.
    if (inHome || options.yes) return 'global';
    return prompter.select(`${adapter.displayName}: what to save?`, [
      { value: 'global', label: 'Global setup', hint: 'your settings, skills, agents, commands…' },
      { value: 'project', label: 'This project', hint: deps.cwd },
      { value: 'both', label: 'Both' },
    ]);
  }

  /** The folder's saved name, the `--project` name, or a new one the user types once. */
  async function projectName(options: PushOptions): Promise<string> {
    const state = deps.localState();
    const name =
      (options.project ??
        (await state.projectNameFor(deps.cwd)) ??
        (
          await prompter.text('Name this project (you will pick it by this name on other PCs)', {
            placeholder: basename(deps.cwd),
            validate: (value) => {
              const parsed = ProjectNameSchema.safeParse(value.trim() || basename(deps.cwd));
              return parsed.success ? undefined : parsed.error.issues[0]?.message;
            },
          })
        ).trim()) ||
      basename(deps.cwd);
    await state.rememberProject(deps.cwd, name);
    return name;
  }

  /**
   * Uploads one encrypted bundle; asks before replacing a newer copy from another PC. The
   * server saves an upload as `expectedRevision + 1`, and each attempt is encrypted with
   * that revision inside (T38), so the first try reuses `first` and a retry re-encrypts.
   */
  async function upload(
    item: PushItem,
    secrets: SecretStore,
    scopeKey: string,
    first: { expectedRevision: number; sealed: Sealed },
    seal: (revision: number) => Promise<Sealed>,
    nameEnc: string | undefined,
    options: PushOptions,
    beforeAsking: () => void = () => undefined,
  ): Promise<number | null> {
    const api = deps.api();
    const params = { agent: item.adapter.id, scopeKey };
    const put = async (expectedRevision: number, sealed?: Sealed) => {
      const { ciphertext, contentSha256 } = sealed ?? (await seal(expectedRevision + 1));
      return withSession(secrets, () =>
        api.bundles.put(params, {
          ciphertext,
          expectedRevision,
          contentSha256,
          formatVersion: BUNDLE_FORMAT_VERSION,
          ...(nameEnc !== undefined && { nameEnc }),
        }),
      );
    };
    try {
      return (await put(first.expectedRevision, first.sealed)).revision;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'revision_conflict')) throw error;
      const current = error.currentRevision;
      const question =
        current === undefined
          ? `The saved ${describe(item)} was deleted since this PC last had it. Save it again?`
          : `A newer copy of the ${describe(item)} (revision ${String(current)}) was saved from another PC. Replace it with this PC's setup?`;
      // A question drawn over a running spinner is garbled (T46).
      beforeAsking();
      if (options.yes || !(await prompter.confirm(question, false))) {
        reporter.warn(
          `Skipped the ${describe(item)}: ${current === undefined ? 'it was deleted on the server' : 'a newer copy exists'}. Run \`agentnomad pull\` first to keep its changes.`,
        );
        return null;
      }
      return (await put(current ?? 0)).revision;
    }
  }

  /**
   * Without a terminal and without --yes (T46): a setup the server has in another revision
   * than this PC knows, or one whose last pull here left out declined commands, would need
   * an answer while uploading. Found before anything is saved.
   */
  async function checkAnswerable(
    ready: readonly { item: PushItem; scopeKey: string }[],
    secrets: SecretStore,
  ): Promise<void> {
    const saved = await withSession(secrets, () => listSavedRevisions(deps.api()));
    for (const { item, scopeKey } of ready) {
      const state = deps.localState();
      const known = await state.revisionOf(item.adapter.id, scopeKey);
      const onServer = saved.get(`${item.adapter.id}/${scopeKey}`);
      if ((onServer ?? null) !== known) {
        throw new AnswerNeededError(
          onServer === undefined
            ? `The saved ${describe(item)} was deleted since this PC last had it. Save it again?`
            : `A newer copy of the ${describe(item)} was saved from another PC. Replace it?`,
        );
      }
      if (await state.isPartial(item.adapter.id, scopeKey)) {
        throw new AnswerNeededError(
          `This PC's last pull of the ${describe(item)} left out commands you declined. Push anyway?`,
        );
      }
    }
  }

  return {
    async push(options) {
      const secrets = await deps.secrets();
      const [token, dataKeyText] = await Promise.all([
        secrets.get('session-token'),
        secrets.get('data-key'),
      ]);
      if (token === null || dataKeyText === null) throw new NotLoggedInPushError();
      const dataKey = new Uint8Array(Buffer.from(dataKeyText, 'base64'));

      const agents = await chooseAgents(options);
      if (agents.length === 0) {
        reporter.info('No supported agent is installed on this PC, so there is nothing to push.');
        return;
      }

      const items: PushItem[] = [];
      let name: string | null = null;
      for (const { adapter, version } of agents) {
        const choice = await chooseScope(adapter, options);
        if (choice !== 'project')
          items.push({ adapter, version, scope: { kind: 'global' }, target: { kind: 'global' } });
        if (choice !== 'global') {
          name ??= await projectName(options);
          items.push({
            adapter,
            version,
            scope: { kind: 'project', name },
            target: { kind: 'project', projectDir: deps.cwd },
          });
        }
      }

      const includeMemory =
        options.memory ??
        (options.yes
          ? false
          : await prompter.confirm(
              'Include memory (what Claude learned: subagent and auto memory)?',
              false,
            ));

      // T42: a copy of the user's own claude.ai skills, for PCs without that account. Only
      // asked when there are some, and only for the global setup.
      const pushesGlobal = items.some((item) => item.scope.kind === 'global');
      let includeAccountSkills = false;
      if (pushesGlobal && options.accountSkills !== false) {
        const names: string[] = [];
        for (const { adapter } of agents) {
          const found = await adapter.inspector?.accountSkills?.();
          if (found?.problem)
            reporter.warn(`${found.problem} Your claude.ai skills were not saved.`);
          names.push(...(found?.names ?? []));
        }
        if (names.length > 0) {
          includeAccountSkills =
            options.accountSkills ??
            (!options.yes &&
              (await prompter.confirm(
                `Also save a copy of your ${String(names.length)} claude.ai skill${names.length === 1 ? '' : 's'} (${names.join(', ')})? Your claude.ai account already syncs them; the copy is for PCs without that account.`,
                false,
              )));
        } else if (options.accountSkills === true) {
          reporter.info('No claude.ai skills of your own were found on this PC.');
        }
      }

      const shown = new Set<string>();
      for (const { adapter } of agents) {
        for (const notice of (await adapter.inspector?.notices('push')) ?? []) {
          if (!shown.has(notice)) reporter.warn(notice);
          shown.add(notice);
        }
      }

      const crypto = await deps.crypto();
      const resolver = createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir });
      try {
        // First collect every setup and ask everything, then upload (T46): a question left
        // open without a terminal stops push before anything is saved.
        const ready: { item: PushItem; bundle: Omit<Bundle, 'revision'>; scopeKey: string }[] = [];
        for (const item of items) {
          const leftOut: string[] = [];
          const collected: CollectedFile[] = [
            ...(await item.adapter.collector.collect(item.target, {
              includeMemory,
              includeAccountSkills: includeAccountSkills && item.scope.kind === 'global',
              onSkipped: (path, reason) => leftOut.push(`  - ${path}: ${reason}`),
            })),
          ];
          if (leftOut.length > 0) {
            reporter.warn([`${describe(item)}: left out`, ...leftOut].join('\n'));
          }
          const unknown = unknownEntriesNotice(
            (await item.adapter.inspector?.unknownEntries(item.target)) ?? [],
          );
          if (unknown !== null) reporter.warn(`${describe(item)}: ${unknown}`);
          if (collected.length === 0) {
            reporter.info(`Nothing to save for the ${describe(item)}.`);
            continue;
          }

          const envSection = options.yes
            ? null
            : await chooseEnvValues({
                scan: scanEnvReferences(collected),
                env: deps.env,
                prompter,
              });
          if (envSection) collected.push(envSectionFile(envSection));

          const bundle: Omit<Bundle, 'revision'> = {
            formatVersion: BUNDLE_FORMAT_VERSION,
            agent: item.adapter.id,
            scope: item.scope,
            sourceOs: sourceOsOf(deps.platform),
            agentVersion: item.version,
            files: toBundleFiles(collected, resolver),
          };
          ready.push({ item, bundle, scopeKey: scopeKeyFor(crypto, dataKey, item.scope) });
        }
        if (prompter.canAsk === false && !options.yes) await checkAnswerable(ready, secrets);

        for (const { item, bundle, scopeKey } of ready) {
          // A pull that left out commands the user declined (T46): this PC's copy lacks them,
          // so replacing the saved one would drop them for every PC.
          if (await deps.localState().isPartial(item.adapter.id, scopeKey)) {
            const question = `This PC's last pull of the ${describe(item)} left out commands you declined, so pushing now removes them from the saved copy (and from your other PCs on their next pull). Push anyway?`;
            if (options.yes || !(await prompter.confirm(question, false))) {
              reporter.warn(
                `Skipped the ${describe(item)}: its last pull here left out commands you declined. Pull it with --allow-commands (or answer yes) first, or push without --yes to choose.`,
              );
              continue;
            }
          }
          const spinner = reporter.spinner();
          spinner.start(`Encrypting and uploading the ${describe(item)}…`);
          let revision: number | null;
          let size: number;
          let spinning = true;
          const stopSpinner = () => {
            if (spinning) spinner.stop();
            spinning = false;
          };
          try {
            const seal = async (revision: number): Promise<Sealed> => {
              const ciphertext = sealBundle(
                crypto,
                await deps.codec.encode({ ...bundle, revision }),
                dataKey,
                { formatVersion: BUNDLE_FORMAT_VERSION, agent: bundle.agent, scopeKey },
              );
              return { ciphertext, contentSha256: toHex(crypto.sha256(ciphertext)) };
            };
            const expectedRevision =
              (await deps.localState().revisionOf(item.adapter.id, scopeKey)) ?? 0;
            const sealed = await seal(expectedRevision + 1);
            size = sealed.ciphertext.byteLength;
            if (size > MAX_BUNDLE_BYTES) {
              stopSpinner();
              reporter.error(
                `The ${describe(item)} is ${sizeOf(size)} after compression and encryption; the limit is 5 MB. Remove large files (e.g. images in skills) and try again.`,
              );
              continue;
            }
            const nameEnc =
              item.scope.kind === 'project'
                ? Buffer.from(
                    encryptProjectName(crypto, dataKey, item.scope.name, {
                      agent: bundle.agent,
                      scopeKey,
                    }),
                  ).toString('base64')
                : undefined;
            revision = await upload(
              item,
              secrets,
              scopeKey,
              { expectedRevision, sealed },
              seal,
              nameEnc,
              options,
              stopSpinner,
            );
            if (revision !== null)
              await deps.localState().setRevision(item.adapter.id, scopeKey, revision);
          } finally {
            stopSpinner();
          }
          if (revision !== null) {
            const count = bundle.files.length;
            reporter.success(
              `Saved the ${describe(item)}: ${String(count)} file${count === 1 ? '' : 's'}, ${sizeOf(size)} (revision ${String(revision)}).`,
            );
          }
        }
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
