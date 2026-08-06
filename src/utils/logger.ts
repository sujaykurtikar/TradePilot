/**
 * `[TradePilot]` namespaced logger (§7.8 Observability).
 *
 * "When something goes wrong at 9:20am you need the log, not a repro" —
 * every state transition, degradation trip, probe result, and order
 * submit/response must go through this, not a bare console.log, so it's
 * filterable and consistently shaped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

const PREFIX = '[TradePilot]';

function format(scope: string, message: string): string {
  return `${PREFIX}[${scope}] ${message}`;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** create a child logger that prefixes its own scope under this one */
  child(scope: string): Logger;
}

function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const line = format(scope, message);
    const consoleFn =
      level === 'debug'
        ? console.debug
        : level === 'info'
          ? console.info
          : level === 'warn'
            ? console.warn
            : console.error;
    if (fields && Object.keys(fields).length > 0) {
      consoleFn(line, fields);
    } else {
      consoleFn(line);
    }
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export function getLogger(scope: string): Logger {
  return createLogger(scope);
}
