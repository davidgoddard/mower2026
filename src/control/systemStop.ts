import type { LoggerScope } from "../logging/types.js";

export interface SystemStopState {
  readonly stopped: boolean;
  readonly source: string | null;
  readonly reason: string | null;
  readonly changedAtMillis: number | null;
}

class SystemStopController {
  private stopped = false;
  private source: string | null = null;
  private reason: string | null = null;
  private changedAtMillis: number | null = null;
  private logger: LoggerScope | null = null;

  configureLogger(logger: LoggerScope): void {
    this.logger = logger;
  }

  requestStop(source: string, reason: string = "stop_requested"): void {
    const previousState = this.snapshot();
    this.stopped = true;
    this.source = source;
    this.reason = reason;
    this.changedAtMillis = Date.now();
    this.logger?.warn("system_stop.requested", {
      source,
      reason,
      previousState,
    });
  }

  clearStop(clearedBy: string = "unspecified"): void {
    const previousState = this.snapshot();
    this.stopped = false;
    this.source = null;
    this.reason = null;
    this.changedAtMillis = Date.now();
    this.logger?.info("system_stop.cleared", {
      clearedBy,
      previousState,
    });
  }

  isStopped(): boolean {
    return this.stopped;
  }

  snapshot(): SystemStopState {
    return {
      stopped: this.stopped,
      source: this.source,
      reason: this.reason,
      changedAtMillis: this.changedAtMillis,
    };
  }
}

export const systemStop = new SystemStopController();
