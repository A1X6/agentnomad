import { type Bundle, type BundleScope, type SourceOs } from '@agentnomad/contracts';
import { createPathResolver, type BundleCodec, type CryptoService } from '@agentnomad/core';

import type {
  AgentAdapter,
  AgentRegistry,
  CollectedFile,
  ConflictChoice,
  ConflictResolver,
  DetectedAgent,
  ScopeTarget,
} from '../agents/adapter.ts';
import { agentVersionNotice } from '../agents/claude-code/version-stamp.ts';
import type { ApiClient } from '../api/api-client.ts';
import { NotLoggedInError } from '../api/api-errors.ts';
import { withSession } from '../auth/local-session.ts';
import type { CommandHandlers, PullOptions } from '../cli/commands.ts';
import { restoreEnvValues } from '../env/env-restore.ts';
import { ENV_BUNDLE_PATH, parseEnvSection } from '../env/env-section.ts';
import type { EnvWriter } from '../env/shell-profile.ts';
import { fromBundleFiles, preferLocalEquivalents } from '../push/bundle-files.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import type { LocalState } from '../state/local-state.ts';
import { AnswerNeededError } from '../ui/no-terminal-prompter.ts';
import type { Prompter, Reporter } from '../ui/prompter.ts';
import { reviewRunnable } from './command-review.ts';
import { downloadSetup, listSavedSetups, type SavedSetup } from './saved-setups.ts';

export interface PullDeps {
  readonly prompter: Prompter;
  readonly reporter: Reporter;
  readonly registry: () => AgentRegistry;
  readonly secrets: () => Promise<SecretStore>;
  readonly api: () => ApiClient;
  readonly crypto: () => Promise<CryptoService>;
  readonly codec: BundleCodec;
  readonly localState: () => LocalState;
  readonly envWriter: () => EnvWriter;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A project is restored into this folder. */
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
}

type ScopeChoice = 'global' | 'project' | 'both';

/** A setup downloaded, checked and reviewed, ready to write. */
interface Prepared {
  readonly adapter: AgentAdapter;
  readonly setup: SavedSetup;
  readonly bundle: Bundle;
  readonly revision: number;
  readonly target: ScopeTarget;
  readonly files: CollectedFile[];
  /** What this PC has now, as the collector sees it. */
  readonly current: readonly CollectedFile[];
  /** The user declined commands it holds, so they were left out. */
  readonly declined: boolean;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
type ConflictAnswer = ConflictChoice | 'merge-all' | 'overwrite-all';

const sourceOsOf = (platform: NodeJS.Platform): SourceOs =>
  platform === 'darwin' || platform === 'win32' ? platform : 'linux';

const describe = (adapter: AgentAdapter, setup: SavedSetup) =>
  `${adapter.displayName} ${setup.projectName === null ? 'global setup' : `project "${setup.projectName}"`}`;

/**
 * `agentnomad pull` (T34): choose saved setups, download and decrypt them on this PC,
 * confirm what would run programs, restore with the user's merge / overwrite / skip
 * choices, then offer plugins, programs and environment variables.
 */
export function createPullCommand(deps: PullDeps): Pick<CommandHandlers, 'pull'> {
  const { prompter, reporter } = deps;

  async function chooseAgents(
    saved: readonly SavedSetup[],
    options: PullOptions,
  ): Promise<{ adapter: AgentAdapter; version: string | null }[]> {
    const withSetups: { adapter: AgentAdapter; found: DetectedAgent }[] = [];
    for (const adapter of deps.registry().list()) {
      if (!saved.some((setup) => setup.agent === adapter.id)) continue;
      const found = await adapter.detector.detect();
      withSetups.push({ adapter, found });
    }
    if (options.agents) {
      return options.agents.map((id) => {
        const match = withSetups.find((entry) => entry.adapter.id === id);
        if (!match) throw new Error(`No saved setup for agent "${id}".`);
        return { adapter: match.adapter, version: match.found.version };
      });
    }
    if (withSetups.length <= 1 || options.yes) {
      return withSetups.map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
    }
    const count = (id: string) => saved.filter((setup) => setup.agent === id).length;
    const chosen = await prompter.multiselect(
      'Which agents?',
      withSetups.map((entry) => ({
        value: entry.adapter.id,
        label: entry.adapter.displayName,
        hint: `${entry.found.installed ? 'installed' : 'not installed here'}, ${String(count(entry.adapter.id))} saved`,
      })),
      { required: true, initial: withSetups.map((entry) => entry.adapter.id) },
    );
    return withSetups
      .filter((entry) => chosen.includes(entry.adapter.id))
      .map((entry) => ({ adapter: entry.adapter, version: entry.found.version }));
  }

  async function chooseSetups(
    adapter: AgentAdapter,
    saved: readonly SavedSetup[],
    options: PullOptions,
  ): Promise<SavedSetup[]> {
    const mine = saved.filter((setup) => setup.agent === adapter.id);
    const global = mine.find((setup) => setup.projectName === null);
    const projects = mine.filter((setup) => setup.projectName !== null);

    let choice: ScopeChoice;
    if (options.global || options.project !== undefined) {
      choice =
        options.global && options.project !== undefined
          ? 'both'
          : options.global
            ? 'global'
            : 'project';
    } else if (projects.length === 0) {
      choice = 'global';
    } else if (!global) {
      choice = 'project';
    } else if (options.yes) {
      // --yes alone restores the global setup; a project is picked with --project.
      choice = 'global';
    } else {
      choice = await prompter.select(`${adapter.displayName}: what to restore?`, [
        { value: 'global', label: 'Global setup' },
        { value: 'project', label: 'A project', hint: `into this folder: ${deps.cwd}` },
        { value: 'both', label: 'Both' },
      ]);
    }

    const chosen: SavedSetup[] = [];
    if (choice !== 'project') {
      if (!global) throw new Error(`There is no saved ${adapter.displayName} global setup.`);
      chosen.push(global);
    }
    if (choice !== 'global') {
      let project: SavedSetup | undefined;
      if (options.project !== undefined) {
        project = projects.find((setup) => setup.projectName === options.project);
        if (!project) {
          const names = projects.map((setup) => setup.projectName).join(', ') || 'none';
          throw new Error(
            `No saved ${adapter.displayName} project named "${options.project}". Saved: ${names}.`,
          );
        }
      } else if (projects.length === 1) {
        project = projects[0];
      } else {
        const remembered = await deps.localState().projectNameFor(deps.cwd);
        const pick = await prompter.select(
          'Which project? It is restored into this folder.',
          projects
            .map((setup) => ({
              value: setup.scopeKey,
              label: setup.projectName ?? '',
              ...(setup.projectName === remembered && { hint: 'saved from this folder' }),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        );
        project = projects.find((setup) => setup.scopeKey === pick);
      }
      if (project) chosen.push(project);
    }
    return chosen;
  }

  /** Per file: merge, overwrite, skip; "… all remaining" answers the rest; flags answer all. */
  function conflictResolver(options: PullOptions): ConflictResolver {
    let sticky: ConflictChoice | undefined = options.conflict;
    return async (path, question) => {
      const fixed = sticky ?? (options.yes ? 'merge' : undefined);
      if (fixed !== undefined)
        return fixed === 'overwrite' && !question.overwriteAllowed ? 'merge' : fixed;
      const answer: ConflictAnswer = await prompter.select(
        question.overwriteAllowed
          ? `${path} already exists here and is different.`
          : `${path === '.agentnomad/claude.json' ? '~/.claude.json' : path}: add your MCP servers and preferences (your login and history stay)?`,
        [
          {
            value: 'merge',
            label: 'Merge',
            hint: 'JSON: combine keys; other files: keep yours, add theirs next to it',
          },
          ...(question.overwriteAllowed
            ? [{ value: 'overwrite' as const, label: 'Overwrite', hint: 'a backup is kept' }]
            : []),
          { value: 'skip', label: 'Skip', hint: 'leave it as it is' },
          { value: 'merge-all', label: 'Merge all remaining files' },
          ...(question.overwriteAllowed
            ? [{ value: 'overwrite-all' as const, label: 'Overwrite all remaining files' }]
            : []),
        ],
      );
      if (answer === 'merge-all' || answer === 'overwrite-all') {
        sticky = answer === 'merge-all' ? 'merge' : 'overwrite';
        return sticky;
      }
      return answer;
    };
  }

  /**
   * Everything about one setup that comes before writing: download and check it, and ask
   * about an older copy and about what would run programs (T46: all setups are prepared
   * before any is written, so a question left open stops pull before it changes anything).
   * `null`: the user chose to skip it.
   */
  async function prepareOne(
    adapter: AgentAdapter,
    version: string | null,
    setup: SavedSetup,
    context: { secrets: SecretStore; crypto: CryptoService; dataKey: Uint8Array },
    options: PullOptions,
  ): Promise<Prepared | null> {
    const spinner = reporter.spinner();
    spinner.start(`Downloading and decrypting the ${describe(adapter, setup)}…`);
    let downloaded;
    try {
      downloaded = await withSession(context.secrets, () =>
        downloadSetup(setup, {
          api: deps.api(),
          crypto: context.crypto,
          codec: deps.codec,
          dataKey: context.dataKey,
        }),
      );
    } finally {
      spinner.stop();
    }
    const { bundle, revision } = downloaded;

    // Older than what this PC already had (T38): deleted and saved again from another PC,
    // or a server sending an old copy. Never restored without a yes from the user.
    const known = await deps.localState().revisionOf(adapter.id, setup.scopeKey);
    if (known !== null && revision < known) {
      const note = `The saved ${describe(adapter, setup)} is revision ${String(revision)}, older than revision ${String(known)} that this PC already had. Either it was deleted and saved again from another PC, or the server is sending an old copy.`;
      reporter.warn(note);
      if (options.yes || !(await prompter.confirm('Restore this older copy anyway?', false))) {
        reporter.info(`Skipped the ${describe(adapter, setup)}.`);
        return null;
      }
    }

    const versionNote = agentVersionNotice(adapter.displayName, bundle.agentVersion, version);
    if (versionNote !== null) reporter.warn(versionNote);

    const scope: BundleScope = bundle.scope;
    const target: ScopeTarget =
      scope.kind === 'global' ? { kind: 'global' } : { kind: 'project', projectDir: deps.cwd };
    const resolver = createPathResolver({ os: sourceOsOf(deps.platform), homeDir: deps.homedir });
    let files = fromBundleFiles(bundle.files, resolver);

    // What this PC has now: files that only differ in the home path's slashes stay as they
    // are, and anything that runs programs and is new here is confirmed before writing.
    const current = await adapter.collector.collect(target, { includeMemory: true });
    files = preferLocalEquivalents(bundle.files, files, current, resolver);
    const review = reviewRunnable(files, current);
    let declined = false;
    if (review.length > 0) {
      reporter.info(
        [
          `The ${describe(adapter, setup)} would add or change these, which run programs on this PC:`,
          ...review.map(
            (entry) =>
              `  ${entry.change === 'new' ? '+' : '~'} ${entry.label}: ${entry.command}${entry.change === 'changed' ? '  (changed)' : ''}`,
          ),
        ].join('\n'),
      );
      // --yes never accepts new code by itself (T38): only --allow-commands does.
      const allow =
        options.allowCommands === true ||
        (!options.yes && (await prompter.confirm('Allow them?', false)));
      if (!allow) {
        declined = true;
        const blocked = new Set(review.map((entry) => entry.file));
        files = files.filter((file) => !blocked.has(file.path));
        reporter.warn(
          `Skipped ${[...blocked].join(', ')}: they hold those commands or are run by them. The rest is restored.${options.yes ? ' --yes never accepts new commands; add --allow-commands to accept them.' : ''}`,
        );
      }
    }

    return { adapter, setup, bundle, revision, target, files, current, declined };
  }

  /**
   * Without a terminal (T46): every question the flags leave open is found before anything is
   * written. A file that differs here needs --merge, --overwrite or --yes; saved environment
   * values missing here need --yes.
   */
  function checkAnswerable(prepared: readonly Prepared[], options: PullOptions): void {
    if (prompter.canAsk !== false || options.yes) return;
    for (const { files, current } of prepared) {
      if (options.conflict === undefined) {
        const differs = files.find((file) => {
          const here = current.find((entry) => entry.path === file.path);
          return here !== undefined && !sameBytes(here.content, file.content);
        });
        if (differs) {
          throw new AnswerNeededError(`${differs.path} already exists here and is different.`);
        }
      }
      const envFile = files.find((file) => file.path === ENV_BUNDLE_PATH);
      const section = envFile ? parseEnvSection(envFile.content) : null;
      const missing = Object.keys(section?.variables ?? {}).filter(
        (name) => (deps.env[name] ?? '') === '',
      );
      if (missing.length > 0) throw new AnswerNeededError(`Add ${missing.join(', ')}?`);
    }
  }

  async function applyOne(
    { adapter, setup, bundle, revision, target, files, declined }: Prepared,
    resolverOfConflicts: ConflictResolver,
    options: PullOptions,
  ): Promise<void> {
    const report = await adapter.restorer.restore(target, files, resolverOfConflicts, {
      sourceOs: bundle.sourceOs,
      assumeYes: options.yes,
    });
    for (const warning of report.warnings) reporter.warn(warning);
    const parts = [
      `${String(report.written.length)} written`,
      ...(report.skipped.length > 0 ? [`${String(report.skipped.length)} skipped`] : []),
      ...(report.backups.length > 0 ? [`${String(report.backups.length)} backed up first`] : []),
    ];
    reporter.success(
      `Restored the ${describe(adapter, setup)}: ${parts.join(', ')} (revision ${String(revision)}).`,
    );

    // Declined commands are noted, so a later push asks before dropping them (T46).
    await deps
      .localState()
      .setRevision(adapter.id, setup.scopeKey, revision, { partial: declined });
    if (setup.projectName !== null)
      await deps.localState().rememberProject(deps.cwd, setup.projectName);

    await adapter.afterRestore?.({
      target,
      files,
      prompter,
      reporter,
      assumeYes: options.yes,
      allowCommands: options.allowCommands === true,
      ...(options.accountSkills !== undefined && { accountSkills: options.accountSkills }),
    });

    const envFile = files.find((file) => file.path === ENV_BUNDLE_PATH);
    const section = envFile ? parseEnvSection(envFile.content) : null;
    if (section) {
      await restoreEnvValues({
        section,
        env: deps.env,
        writer: deps.envWriter(),
        prompter,
        reporter,
        assumeYes: options.yes,
        allowCommands: options.allowCommands === true,
      });
    }
  }

  return {
    async pull(options) {
      const secrets = await deps.secrets();
      const [token, dataKeyText] = await Promise.all([
        secrets.get('session-token'),
        secrets.get('data-key'),
      ]);
      if (token === null || dataKeyText === null) throw new NotLoggedInError();
      const dataKey = new Uint8Array(Buffer.from(dataKeyText, 'base64'));
      try {
        const crypto = await deps.crypto();
        const saved = await withSession(secrets, () =>
          listSavedSetups(deps.api(), crypto, dataKey),
        );
        if (saved.length === 0) {
          reporter.info(
            'Nothing is saved yet. Run `agentnomad push` on the PC that has your setup.',
          );
          return;
        }
        const agents = await chooseAgents(saved, options);
        if (agents.length === 0) {
          reporter.info('None of the saved setups are for an agent agentnomad supports here.');
          return;
        }
        const plan: { adapter: AgentAdapter; version: string | null; setups: SavedSetup[] }[] = [];
        for (const { adapter, version } of agents) {
          plan.push({ adapter, version, setups: await chooseSetups(adapter, saved, options) });
        }

        const shown = new Set<string>();
        for (const { adapter } of plan) {
          for (const notice of (await adapter.inspector?.notices('pull')) ?? []) {
            if (!shown.has(notice)) reporter.warn(notice);
            shown.add(notice);
          }
        }

        const prepared: Prepared[] = [];
        for (const { adapter, version, setups } of plan) {
          for (const setup of setups) {
            const ready = await prepareOne(
              adapter,
              version,
              setup,
              { secrets, crypto, dataKey },
              options,
            );
            if (ready) prepared.push(ready);
          }
        }
        checkAnswerable(prepared, options);
        const resolver = conflictResolver(options);
        for (const ready of prepared) await applyOne(ready, resolver, options);
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
