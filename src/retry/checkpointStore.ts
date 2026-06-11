/**
 * Checkpoint Store - maintains recovery points for the path-context retry flow.
 */

import { Checkpoint } from "./retryTypes.js";
import { LoggerScope } from "../logging/types.js";

export interface CheckpointStoreOptions {
  maxCheckpoints?: number;
  logger: LoggerScope;
}

export class CheckpointStore {
  private readonly checkpoints: Checkpoint[] = [];
  private readonly maxCheckpoints: number;
  private readonly logger: LoggerScope;

  constructor(options: CheckpointStoreOptions) {
    this.maxCheckpoints = options.maxCheckpoints ?? 10;
    this.logger = options.logger;
  }

  /**
   * Add a checkpoint to the store, dropping the oldest when the buffer is full.
   */
  addCheckpoint(checkpoint: Checkpoint): void {
    this.checkpoints.push(checkpoint);

    if (this.checkpoints.length > this.maxCheckpoints) {
      const removed = this.checkpoints.shift();
      this.logger.debug("checkpoint.removed_oldest", { removedId: removed?.id });
    }

    this.logger.debug("checkpoint.added", {
      id: checkpoint.id,
      context: checkpoint.context,
      timestamp: checkpoint.timestamp,
    });
  }

  /**
   * Return the most recent path checkpoint, or null if none have been recorded
   * for the current session.
   */
  getRecoveryCheckpoint(): Checkpoint | null {
    if (this.checkpoints.length === 0) {
      this.logger.warn("checkpoint.none_found");
      return null;
    }

    const checkpoint = this.checkpoints[this.checkpoints.length - 1];
    this.logger.info("checkpoint.retrieved_for_recovery", {
      checkpointId: checkpoint.id,
    });
    return checkpoint;
  }
}
