import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { LogEntry, LOG_LEVELS, LoggerScope, LogLevel, SessionLoggerOptions } from "./types.js";

// Log level priority values (implementation details)
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface ScopeBinding {
  context: string;
  source: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  const millis = pad3(date.getMilliseconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

function buildSessionName(now: Date): string {
  const day = localDateKey(now);
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  const millis = pad3(now.getMilliseconds());
  return `session-${day}_${hours}-${minutes}-${seconds}-${millis}.jsonl`;
}

function parseSessionDateKey(fileName: string): string | null {
  const match = /^session-(\d{4}-\d{2}-\d{2})/.exec(fileName);
  if (!match) {
    return null;
  }

  return match[1];
}

async function pruneOldSessionFiles(logDir: string, startupDateKey: string): Promise<void> {
  const entries = await readdir(logDir, { withFileTypes: true });
  const deletions: Promise<void>[] = [];
  const observedDateKeys = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const key = parseSessionDateKey(entry.name);
    if (!key) {
      continue;
    }

    observedDateKeys.add(key);
  }

  let previousDateKey: string | null = null;
  for (const observed of observedDateKeys) {
    if (observed >= startupDateKey) {
      continue;
    }

    if (!previousDateKey || observed > previousDateKey) {
      previousDateKey = observed;
    }
  }

  const keepDateKeys = new Set<string>([startupDateKey]);
  if (previousDateKey) {
    keepDateKeys.add(previousDateKey);
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const entryDateKey = parseSessionDateKey(entry.name);
    if (!entryDateKey) {
      continue;
    }

    if (keepDateKeys.has(entryDateKey)) {
      continue;
    }

    deletions.push(rm(join(logDir, entry.name), { force: true }));
  }

  await Promise.all(deletions);
}

class BoundLoggerScope implements LoggerScope {
  private readonly logger: SessionLogger;
  private readonly binding: ScopeBinding;

  constructor(logger: SessionLogger, binding: ScopeBinding) {
    this.logger = logger;
    this.binding = binding;
  }

  debug(message: string, data?: unknown): void {
    this.logger.write("debug", this.binding, message, data);
  }

  info(message: string, data?: unknown): void {
    this.logger.write("info", this.binding, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.logger.write("warn", this.binding, message, data);
  }

  error(message: string, data?: unknown): void {
    this.logger.write("error", this.binding, message, data);
  }

  transition(fromState: string, toState: string, data?: unknown): void {
    this.logger.write("info", this.binding, "state.transition", {
      fromState,
      toState,
      ...(data !== undefined ? { data } : {}),
    });
  }
}

export class SessionLogger implements LoggerScope {
  readonly sessionLogPath: string;
  private readonly app: string;
  private readonly defaultBinding: ScopeBinding;
  private readonly worker: any;
  private readonly minLevelPriority: number;
  private readonly requests = new Map<number, () => void>();
  private nextRequestId = 1;
  private stopped = false;

  private constructor(
    worker: any,
    app: string,
    sessionLogPath: string,
    minLevel: LogLevel,
    defaultBinding: ScopeBinding,
  ) {
    this.worker = worker;
    this.app = app;
    this.sessionLogPath = sessionLogPath;
    this.minLevelPriority = LEVEL_PRIORITY[minLevel];
    this.defaultBinding = defaultBinding;

    this.worker.on("message", (message: any) => {
      if (message?.type === "dropped") {
        const dropped = Number(message.droppedEntries ?? 0);
        if (dropped > 0) {
          // Do not re-log this into the worker queue; that can amplify pressure while overloaded.
          console.warn(`[logger] dropped ${dropped} buffered log entries`);
        }
        return;
      }

      if (message?.type !== "flushed" && message?.type !== "closed") {
        return;
      }

      const requestId = Number(message.requestId);
      const resolver = this.requests.get(requestId);
      if (!resolver) {
        return;
      }

      this.requests.delete(requestId);
      resolver();
    });
  }

  static async create(options: SessionLoggerOptions): Promise<SessionLogger> {
    const nowProvider = options.now ?? (() => new Date());
    const startupDate = nowProvider();
    const startupDateKey = localDateKey(startupDate);
    const logDir = resolve(options.logDir ?? join(process.cwd(), "logs"));

    await mkdir(logDir, { recursive: true });
    await pruneOldSessionFiles(logDir, startupDateKey);

    const sessionLogPath = join(logDir, buildSessionName(startupDate));
    const worker = new Worker(new URL("./logWriterWorker.js", import.meta.url), {
      workerData: {
        sessionLogPath,
        maxBufferedEntries: options.maxBufferedEntries ?? 4096,
      },
    });

    const minLevel = options.minLevel ?? "info";
    if (!LOG_LEVELS.includes(minLevel)) {
      throw new Error(`Unsupported log level: ${String(minLevel)}`);
    }

    return new SessionLogger(worker, options.app, sessionLogPath, minLevel, {
      context: options.context ?? "main",
      source: options.source ?? "unknown",
    });
  }

  child(binding: Partial<ScopeBinding>): LoggerScope {
    return new BoundLoggerScope(this, {
      context: binding.context ?? this.defaultBinding.context,
      source: binding.source ?? this.defaultBinding.source,
    });
  }

  debug(message: string, data?: unknown): void {
    this.write("debug", this.defaultBinding, message, data);
  }

  info(message: string, data?: unknown): void {
    this.write("info", this.defaultBinding, message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write("warn", this.defaultBinding, message, data);
  }

  error(message: string, data?: unknown): void {
    this.write("error", this.defaultBinding, message, data);
  }

  transition(fromState: string, toState: string, data?: unknown): void {
    this.write("info", this.defaultBinding, "state.transition", {
      fromState,
      toState,
      ...(data !== undefined ? { data } : {}),
    });
  }

  write(level: LogLevel, binding: ScopeBinding, message: string, data?: unknown): void {
    if (this.stopped) {
      return;
    }

    if (LEVEL_PRIORITY[level] < this.minLevelPriority) {
      return;
    }

    const entry: LogEntry = {
      timestamp: formatLocalTimestamp(new Date()),
      level,
      app: this.app,
      context: binding.context,
      source: binding.source,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    this.worker.postMessage({ type: "log", line: `${JSON.stringify(entry)}\n` });
  }

  async flush(): Promise<void> {
    if (this.stopped) {
      return;
    }

    await this.awaitWorkerRequest("flush");
  }

  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    await this.awaitWorkerRequest("shutdown");
    await this.worker.terminate();
  }

  private awaitWorkerRequest(kind: "flush" | "shutdown"): Promise<void> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve) => {
      this.requests.set(requestId, resolve);
      this.worker.postMessage({ type: kind, requestId });
    });
  }
}
