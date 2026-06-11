import { systemStop } from "./systemStop.js";

export function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export const STOP_CHECK_CHUNK_MS = 50;

/**
 * Sleep in short chunks so a stop predicate (e.g. operator stop, owner stop
 * flag) can interrupt long waits. Returns `false` if interrupted, `true`
 * otherwise.
 *
 * @param delayMs       Total delay requested.
 * @param shouldStop    Optional caller-side stop predicate; called between
 *                      chunks. The global `systemStop` latch is always
 *                      consulted in addition to this.
 * @param sleep         Optional sleep impl, defaults to `defaultSleep`. Tests
 *                      can substitute a synchronous resolver.
 */
export async function sleepWithStopChecks(
  delayMs: number,
  shouldStop?: () => boolean,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<boolean> {
  let remainingMs = delayMs;
  while (remainingMs > 0) {
    if (systemStop.isStopped() || (shouldStop?.() ?? false)) {
      return false;
    }
    const chunkMs = Math.min(STOP_CHECK_CHUNK_MS, remainingMs);
    await sleep(chunkMs);
    remainingMs -= chunkMs;
  }
  return true;
}
