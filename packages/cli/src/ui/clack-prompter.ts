import type { Writable } from 'node:stream';

import * as clack from '@clack/prompts';

import { printable } from './printable.ts';
import { PromptCancelledError, type Choice, type Prompter, type Reporter } from './prompter.ts';

/** A clack answer, or PromptCancelledError when the user pressed Ctrl+C or Esc. */
export function unwrapAnswer<T>(answer: T): Exclude<T, symbol> {
  if (clack.isCancel(answer)) throw new PromptCancelledError();
  return answer as Exclude<T, symbol>;
}

const toOptions = <T extends string>(choices: readonly Choice<T>[]) =>
  choices.map((choice) => ({
    value: choice.value,
    label: printable(choice.label),
    ...(choice.hint !== undefined && { hint: printable(choice.hint) }),
  }));

/** The Prompter on @clack/prompts (T04 decision). Commands only see the Prompter interface. */
export function createClackPrompter(): Prompter {
  return {
    async select(message, choices) {
      // clack types options loosely for generic values; the answer is one of `choices`.
      return unwrapAnswer(
        await clack.select({ message: printable(message), options: toOptions(choices) as never }),
      );
    },

    async multiselect(message, choices, options = {}) {
      return unwrapAnswer(
        await clack.multiselect({
          message: printable(message),
          options: toOptions(choices) as never,
          required: options.required ?? true,
          ...(options.initial && { initialValues: [...options.initial] }),
        }),
      );
    },

    async text(message, options = {}) {
      const { validate } = options;
      return unwrapAnswer(
        await clack.text({
          message: printable(message),
          ...(options.placeholder !== undefined && { placeholder: options.placeholder }),
          ...(validate && { validate: (value: string | undefined) => validate(value ?? '') }),
        }),
      );
    },

    async password(message, options = {}) {
      const { validate } = options;
      return unwrapAnswer(
        await clack.password({
          message,
          clearOnError: true,
          ...(validate && { validate: (value: string | undefined) => validate(value ?? '') }),
        }),
      );
    },

    async confirm(message, initial = false) {
      return unwrapAnswer(
        await clack.confirm({ message: printable(message), initialValue: initial }),
      );
    },
  };
}

export interface ClackReporterOptions {
  /** Where warnings and errors go; stderr, so a script can tell them from normal output. */
  readonly diagnostics?: Writable;
  /**
   * false with no terminal (T36): a spinner then prints its message once instead of
   * animating, so logs stay readable.
   */
  readonly interactive?: boolean;
}

/** Messages and spinners on @clack/prompts. */
export function createClackReporter(options: ClackReporterOptions = {}): Reporter {
  const diagnostics = options.diagnostics && { output: options.diagnostics };
  return {
    info: (message) => {
      clack.log.info(printable(message));
    },
    success: (message) => {
      clack.log.success(printable(message));
    },
    warn: (message) => {
      clack.log.warn(printable(message), diagnostics);
    },
    error: (message) => {
      clack.log.error(printable(message), diagnostics);
    },
    spinner: () => {
      if (options.interactive === false) {
        return {
          start: (message) => {
            clack.log.step(printable(message));
          },
          stop: (message) => {
            if (message) clack.log.step(printable(message));
          },
        };
      }
      const spinner = clack.spinner();
      return {
        start: (message) => {
          spinner.start(printable(message));
        },
        stop: (message) => {
          spinner.stop(message === undefined ? message : printable(message));
        },
      };
    },
  };
}
