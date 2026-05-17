export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  app: string;
  context: string;
  source: string;
  message: string;
  data?: unknown;
}

export interface LoggerScope {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  transition(fromState: string, toState: string, data?: unknown): void;
}

export interface SessionLoggerOptions {
  app: string;
  context?: string;
  source?: string;
  logDir?: string;
  minLevel?: LogLevel;
  maxBufferedEntries?: number;
  now?: () => Date;
}
