import { createWriteStream } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerConfig {
  sessionLogPath: string;
  maxBufferedEntries: number;
}

interface LogMessage {
  type: "log";
  line: string;
}

interface FlushMessage {
  type: "flush";
  requestId: number;
}

interface ShutdownMessage {
  type: "shutdown";
  requestId: number;
}

type InboundMessage = LogMessage | FlushMessage | ShutdownMessage;

type PendingRequest = {
  kind: "flush" | "shutdown";
  requestId: number;
};

const config = workerData as WorkerConfig;
const output = createWriteStream(config.sessionLogPath, { flags: "a", encoding: "utf8" });

const queue: string[] = [];
const pending: PendingRequest[] = [];
let writing = false;
let droppedEntries = 0;
let closing = false;

function notifyDroppedIfNeeded(): void {
  if (droppedEntries > 0) {
    parentPort?.postMessage({ type: "dropped", droppedEntries });
    droppedEntries = 0;
  }
}

function drainPendingIfIdle(): void {
  if (queue.length > 0 || writing) {
    return;
  }

  while (pending.length > 0) {
    const next = pending.shift();
    if (!next) {
      return;
    }

    if (next.kind === "flush") {
      parentPort?.postMessage({ type: "flushed", requestId: next.requestId });
      continue;
    }

    output.end(() => {
      parentPort?.postMessage({ type: "closed", requestId: next.requestId });
    });
    return;
  }
}

function writeNext(): void {
  if (writing || queue.length === 0) {
    drainPendingIfIdle();
    return;
  }

  writing = true;
  const line = queue.shift();
  if (!line) {
    writing = false;
    drainPendingIfIdle();
    return;
  }

  const canContinue = output.write(line, "utf8", () => {
    writing = false;
    writeNext();
  });

  if (!canContinue) {
    output.once("drain", () => {
      if (!writing) {
        writeNext();
      }
    });
  }
}

function handleLog(line: string): void {
  if (closing) {
    return;
  }

  if (queue.length >= config.maxBufferedEntries) {
    queue.shift();
    droppedEntries += 1;
  }

  queue.push(line);
  notifyDroppedIfNeeded();
  writeNext();
}

function handleMessage(message: InboundMessage): void {
  if (message.type === "log") {
    handleLog(message.line);
    return;
  }

  if (message.type === "flush") {
    pending.push({ kind: "flush", requestId: message.requestId });
    writeNext();
    return;
  }

  if (message.type === "shutdown") {
    closing = true;
    pending.push({ kind: "shutdown", requestId: message.requestId });
    writeNext();
  }
}

parentPort?.on("message", (message: InboundMessage) => {
  handleMessage(message);
});
