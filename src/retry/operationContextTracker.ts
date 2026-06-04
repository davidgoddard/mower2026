import { OperationContext } from "./retryTypes.js";

/**
 * Lightweight in-process tracker for the active operation context. Perimeter
 * follows, line drives, and turns set this so the retry manager can route an
 * incoming obstruction event to the correct recovery flow. Cleared as soon as
 * the operation finishes — `getContext()` returns null when nothing is active,
 * which the retry manager treats as "ignore the event".
 */
export class OperationContextTracker {
  private current: OperationContext | null = null;

  setContext(context: OperationContext): void {
    this.current = context;
  }

  clearContext(): void {
    this.current = null;
  }

  getContext(): OperationContext | null {
    return this.current;
  }
}
