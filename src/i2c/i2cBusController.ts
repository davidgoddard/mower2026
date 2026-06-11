import { I2cTransport, QueuedI2cReadRequest, QueuedI2cWriteRequest } from "./types.js";

interface BaseTask {
  key: string;
  priority: number;
  sequence: number;
  execute: () => Promise<void>;
  reject: (error: Error) => void;
}

/**
 * Thrown when a queued I2C task is preempted by a newer task with the same key.
 * Callers that view this as a normal "newer command supersedes older command"
 * outcome (e.g. duplicate motor commands) should swallow it via `instanceof
 * I2cTaskReplacedError`. The `key` field names the replaced task.
 */
export class I2cTaskReplacedError extends Error {
  constructor(public readonly key: string) {
    super(`i2c task replaced: ${key}`);
    this.name = "I2cTaskReplacedError";
  }
}

export class I2cBusController {
  private readonly transport: I2cTransport;
  private readonly queuedByKey = new Map<string, BaseTask>();
  private sequence = 0;
  private processing = false;
  private closed = false;

  constructor(transport: I2cTransport) {
    this.transport = transport;
  }

  async queueWrite(request: QueuedI2cWriteRequest): Promise<void> {
    if (this.closed) {
      throw new Error("i2c controller closed");
    }

    await this.enqueueTask({
      key: request.key,
      priority: request.priority,
      execute: async () => {
        await this.transport.write(request.address, request.payload);
      },
    });
  }

  async queueRead(request: QueuedI2cReadRequest): Promise<Uint8Array> {
    if (this.closed) {
      throw new Error("i2c controller closed");
    }

    let response: Uint8Array = new Uint8Array(0);
    await this.enqueueTask({
      key: request.key,
      priority: request.priority,
      execute: async () => {
        response = await this.transport.writeRead(request.address, request.requestPayload, request.responseLength);
      },
    });

    return response;
  }

  async close(): Promise<void> {
    this.closed = true;
    const rejectError = new Error("i2c controller closed");
    for (const task of this.queuedByKey.values()) {
      task.reject(rejectError);
    }
    this.queuedByKey.clear();
    await this.transport.close();
  }

  private async enqueueTask(taskLike: Pick<BaseTask, "key" | "priority" | "execute">): Promise<void> {
    const sequence = this.sequence;
    this.sequence += 1;

    return new Promise<void>((resolve, reject) => {
      const existing = this.queuedByKey.get(taskLike.key);
      if (existing) {
        existing.reject(new I2cTaskReplacedError(taskLike.key));
      }

      const task: BaseTask = {
        key: taskLike.key,
        priority: taskLike.priority,
        sequence,
        execute: async () => {
          await taskLike.execute();
          resolve();
        },
        reject,
      };

      this.queuedByKey.set(taskLike.key, task);
      if (!this.processing) {
        this.processing = true;
        void this.processLoop();
      }
    });
  }

  private async processLoop(): Promise<void> {
    try {
      while (this.queuedByKey.size > 0 && !this.closed) {
        const nextTask = this.pickNextTask();
        if (!nextTask) {
          break;
        }

        this.queuedByKey.delete(nextTask.key);

        try {
          await nextTask.execute();
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          nextTask.reject(wrapped);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private pickNextTask(): BaseTask | null {
    let best: BaseTask | null = null;

    for (const task of this.queuedByKey.values()) {
      if (!best) {
        best = task;
        continue;
      }

      if (task.priority < best.priority) {
        best = task;
        continue;
      }

      if (task.priority === best.priority && task.sequence < best.sequence) {
        best = task;
      }
    }

    return best;
  }
}
