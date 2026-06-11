/**
 * Drive learning model - adaptive parameter tuning for drive controller
 */

import * as path from "node:path";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { Position, Meters, createMeters, unwrapMeters, distanceBetween } from "../geometry/positionTypes.js";
import {
  DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
  DRIVE_CTE_GAIN_DEFAULT,
  DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  DRIVE_SHORT_MIN_LEARNING_RATE,
  DRIVE_SHORT_MAX_LEARNING_RATE,
  DRIVE_SHORT_MAX_FRACTION_STEP,
  DRIVE_TARGET_CTE_METERS,
  DRIVE_LEARNING_PARAMETERS_PATH,
} from "../constants.js";
import { readJsonFile, writeJsonFile } from "../config/jsonFileStore.js";

export interface DriveShortDriveBucket {
  bucketDistanceMeters: number;
  brakeFractionPositive: number;
  brakeFractionNegative: number;
  sampleCountPositive: number;
  sampleCountNegative: number;
  lastErrorPositiveMeters: number;
  lastErrorNegativeMeters: number;
}

export interface DriveParameters {
  version: number;
  longDriveBrakeDistanceMeters: number;
  forwardCteGain: number; // Proportional gain for CTE correction while driving forward
  reverseCteGain: number; // Proportional gain for CTE correction while driving reverse
  longDriveMinDistanceMeters: number;
  shortDriveBucketStepMeters: number;
  shortDriveMaxDistanceMeters: number;
  shortDriveBrakeFractionsPositive: number[];
  shortDriveBrakeFractionsNegative: number[];
  shortDriveSampleCountsPositive: number[];
  shortDriveSampleCountsNegative: number[];
  shortDriveLastErrorPositiveMeters: number[];
  shortDriveLastErrorNegativeMeters: number[];
  updatedAt: string;
  shortDriveBuckets?: DriveShortDriveBucket[];
}

export interface DriveUpdateData {
  startPosition: Position;
  targetPosition: Position;
  finalPosition: Position;
  driveDirectionSign?: 1 | -1;
  errorX: Meters;
  errorY: Meters;
  maxCte: Meters;
  avgCte: Meters;
  brakeDistanceUsed: Meters;
  /**
   * Phase-3 instrumentation: the actual along-track distance the mower
   * coasted from the moment the controller fired `requestNeutralMotorOutputs()`
   * to the settled pose.  When supplied the learner uses this directly as
   * the new physical coast-distance target (replacing the old
   * "fraction × bucketDistance" interpretation).  Optional for back-compat
   * with callers that only know the legacy errorX-based shape.
   */
  coastDistanceMeasuredMeters?: number;
  /** Peak left+right encoder ticks per feedback sample during the run. */
  peakTickRate?: number;
  /** Per-run events that disqualify a run from coast-distance learning. */
  events?: {
    readonly obstruction: boolean;
    readonly wheelSlip: boolean;
    readonly gnssDemoted: boolean;
  };
  /** Milliseconds since the last accepted GNSS sample at brake-trigger. */
  brakeTriggerPoseAgeMs?: number | null;
}

/** Brake-trigger pose-freshness limit for a run to be considered valid. */
export const COAST_LEARNING_MAX_BRAKE_TRIGGER_POSE_AGE_MS = 100;
/** Outlier rejection: a coast measurement more than this far from the recent median is dropped. */
export const COAST_LEARNING_OUTLIER_FRACTION = 0.6;
/** Plausible per-direction coast-distance band (metres). */
export const COAST_LEARNING_MIN_METERS = 0.0;
export const COAST_LEARNING_MAX_METERS = 5.0;

export interface DriveLearningModelOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

export class DriveLearningModel {
  private static readonly MAX_CTE_GAIN = 1.5;

  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private readonly legacyParametersPath: string;
  private parameters: DriveParameters;

  /**
   * Phase-5 in-memory ring buffer of recent coast-distance measurements,
   * keyed by direction.  Used for outlier rejection only — not persisted
   * across runs.  20 samples per direction is enough to compute a stable
   * median while reacting within a single training pair sweep.
   */
  private readonly recentCoastDistancesForward: number[] = [];
  private readonly recentCoastDistancesReverse: number[] = [];
  private static readonly RECENT_COAST_BUFFER_SIZE = 20;

  constructor(options: DriveLearningModelOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveLearningModel" });
    this.parametersPath = options.parametersPath ?? DRIVE_LEARNING_PARAMETERS_PATH;
    this.legacyParametersPath = path.join("data", "drive-learning-params.json");

    // Initialize with defaults
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("drive.learning.parameters_loaded", { path: this.parametersPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const legacyRaw = await readJsonFile(this.legacyParametersPath);
          this.parameters = this.normalizeParameters(legacyRaw);
          this.logger.info("drive.learning.parameters_migrated", {
            from: this.legacyParametersPath,
            to: this.parametersPath,
          });
          await this.saveParameters();
          return;
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.warn("drive.learning.legacy_load_failed", {
              path: this.legacyParametersPath,
              error: legacyError instanceof Error ? legacyError.message : String(legacyError),
            });
          }
        }

        this.logger.info("drive.learning.parameters_not_found", {
          path: this.parametersPath,
          usingDefaults: true,
        });
        this.parameters = this.createDefaultParameters();
        await this.saveParameters();
      } else {
        this.logger.error("drive.learning.load_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.parameters = this.createDefaultParameters();
        await this.saveParameters();
      }
    }
  }

  async saveParameters(): Promise<void> {
    try {
      this.parameters.updatedAt = new Date().toISOString();
      await writeJsonFile(this.parametersPath, this.parameters);
      this.logger.info("drive.learning.parameters_saved", { path: this.parametersPath });
    } catch (error) {
      this.logger.error("drive.learning.save_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getBrakeDistanceForDrive(startPosition: Position, targetPosition: Position, directionSign?: 1 | -1): Meters {
    const driveDistance = unwrapMeters(distanceBetween(startPosition, targetPosition));
    if (driveDistance > this.parameters.longDriveMinDistanceMeters) {
      return createMeters(this.parameters.longDriveBrakeDistanceMeters);
    }

    return createMeters(this.getShortDriveBrakeDistance(startPosition, targetPosition, directionSign));
  }

  getCteGainForDirection(directionSign: 1 | -1): number {
    return directionSign > 0 ? this.parameters.forwardCteGain : this.parameters.reverseCteGain;
  }

  getParameters(): DriveParameters {
    return {
      ...this.parameters,
      shortDriveBuckets: this.getShortDriveBuckets(),
    };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("drive.learning.reset_to_defaults", {});
  }

  /**
   * Validity gate for coast-distance learning (Phase-3).  Returns the
   * disqualification reason as a string, or `null` if the run is good.
   * The legacy errorX-driven path is still applied even when this gate
   * fails — the gate only affects the new coast-distance update.
   */
  private coastLearningValidityReason(data: DriveUpdateData): string | null {
    if (data.events?.obstruction) return "obstruction";
    if (data.events?.wheelSlip) return "wheel_slip";
    if (data.events?.gnssDemoted) return "gnss_demoted";
    if (
      data.brakeTriggerPoseAgeMs !== null &&
      data.brakeTriggerPoseAgeMs !== undefined &&
      data.brakeTriggerPoseAgeMs > COAST_LEARNING_MAX_BRAKE_TRIGGER_POSE_AGE_MS
    ) {
      return "brake_trigger_pose_stale";
    }
    if (
      data.coastDistanceMeasuredMeters !== undefined &&
      (
        data.coastDistanceMeasuredMeters < COAST_LEARNING_MIN_METERS ||
        data.coastDistanceMeasuredMeters > COAST_LEARNING_MAX_METERS
      )
    ) {
      return "coast_distance_implausible";
    }
    return null;
  }

  async updateFromDrive(data: DriveUpdateData): Promise<void> {
    const errorXValue = unwrapMeters(data.errorX);
    const maxCteValue = Math.abs(unwrapMeters(data.maxCte));
    const avgCteValue = Math.abs(unwrapMeters(data.avgCte));
    const direction: 1 | -1 = data.driveDirectionSign ?? this.getShortDriveDirectionSign(data.startPosition, data.targetPosition);

    const driveDistance = unwrapMeters(distanceBetween(data.startPosition, data.targetPosition));

    // New coast-distance route — only used when the line controller
    // supplied an actual coastDistanceMeasured AND the per-run validity
    // gates pass.  When the route fires it OWNS the brake update; we still
    // run the CTE-gain update afterwards.  When the route does not fire
    // we fall through to the legacy errorX-driven update so existing
    // behaviour and tests are preserved.
    if (data.coastDistanceMeasuredMeters !== undefined) {
      const reason = this.coastLearningValidityReason(data);
      if (reason !== null) {
        this.logger.warn("drive.learning.coast_rejected", {
          reason,
          direction,
          driveDistance,
          coastDistanceMeasuredMeters: data.coastDistanceMeasuredMeters,
          brakeTriggerPoseAgeMs: data.brakeTriggerPoseAgeMs ?? null,
        });
      } else {
        const coastValue = data.coastDistanceMeasuredMeters;
        if (this.isCoastDistanceOutlier(direction, coastValue)) {
          this.logger.warn("drive.learning.coast_rejected", {
            reason: "outlier",
            direction,
            driveDistance,
            coastDistanceMeasuredMeters: coastValue,
            recentMedian: this.coastMedian(direction),
            sampleCount: this.recentCoastBuffer(direction).length,
          });
        } else {
          this.recordCoastSample(direction, coastValue);
          this.applyCoastDistanceUpdate(direction, driveDistance, coastValue);
          // CTE-gain update still runs from peak/avg CTE — those metrics
          // are independent of brake timing.
          this.updateCteGain(direction, maxCteValue, avgCteValue);
          this.parameters.updatedAt = new Date().toISOString();
          await this.saveParameters();
          return;
        }
      }
    }

    if (driveDistance <= this.parameters.longDriveMinDistanceMeters) {
      const bucketDistanceMeters = this.getShortDriveBucketDistance(driveDistance);
      const bucketIndex = this.getShortDriveBucketIndex(driveDistance);
      const currentFraction = this.getShortDriveBrakeFraction(data.startPosition, data.targetPosition, direction);
      const normalizedError = errorXValue / Math.max(bucketDistanceMeters, 0.05);
      const learningRate = this.getAdaptiveLearningRate(
        Math.abs(errorXValue),
        Math.max(bucketDistanceMeters * 0.25, 0.04),
        DRIVE_SHORT_MIN_LEARNING_RATE,
        DRIVE_SHORT_MAX_LEARNING_RATE,
      );
      const adjustment = this.clamp(
        normalizedError * learningRate,
        -DRIVE_SHORT_MAX_FRACTION_STEP,
        DRIVE_SHORT_MAX_FRACTION_STEP,
      );
      // Allow the full [0, 1] range. The previous floor of 0.05 prevented
      // the learner from settling at "no brake distance — brake at the
      // target" which is the natural answer for short drives where the
      // mower has never reached cruise speed and so has very little to
      // ramp down through. The arrival-tolerance check inside the line
      // controller picks up at fraction = 0 anyway.
      const clampedFraction = Math.max(0, Math.min(1, currentFraction + adjustment));
      const cteGainBefore = this.getCteGainForDirection(direction);
      this.updateCteGain(direction, maxCteValue, avgCteValue);
      const cteGainAfter = this.getCteGainForDirection(direction);

      if (direction > 0) {
        this.parameters.shortDriveBrakeFractionsPositive[bucketIndex] = clampedFraction;
        this.parameters.shortDriveSampleCountsPositive[bucketIndex] += 1;
        this.parameters.shortDriveLastErrorPositiveMeters[bucketIndex] = errorXValue;
      } else {
        this.parameters.shortDriveBrakeFractionsNegative[bucketIndex] = clampedFraction;
        this.parameters.shortDriveSampleCountsNegative[bucketIndex] += 1;
        this.parameters.shortDriveLastErrorNegativeMeters[bucketIndex] = errorXValue;
      }

      this.parameters.updatedAt = new Date().toISOString();
      this.logger.info("drive.learning.updated_short", {
        driveDistance,
        bucketDistanceMeters,
        direction,
        currentFraction,
        normalizedError,
        learningRate,
        adjustment,
        newFraction: clampedFraction,
        cteGain: { before: cteGainBefore, after: cteGainAfter },
      });
      await this.saveParameters();
      return;
    }

    // Update long-drive brake distance
    const brakeDistanceBefore = this.parameters.longDriveBrakeDistanceMeters;
    this.updateBrakeDistance(errorXValue);

    // Update CTE gain
    const cteGainBefore = this.getCteGainForDirection(direction);
    this.updateCteGain(direction, maxCteValue, avgCteValue);
    const cteGainAfter = this.getCteGainForDirection(direction);

    this.logger.info("drive.learning.updated", {
      errorX: errorXValue,
      maxCte: maxCteValue,
      brakeDistance: { before: brakeDistanceBefore, after: this.parameters.longDriveBrakeDistanceMeters },
      cteGain: { before: cteGainBefore, after: cteGainAfter },
      direction,
    });

    await this.saveParameters();
  }

  /** Phase-5 ring buffer accessors. */
  private recentCoastBuffer(direction: 1 | -1): number[] {
    return direction > 0 ? this.recentCoastDistancesForward : this.recentCoastDistancesReverse;
  }

  private recordCoastSample(direction: 1 | -1, coastDistance: number): void {
    const buffer = this.recentCoastBuffer(direction);
    buffer.push(coastDistance);
    if (buffer.length > DriveLearningModel.RECENT_COAST_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  private coastMedian(direction: 1 | -1): number | null {
    const buffer = this.recentCoastBuffer(direction);
    if (buffer.length === 0) return null;
    const sorted = [...buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /**
   * Phase-5 outlier check: a candidate coast distance is rejected when we
   * already have at least 4 prior samples in this direction AND the
   * candidate differs from the median by more than the configured
   * fraction of the median (or 5 cm absolute, whichever is larger — small
   * medians otherwise reject every sample).  Below 4 samples we accept
   * everything so the buffer can warm up.
   */
  private isCoastDistanceOutlier(direction: 1 | -1, coastValue: number): boolean {
    const buffer = this.recentCoastBuffer(direction);
    if (buffer.length < 4) return false;
    const median = this.coastMedian(direction);
    if (median === null) return false;
    const tolerance = Math.max(median * COAST_LEARNING_OUTLIER_FRACTION, 0.05);
    return Math.abs(coastValue - median) > tolerance;
  }

  /**
   * Phase-3 coast-distance update.  `coastDistanceMeasured` is the
   * physical distance the mower coasted from "zero-power requested" to
   * "settled".  We move the persisted target toward this measurement
   * with an EMA proportional to the gap.  Long regime updates the
   * single per-direction-pair scalar (the legacy
   * `longDriveBrakeDistanceMeters` field continues to hold the long
   * coast distance — keying it per direction is Phase 5 territory).
   * Short regime writes the bucket fraction so that
   * `bucketDistance * fraction == coastDistanceMeasured`.
   */
  private applyCoastDistanceUpdate(
    direction: 1 | -1,
    driveDistance: number,
    coastDistanceMeasured: number,
  ): void {
    const isShort = driveDistance <= this.parameters.longDriveMinDistanceMeters;
    if (isShort) {
      const bucketDistance = this.getShortDriveBucketDistance(driveDistance);
      const bucketIndex = this.getShortDriveBucketIndex(driveDistance);
      const targetFraction = this.clamp(coastDistanceMeasured / Math.max(bucketDistance, 1e-3), 0, 1);
      const currentFraction = direction > 0
        ? this.parameters.shortDriveBrakeFractionsPositive[bucketIndex]
        : this.parameters.shortDriveBrakeFractionsNegative[bucketIndex];
      const alpha = 0.3;
      const newFraction = this.clamp(currentFraction + alpha * (targetFraction - currentFraction), 0, 1);

      if (direction > 0) {
        this.parameters.shortDriveBrakeFractionsPositive[bucketIndex] = newFraction;
        this.parameters.shortDriveSampleCountsPositive[bucketIndex] += 1;
      } else {
        this.parameters.shortDriveBrakeFractionsNegative[bucketIndex] = newFraction;
        this.parameters.shortDriveSampleCountsNegative[bucketIndex] += 1;
      }

      this.logger.info("drive.learning.coast_updated_short", {
        direction,
        bucketDistanceMeters: bucketDistance,
        coastDistanceMeasuredMeters: coastDistanceMeasured,
        currentFraction,
        targetFraction,
        newFraction,
      });
      return;
    }

    const before = this.parameters.longDriveBrakeDistanceMeters;
    const alpha = 0.3;
    const next = this.clamp(
      before + alpha * (coastDistanceMeasured - before),
      0.1,
      5.0,
    );
    this.parameters.longDriveBrakeDistanceMeters = next;
    this.logger.info("drive.learning.coast_updated_long", {
      direction,
      coastDistanceMeasuredMeters: coastDistanceMeasured,
      brakeDistance: { before, after: next },
    });
  }

  private updateBrakeDistance(errorXValue: number): void {
    // Positive error = overshot, need to increase brake distance
    // Negative error = undershot, need to decrease brake distance
    const alpha = this.getAdaptiveLearningRate(Math.abs(errorXValue), 0.1, 0.08, 0.16);
    const adjustment = errorXValue * alpha;
    this.parameters.longDriveBrakeDistanceMeters += adjustment;

    // Clamp to a practical full-speed braking floor.
    this.parameters.longDriveBrakeDistanceMeters = Math.max(
      0.1,
      Math.min(5.0, this.parameters.longDriveBrakeDistanceMeters)
    );
  }

  private updateCteGain(directionSign: 1 | -1, maxCteValue: number, avgCteValue: number): void {
    const targetCte = DRIVE_TARGET_CTE_METERS;
    let gain = directionSign > 0 ? this.parameters.forwardCteGain : this.parameters.reverseCteGain;
    const lateralSeverity = Math.max(maxCteValue, avgCteValue);

    if (lateralSeverity > targetCte * 1.2) {
      // Lateral error is too high - increase gain more aggressively
      gain *= 1.08;
    } else if (lateralSeverity > targetCte * 0.7) {
      // Lateral error is still meaningful - nudge gain upward
      gain *= 1.03;
    } else if (lateralSeverity < targetCte * 0.35) {
      // Lateral error is very low - back gain off only slightly
      gain *= 0.997;
    }

    // Keep the gain bounded, but allow it to rise well above unity so the
    // controller can become much more assertive when the mower is drifting.
    const clampedGain = this.clamp(gain, 0.1, DriveLearningModel.MAX_CTE_GAIN);
    if (directionSign > 0) {
      this.parameters.forwardCteGain = clampedGain;
    } else {
      this.parameters.reverseCteGain = clampedGain;
    }
  }

  private getAdaptiveLearningRate(errorMagnitude: number, referenceMagnitude: number, minRate: number, maxRate: number): number {
    const safeReference = Math.max(referenceMagnitude, 1e-6);
    const normalized = Math.max(0, Math.min(1, errorMagnitude / safeReference));
    return minRate + ((maxRate - minRate) * normalized);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private createDefaultParameters(): DriveParameters {
    return {
      version: 3,
      longDriveBrakeDistanceMeters: DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
      forwardCteGain: DRIVE_CTE_GAIN_DEFAULT,
      reverseCteGain: DRIVE_CTE_GAIN_DEFAULT,
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBucketStepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      shortDriveMaxDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBrakeFractionsPositive: this.createNumericArray(this.getShortDriveBucketCount(), 0.5),
      shortDriveBrakeFractionsNegative: this.createNumericArray(this.getShortDriveBucketCount(), 0.5),
      shortDriveSampleCountsPositive: this.createNumericArray(this.getShortDriveBucketCount(), 0),
      shortDriveSampleCountsNegative: this.createNumericArray(this.getShortDriveBucketCount(), 0),
      shortDriveLastErrorPositiveMeters: this.createNumericArray(this.getShortDriveBucketCount(), 0),
      shortDriveLastErrorNegativeMeters: this.createNumericArray(this.getShortDriveBucketCount(), 0),
      updatedAt: new Date().toISOString(),
    };
  }

  private normalizeParameters(raw: unknown): DriveParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    if (this.isNumericArray(raw.shortDriveBrakeFractionsPositive) && this.isNumericArray(raw.shortDriveBrakeFractionsNegative)) {
      return {
        version: 3,
        longDriveBrakeDistanceMeters: this.readNumber(raw.longDriveBrakeDistanceMeters ?? raw.brakeDistanceMeters, DRIVE_BRAKE_DISTANCE_DEFAULT_METERS),
        forwardCteGain: this.clamp(this.readNumber(raw.forwardCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT), 0.1, DriveLearningModel.MAX_CTE_GAIN),
        reverseCteGain: this.clamp(this.readNumber(raw.reverseCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT), 0.1, DriveLearningModel.MAX_CTE_GAIN),
        longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
        shortDriveBucketStepMeters: this.readNumber(raw.shortDriveBucketStepMeters, DRIVE_SHORT_BUCKET_STEP_METERS),
        shortDriveMaxDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
        shortDriveBrakeFractionsPositive: this.normalizeNumericArray(raw.shortDriveBrakeFractionsPositive, 0.5),
        shortDriveBrakeFractionsNegative: this.normalizeNumericArray(raw.shortDriveBrakeFractionsNegative, 0.5),
        shortDriveSampleCountsPositive: this.normalizeNumericArray(raw.shortDriveSampleCountsPositive, 0),
        shortDriveSampleCountsNegative: this.normalizeNumericArray(raw.shortDriveSampleCountsNegative, 0),
        shortDriveLastErrorPositiveMeters: this.normalizeNumericArray(raw.shortDriveLastErrorPositiveMeters, 0),
        shortDriveLastErrorNegativeMeters: this.normalizeNumericArray(raw.shortDriveLastErrorNegativeMeters, 0),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      };
    }

    return {
      version: 3,
      longDriveBrakeDistanceMeters: this.readNumber(raw.longDriveBrakeDistanceMeters ?? raw.brakeDistanceMeters, DRIVE_BRAKE_DISTANCE_DEFAULT_METERS),
      forwardCteGain: this.clamp(this.readNumber(raw.forwardCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT), 0.1, DriveLearningModel.MAX_CTE_GAIN),
      reverseCteGain: this.clamp(this.readNumber(raw.reverseCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT), 0.1, DriveLearningModel.MAX_CTE_GAIN),
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBucketStepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      shortDriveMaxDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBrakeFractionsPositive: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.shortDriveBrakeFractionPositive ?? raw.shortDriveBrakeFractionCcw ?? raw.shortDriveBrakeDistancePositive, 0.5)),
      shortDriveBrakeFractionsNegative: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.shortDriveBrakeFractionNegative ?? raw.shortDriveBrakeFractionCw ?? raw.shortDriveBrakeDistanceNegative, 0.5)),
      shortDriveSampleCountsPositive: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.shortDriveSampleCountPositive, 0)),
      shortDriveSampleCountsNegative: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.shortDriveSampleCountNegative, 0)),
      shortDriveLastErrorPositiveMeters: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.lastShortErrorPositiveMeters, 0)),
      shortDriveLastErrorNegativeMeters: this.createNumericArray(this.getShortDriveBucketCount(), this.readNumber(raw.lastShortErrorNegativeMeters, 0)),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private createNumericArray(length: number, value: number): number[] {
    return Array.from({ length }, () => value);
  }

  private normalizeNumericArray(value: unknown, fallback: number): number[] {
    if (!Array.isArray(value)) {
      return this.createNumericArray(this.getShortDriveBucketCount(), fallback);
    }

    const items = value.slice(0, this.getShortDriveBucketCount()).map((item) => this.readNumber(item, fallback));
    while (items.length < this.getShortDriveBucketCount()) {
      items.push(fallback);
    }
    return items;
  }

  private isNumericArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
  }

  private getShortDriveBucketCount(): number {
    return this.getShortDriveBucketDistances().length;
  }

  private getShortDriveBucketDistance(requestedDistanceMeters: number): number {
    const requested = Math.max(DRIVE_SHORT_BUCKET_STEP_METERS, Math.min(this.parameters.longDriveMinDistanceMeters, Math.abs(requestedDistanceMeters)));
    const distances = this.getShortDriveBucketDistances();
    let nearest = distances[0];
    let nearestError = Math.abs(requested - nearest);

    for (const distance of distances.slice(1)) {
      const error = Math.abs(requested - distance);
      if (error < nearestError) {
        nearest = distance;
        nearestError = error;
      }
    }

    return Number(nearest.toFixed(2));
  }

  private getShortDriveBucketIndex(requestedDistanceMeters: number): number {
    const bucketDistance = this.getShortDriveBucketDistance(requestedDistanceMeters);
    const index = this.getShortDriveBucketDistances().findIndex((distance) => distance === bucketDistance);
    return index >= 0 ? index : 0;
  }

  private getShortDriveDirectionSign(startPosition: Position, targetPosition: Position): 1 | -1 {
    const dx = unwrapMeters(targetPosition.xMeters) - unwrapMeters(startPosition.xMeters);
    const dy = unwrapMeters(targetPosition.yMeters) - unwrapMeters(startPosition.yMeters);

    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? 1 : -1;
    }

    return dy >= 0 ? 1 : -1;
  }

  private getShortDriveBrakeFraction(startPosition: Position, targetPosition: Position, directionSign?: 1 | -1): number {
    const driveDistance = unwrapMeters(distanceBetween(startPosition, targetPosition));
    const bucketIndex = this.getShortDriveBucketIndex(driveDistance);
    const direction = directionSign ?? this.getShortDriveDirectionSign(startPosition, targetPosition);
    return direction > 0
      ? this.parameters.shortDriveBrakeFractionsPositive[bucketIndex]
      : this.parameters.shortDriveBrakeFractionsNegative[bucketIndex];
  }

  private getShortDriveBrakeDistance(startPosition: Position, targetPosition: Position, directionSign?: 1 | -1): number {
    const driveDistance = unwrapMeters(distanceBetween(startPosition, targetPosition));
    const bucketDistance = this.getShortDriveBucketDistance(driveDistance);
    const fraction = this.getShortDriveBrakeFraction(startPosition, targetPosition, directionSign);
    return bucketDistance * fraction;
  }

  private getShortDriveBuckets(): DriveShortDriveBucket[] {
    const bucketDistances = this.getShortDriveBucketDistances();
    const buckets: DriveShortDriveBucket[] = [];
    for (let index = 0; index < bucketDistances.length; index += 1) {
      buckets.push({
        bucketDistanceMeters: Number(bucketDistances[index].toFixed(2)),
        brakeFractionPositive: this.parameters.shortDriveBrakeFractionsPositive[index],
        brakeFractionNegative: this.parameters.shortDriveBrakeFractionsNegative[index],
        sampleCountPositive: this.parameters.shortDriveSampleCountsPositive[index],
        sampleCountNegative: this.parameters.shortDriveSampleCountsNegative[index],
        lastErrorPositiveMeters: this.parameters.shortDriveLastErrorPositiveMeters[index],
        lastErrorNegativeMeters: this.parameters.shortDriveLastErrorNegativeMeters[index],
      });
    }
    return buckets;
  }

  private getShortDriveBucketDistances(): number[] {
    return [...DRIVE_SHORT_BUCKET_DISTANCES_METERS];
  }
}
