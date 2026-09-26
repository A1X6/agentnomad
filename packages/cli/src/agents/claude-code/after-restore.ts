import { readdir } from 'node:fs/promises';

import * as z from 'zod';

import type { AfterRestoreContext, CollectedFile, Restorer } from '../adapter.ts';
import { ACCOUNT_SKILLS_PREFIX, planAccountSkills, readSyncedSkills } from './account-skills.ts';
import {
  claudeConfigDir,
  findClaudeExecutable,
  findExecutable,
  type DetectorSystem,
} from './detector.ts';
import { createFileGatherer } from './file-gathering.ts';
import { PLUGINS_BUNDLE_PATH, PROGRAMS_BUNDLE_PATH } from './global-paths.ts';
import {
  detectManagedSettings,
  explainPluginFailure,
  nodeManagedSettingsSystem,
} from './managed-settings.ts';
import { createClaudeCli, readCurrentPlugins, syncPlugins, type ClaudeCli } from './plugin-sync.ts';
import { PluginManifestSchema } from './plugins.ts';

/** `.agentnomad/programs.json`, checked before anything from it reaches a command line. */
const ProgramsFileSchema = z.strictObject({
  programs: z.array(
    z.strictObject({
      command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      npm: z
        .strictObject({
          package: z.string().regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
          version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
        })
        .nullable(),
    }),
  ),
});

function readJson<S extends z.ZodType>(
  files: readonly CollectedFile[],
  path: string,
  schema: S,
): z.infer<S> | null {
  const file = files.find((entry) => entry.path === path);
  if (!file) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(file.content)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface AfterRestoreDeps {
  readonly system: DetectorSystem;
  /** Runs a found program (`claude`, `npm`); injected for tests. */
  readonly cli?: (path: string) => ClaudeCli;
  /** Writes saved claude.ai skills as local skills (T42), with the restorer's safety rules. */
  readonly restorer?: Restorer;
}

/**
 * What pull does after writing a Claude Code setup (T34): reinstall its plugins (T29) and
 * offer to install programs its hooks or status line need (T25), each after asking.
 */
export function createClaudeCodeAfterRestore(deps: AfterRestoreDeps) {
  const cli = deps.cli ?? ((path: string) => createClaudeCli(path, deps.system.env));

  async function plugins(context: AfterRestoreContext): Promise<void> {
    const manifest = readJson(context.files, PLUGINS_BUNDLE_PATH, PluginManifestSchema);
    if (manifest === null || manifest.plugins.length === 0) return;
    const claudePath = await findClaudeExecutable(deps.system);
    if (claudePath === null) {
      context.reporter.warn(
        `${String(manifest.plugins.length)} saved plugin(s) were not reinstalled: the claude command was not found. Install Claude Code, then pull again.`,
      );
      return;
    }
    const baseDir = claudeConfigDir(deps.system);
    const managed = await detectManagedSettings(
      nodeManagedSettingsSystem(deps.system.env, baseDir, deps.system.platform),
    );
    const projectDir = context.target.kind === 'project' ? context.target.projectDir : undefined;
    await syncPlugins({
      manifest,
      current: await readCurrentPlugins(baseDir, projectDir),
      claude: cli(claudePath),
      prompter: context.prompter,
      reporter: context.reporter,
      cwd: projectDir ?? deps.system.homedir,
      assumeYes: context.assumeYes,
      allowCommands: context.allowCommands,
      explainFailure: (reason) => explainPluginFailure(reason, managed),
    });
  }

  async function programs(context: AfterRestoreContext): Promise<void> {
    const saved = readJson(context.files, PROGRAMS_BUNDLE_PATH, ProgramsFileSchema);
    if (saved === null) return;
    for (const program of saved.programs) {
      if ((await findExecutable(deps.system, program.command)) !== null) continue;
      if (program.npm === null) {
        context.reporter.warn(
          `Your hooks or status line run "${program.command}", which is not installed here. Install it for them to work.`,
        );
        continue;
      }
      const spec = `${program.npm.package}@${program.npm.version}`;
      const npmPath = await findExecutable(deps.system, 'npm');
      if (npmPath === null) {
        context.reporter.warn(
          `"${program.command}" is missing and npm was not found. Install it with: npm install -g ${spec}`,
        );
        continue;
      }
      const question = `"${program.command}" is not installed here. Install it with \`npm install -g ${spec}\`?`;
      if (!context.allowCommands) {
        if (context.assumeYes) {
          context.reporter.warn(
            `"${program.command}" is not installed here and was not installed: --yes never installs or runs new code; add --allow-commands, or run pull without --yes to choose. To install it yourself: npm install -g ${spec}`,
          );
          continue;
        }
        if (!(await context.prompter.confirm(question, true))) continue;
      }
      const run = await cli(npmPath).run(['install', '-g', spec], deps.system.homedir);
      if (run.exitCode === 0) context.reporter.success(`Installed ${spec}.`);
      else
        context.reporter.warn(
          `Could not install ${spec}: ${run.stderr.trim() || `exit code ${String(run.exitCode)}`}`,
        );
    }
  }

  /**
   * Saved claude.ai skills (T42): offered as local skills on a PC that does not already get
   * them from its own claude.ai sync, only after a yes. A skill with `` !`command` `` lines
   * runs those as a local skill (a synced one does not), so it is marked, and a flag alone
   * (no question asked) adds it only with --allow-commands too.
   */
  async function accountSkills(context: AfterRestoreContext): Promise<void> {
    if (context.target.kind !== 'global' || !deps.restorer) return;
    if (!context.files.some((file) => file.path.startsWith(ACCOUNT_SKILLS_PREFIX))) return;
    const baseDir = claudeConfigDir(deps.system);
    const gatherer = createFileGatherer(deps.system.platform);
    const skillsDir = gatherer.path.join(baseDir, 'skills');
    const localNames = new Set(
      (await readdir(skillsDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && entry.name !== 'synced')
        .map((entry) => entry.name.toLowerCase()),
    );
    const synced = await readSyncedSkills(gatherer, baseDir);
    const plan = planAccountSkills(context.files, { syncedNames: synced.allNames, localNames });
    if (plan.toAdd.length === 0 && plan.skipped.length === 0) return;

    context.reporter.info(
      [
        'Skills from your claude.ai account on the other PC:',
        ...plan.toAdd.map(
          (skill) =>
            `  + ${skill.name}${skill.runsCommands ? '  ⚠ runs commands as a local skill (! lines, ```! blocks or hooks)' : ''}`,
        ),
        ...plan.skipped.map((skill) => `  - ${skill.name}: skipped, ${skill.reason}`),
      ].join('\n'),
    );
    if (plan.toAdd.length === 0) return;

    const fromFlag = context.accountSkills !== undefined;
    const add =
      context.accountSkills ??
      (!context.assumeYes &&
        (await context.prompter.confirm(
          'Add them as local skills? Only needed if this PC uses another claude.ai account, or none.',
          false,
        )));
    if (!add) {
      context.reporter.info(
        'Not added. To add them later: agentnomad pull --global --account-skills',
      );
      return;
    }
    // Answered by a flag, not a person: commands only run with --allow-commands as well.
    const blocked = new Set(
      fromFlag && !context.allowCommands
        ? plan.toAdd.filter((skill) => skill.runsCommands).map((skill) => skill.name)
        : [],
    );
    for (const name of blocked) {
      context.reporter.warn(
        `Skipped ${name}: it runs commands as a local skill. Add --allow-commands to add it anyway.`,
      );
    }
    const files = plan.files.filter((file) => !blocked.has(file.path.split('/')[1] ?? ''));
    const added = plan.toAdd.filter((skill) => !blocked.has(skill.name)).map((skill) => skill.name);
    if (added.length === 0) return;
    const report = await deps.restorer.restore({ kind: 'global' }, files, () =>
      Promise.resolve('skip'),
    );
    for (const warning of report.warnings) context.reporter.warn(warning);
    context.reporter.success(
      `Added ${added.join(', ')} as local skills. If this PC later signs in to the claude.ai account they came from, they sync there too, and your local copy keeps the short name.`,
    );
  }

  return async (context: AfterRestoreContext): Promise<void> => {
    await plugins(context);
    await programs(context);
    await accountSkills(context);
  };
}
