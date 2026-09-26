/** One option in a select or checklist. */
export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Extra detail shown next to the label, e.g. `not installed`. */
  readonly hint?: string;
}

export interface MultiselectOptions<T extends string> {
  /** Must at least one option be picked? */
  readonly required?: boolean;
  /** Options ticked at the start. */
  readonly initial?: readonly T[];
}

export interface TextOptions {
  readonly placeholder?: string;
  /** Returns an error message, or `undefined` when the value is fine. */
  readonly validate?: (value: string) => string | undefined;
}

export interface PasswordOptions {
  /** Returns an error message, or `undefined` when the value is fine. */
  readonly validate?: (value: string) => string | undefined;
}

/**
 * Every question the CLI asks (T20). Commands depend on this, never on the prompt library,
 * so a flags-only version can answer without a terminal (`--yes`, T36). When the user
 * cancels (Ctrl+C), each method rejects instead of returning a value.
 */
export interface Prompter {
  select<T extends string>(message: string, choices: readonly Choice<T>[]): Promise<T>;
  multiselect<T extends string>(
    message: string,
    choices: readonly Choice<T>[],
    options?: MultiselectOptions<T>,
  ): Promise<T[]>;
  text(message: string, options?: TextOptions): Promise<string>;
  /** Input is hidden while typing; a rejected answer is cleared and asked again. */
  password(message: string, options?: PasswordOptions): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /**
   * `false` when nothing can be asked (no terminal, T36): commands then check for every
   * question the flags leave open before they change anything (T46).
   */
  readonly canAsk?: boolean;
}

/** The user cancelled a question (Ctrl+C or Esc); the command stops without changing anything. */
export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

/** A progress indicator for slow steps, e.g. key derivation or uploading. */
export interface Spinner {
  start(message: string): void;
  stop(message?: string): void;
}

/** Everything the CLI tells the user without asking a question. */
export interface Reporter {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  spinner(): Spinner;
}
