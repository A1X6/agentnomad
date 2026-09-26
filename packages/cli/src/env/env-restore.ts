import type { Prompter, Reporter } from '../ui/prompter.ts';
import type { EnvSection } from './env-section.ts';
import { LOADER_VARIABLE } from './loader-variables.ts';
import type { EnvWriter } from './shell-profile.ts';

export interface RestoreEnvDeps {
  readonly section: EnvSection;
  /** This PC's environment: variables already set here are never overwritten. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writer: EnvWriter;
  readonly prompter: Pick<Prompter, 'confirm'>;
  readonly reporter: Pick<Reporter, 'info' | 'success' | 'warn'>;
  /** `--yes`: add them without asking, except ones that make programs load code. */
  readonly assumeYes?: boolean;
  /** `--allow-commands`: add those too without asking (T44). */
  readonly allowCommands?: boolean;
}

export interface RestoreEnvResult {
  readonly added: readonly string[];
  readonly alreadySet: readonly string[];
  readonly declined: boolean;
}

/**
 * On pull (T30): adds the saved variables that are missing on this PC to the shell profile
 * (or Windows user variables), after asking. Values are never shown. Variables that make a
 * shell or runtime load code (`NODE_OPTIONS`, `PROMPT_COMMAND`, …) get their own question
 * with "no" as the default, and `--yes` alone never adds them (T44).
 */
export async function restoreEnvValues(deps: RestoreEnvDeps): Promise<RestoreEnvResult> {
  const names = Object.keys(deps.section.variables).sort();
  const alreadySet = names.filter((name) => (deps.env[name] ?? '') !== '');
  const missing = names.filter((name) => !alreadySet.includes(name));
  if (missing.length === 0) {
    if (names.length > 0)
      deps.reporter.info('The saved environment variables are already set here.');
    return { added: [], alreadySet, declined: false };
  }
  const loaders = missing.filter((name) => LOADER_VARIABLE.test(name));
  const plain = missing.filter((name) => !LOADER_VARIABLE.test(name));

  deps.reporter.info(
    [
      `Saved environment variables missing on this PC (values hidden):`,
      ...plain.map((name) => `  + ${name}`),
      ...loaders.map((name) => `  + ${name}  (makes programs load or run code)`),
      `They would be added to ${deps.writer.where}, as plain text on this PC.`,
    ].join('\n'),
  );
  const count = (list: readonly string[]) =>
    `${String(list.length)} variable${list.length === 1 ? '' : 's'}`;
  const toAdd: string[] = [];
  let declined = false;
  if (plain.length > 0) {
    if (deps.assumeYes || (await deps.prompter.confirm(`Add ${count(plain)}?`, true))) {
      toAdd.push(...plain);
    } else declined = true;
  }
  if (loaders.length > 0) {
    const allow =
      deps.allowCommands === true ||
      (!deps.assumeYes &&
        (await deps.prompter.confirm(
          `${loaders.join(', ')} make${loaders.length === 1 ? 's' : ''} programs load or run code. Add ${loaders.length === 1 ? 'it' : 'them'} too?`,
          false,
        )));
    if (allow) toAdd.push(...loaders);
    else {
      declined = true;
      if (deps.assumeYes) {
        deps.reporter.warn(
          `Not added: ${loaders.join(', ')}. --yes never adds variables that make programs run code; add --allow-commands to accept them.`,
        );
      }
    }
  }
  if (toAdd.length === 0) return { added: [], alreadySet, declined };

  const values = Object.fromEntries(
    toAdd.map((name) => [name, deps.section.variables[name] ?? '']),
  );
  const { backup } = await deps.writer.write(values);
  deps.reporter.success(
    [
      `Added ${toAdd.join(', ')} to ${deps.writer.where}.`,
      ...(backup ? [`Backup of the old file: ${backup}`] : []),
      'Open a new terminal (and restart Claude Code) so they take effect.',
    ].join('\n'),
  );
  return { added: toAdd, alreadySet, declined };
}
