import type { Prompter } from './prompter.ts';

/**
 * A question was left for the user, but there is no terminal to ask in (a script or CI).
 * The command stops before changing anything; the message says which flags answer it.
 */
export class AnswerNeededError extends Error {
  readonly question: string;

  constructor(question: string) {
    super(`"${question}" needs an answer, but there is no terminal to ask in.`);
    this.name = 'AnswerNeededError';
    this.question = question;
  }
}

/**
 * The flags-only prompter (T36): used when stdin or stdout is not a terminal. It never
 * asks; every question the flags did not answer fails with AnswerNeededError.
 */
export function createNoTerminalPrompter(): Prompter {
  const fail = (message: string) => Promise.reject(new AnswerNeededError(message));
  return {
    canAsk: false,
    select: (message) => fail(message),
    multiselect: (message) => fail(message),
    text: (message) => fail(message),
    password: (message) => fail(message),
    confirm: (message) => fail(message),
  };
}
