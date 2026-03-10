export interface NodeHealth {
  readonly online: boolean;
  readonly stale: boolean;
  readonly lastSeenMillis: number;
  readonly faultFlags: number;
}
