/**
 * Run record — per-line-drive audit row.
 *
 * One JSON object per completed (or aborted) line drive, written as a JSONL
 * row under `<logDir>/run-records/<YYYY-MM-DD>.jsonl`.  The record holds every
 * piece of evidence the offline learner needs to (a) decide whether the run
 * was a valid learning sample, (b) reproduce the learning step deterministically,
 * and (c) drive the run-history view in the drive tuning UI.
 *
 * Phase 1 (instrumentation only) emits these alongside the existing
 * `drive.line.completed` events; later phases route the learner through the
 * same record so a stored RunRecord can be replayed offline.
 *
 * Units convention (per project rule [[feedback-no-speed-concept]]):
 *   - distances and positions are in metres (because they are positions on
 *     the ground, not speeds)
 *   - "vigour" / cruise-reached evidence is in encoder ticks per motor
 *     feedback sample, NOT in m/s
 *   - elapsed times are in milliseconds
 *   - normalized motor commands are in [-1, +1]
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";

export type RunRecordDirection = "forward" | "reverse";
export type RunRecordPoseQuality = "gnss" | "dead-reckoning" | "unknown";

export interface RunRecordPose {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDeg: number;
  readonly quality: RunRecordPoseQuality;
  readonly usingGnssHeading: boolean;
  /** Milliseconds since the last accepted GNSS sample, or null if never. */
  readonly gnssAgeMs: number | null;
  /** Pi clock at capture. */
  readonly tMs: number;
}

export interface RunRecordHeartbeatSample {
  readonly tMs: number;
  readonly xMeters: number;
  readonly yMeters: number;
  readonly headingDeg: number;
  readonly quality: RunRecordPoseQuality;
  readonly leftEncoderDelta: number | null;
  readonly rightEncoderDelta: number | null;
  readonly remainingAlongTrackMeters: number;
  readonly cteMeters: number;
}

export interface RunRecordEvents {
  /** Any obstruction event seen between anchor and settled. */
  readonly obstruction: boolean;
  /** Any wheel-slip event seen between anchor and settled. */
  readonly wheelSlip: boolean;
  /** GNSS dropped below trusted between anchor and settled. */
  readonly gnssDemoted: boolean;
}

export interface RunRecordParams {
  readonly coastDistanceUsedMeters: number;
  readonly cteGainUsed: number;
  readonly shortBucketUsed: boolean;
}

export interface RunRecord {
  readonly runId: string;
  readonly startedAt: string;
  /** +1 forward, -1 reverse. */
  readonly directionSign: 1 | -1;
  readonly direction: RunRecordDirection;
  readonly plannedDistanceMeters: number;
  readonly fullPowerCommand: number;
  /** Hash that identifies the pose-calibration in force at run time. */
  readonly calibrationFingerprintAtRun: string | null;

  readonly params: RunRecordParams;

  readonly anchor: RunRecordPose;
  readonly lineEnd: { readonly xMeters: number; readonly yMeters: number };
  readonly brakeTrigger: RunRecordPose & {
    readonly remainingAlongTrackMeters: number;
    readonly reason: "arrival_tolerance" | "brake_distance" | "none";
  };
  readonly settled: RunRecordPose;

  readonly errorXMeters: number;
  readonly errorYMeters: number;
  readonly avgCteMeters: number;
  readonly maxCteMeters: number;
  readonly coastDistanceMeasuredMeters: number;
  /**
   * Peak left+right encoder ticks per motor-feedback sample observed during
   * the run.  Used as the cruise-reached signal.  Tick-rate, NOT m/s.
   */
  readonly peakTickRate: number;
  /** Pitch at anchor in degrees, surfaces sloped runs for downstream gating. */
  readonly pitchAtAnchorDeg: number | null;
  /** Pi-clock duration from anchor to settled. */
  readonly durationMs: number;
  /** Status reported by the line controller. */
  readonly status: "success" | "error" | "stopped";
  readonly statusMessage?: string | null;

  readonly events: RunRecordEvents;

  /** Bounded sample of pose-vs-encoder evidence during the run. */
  readonly heartbeat: readonly RunRecordHeartbeatSample[];

  readonly learning: {
    readonly applied: boolean;
    readonly skipReason: string | null;
    readonly outlier: boolean;
  };
}

/**
 * Writer that appends RunRecord rows as JSONL under the configured log
 * directory.  Best-effort: a write failure logs a warning but never throws
 * out to the drive controller — instrumentation must not break a drive.
 */
export class RunRecordWriter {
  private readonly logger: LoggerScope;
  private readonly logDir: string;
  private ensuredDir = false;

  constructor(options: { logger: SessionLogger; logDir?: string }) {
    this.logger = options.logger.child({
      context: "control",
      source: "RunRecordWriter",
    });
    this.logDir = options.logDir ?? process.env.MOWER_LOG_DIR ?? "logs";
  }

  async append(record: RunRecord): Promise<void> {
    const path = this.pathForDate(record.startedAt);
    try {
      if (!this.ensuredDir) {
        await mkdir(dirname(path), { recursive: true });
        this.ensuredDir = true;
      }
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("run_record.append_failed", { path, error: message });
    }
  }

  private pathForDate(isoTimestamp: string): string {
    const day = isoTimestamp.slice(0, 10); // YYYY-MM-DD
    return join(this.logDir, "run-records", `${day}.jsonl`);
  }
}
