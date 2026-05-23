/**
 * Checkpoint Store - maintains recovery points for retry system
 */

import { Checkpoint, OperationContext } from "./retryTypes.js";
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
   * Add a checkpoint to the store
   */
  addCheckpoint(checkpoint: Checkpoint): void {
    this.checkpoints.push(checkpoint);

    // Maintain circular buffer - remove oldest if over limit
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
   * Get the most recent checkpoint
   */
  getLatest(): Checkpoint | null {
    if (this.checkpoints.length === 0) {
      return null;
    }
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /**
   * Get recovery checkpoint for a specific context
   * For path: go back specified number of waypoints
   * For line: return last good point
   * For turn: return pre-turn state
   */
  getRecoveryCheckpoint(context: OperationContext, stepsBack: number = 1): Checkpoint | null {
    // Filter checkpoints by context
    const contextCheckpoints = this.checkpoints.filter((cp) => cp.context === context);

    if (contextCheckpoints.length === 0) {
      this.logger.warn("checkpoint.none_found_for_context", { context });
      return null;
    }

    // For path context, go back N waypoints
    if (context === "path") {
      const targetIndex = Math.max(0, contextCheckpoints.length - stepsBack - 1);
      const checkpoint = contextCheckpoints[targetIndex];
      this.logger.info("checkpoint.retrieved_for_recovery", {
        context,
        stepsBack,
        checkpointId: checkpoint.id,
      });
      return checkpoint;
    }

    // For line and turn, return most recent
    const checkpoint = contextCheckpoints[contextCheckpoints.length - 1];
    this.logger.info("checkpoint.retrieved_for_recovery", {
      context,
      checkpointId: checkpoint.id,
    });
    return checkpoint;
  }

  /**
   * Clear all checkpoints
   */
  clear(): void {
    const count = this.checkpoints.length;
    this.checkpoints.length = 0;
    this.logger.info("checkpoint.cleared_all", { count });
  }

  /**
   * Clear checkpoints for a specific context
   */
  clearContext(context: OperationContext): void {
    const initialCount = this.checkpoints.length;
    const filtered = this.checkpoints.filter((cp) => cp.context !== context);
    this.checkpoints.length = 0;
    this.checkpoints.push(...filtered);

    const removedCount = initialCount - this.checkpoints.length;
    this.logger.info("checkpoint.cleared_context", { context, removedCount });
  }

  /**
   * Get checkpoint count
   */
  getCount(): number {
    return this.checkpoints.length;
  }

  /**
   * Get all checkpoints (for debugging/logging)
   */
  getAllCheckpoints(): ReadonlyArray<Checkpoint> {
    return this.checkpoints;
  }
}
