/** Values safe to log. Never pass headers, bodies, tokens, keys or query strings. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Structured logs (T18): one JSON object per line, easy to search on any host. */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Writes one JSON line per event to the given sink (console by default). */
export function createJsonLogger(
  write: (line: string) => void = (line) => {
    console.log(line);
  },
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: 'info' | 'error', event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ time: now().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields) => {
      emit('info', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
  };
}

/**
 * What an unexpected error may put in the logs: its type and message, never extra data. A
 * failed database query (Drizzle's DrizzleQueryError) carries every query parameter in its
 * message and stack, which can be a user's auth hash or a whole encrypted bundle (T47): only
 * its SQL text is logged, which holds placeholders, and the database's own error below it.
 */
export function describeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorName: typeof error };
  if ('query' in error && typeof error.query === 'string' && 'params' in error) {
    const cause = error.cause instanceof Error ? error.cause : undefined;
    return {
      errorName: error.name,
      query: error.query,
      ...(cause && {
        causeName: cause.name,
        causeMessage: cause.message,
        ...('code' in cause && typeof cause.code === 'string' && { causeCode: cause.code }),
      }),
    };
  }
  return { errorName: error.name, errorMessage: error.message, stack: error.stack };
}
