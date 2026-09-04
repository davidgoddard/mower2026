/**
 * Drive learning model - adaptive parameter tuning for drive controller
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { Position, Meters, createMeters, unwrapMeters, distanceBetween } from "../geometry/positionTypes.js";
import {
  DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
  DRIVE_CTE_DAMPING_GAIN_DEFAULT,
  DRIVE_CTE_GAIN_DEFAULT,
  DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
  DRIVE_LONG_STEERING_HEADING_GAIN_PER_DEG,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_TARGET_CTE_METERS,
  DRIVE_LEARNING_PARAMETERS_PATH,
} from "../constants.js";
import { readJsonFile, writeJsonFile } from "../config/jsonFileStore.js";
import type { DriveSteeringMetrics } from "./driveSteeringMetrics.js";

const DRIVE_LEARNING_RATE = 0.7;

export interface DriveShortDriveBucket {
  bucketDistanceMeters: number;
  brakeDistancePositiveMeters: number;
  brakeDistanceNegativeMeters: number;
  sampleCountPositive: number;
  sampleCountNegative: number;
  lastErrorPositiveMeters: number;
  lastErrorNegativeMeters: number;
}

export interface DriveParameters {
  version: number;
  longDriveBrakeDistanceForwardMeters: number;
  longDriveBrakeDistanceReverseMeters: number;
  longHeadingBiasForwardPercent: number;
  longHeadingBiasReversePercent: number;
  longHeadingGainForwardPerDeg: number;
  longHeadingGainReversePerDeg: number;
  forwardCteGain: number;
  reverseCteGain: number;
  forwardCteDampingGain: number;
  reverseCteDampingGain: number;
  operationalSteeringSamplesForward: number;
  operationalSteeringSamplesReverse: number;
  longDriveMinDistanceMeters: number;
  shortDriveBrakeDistancesPositive: number[];
  shortDriveBrakeDistancesNegative: number[];
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
  learningDistanceClass?: "short" | "long";
  errorX: Meters;
  errorY: Meters;
  maxCte: Meters;
  avgCte: Meters;
  brakeDistanceUsed: Meters;
  longHeadingLearningMode?: "standard" | "bias-only" | "gain-only";
  learningScope?: "all" | "steering_only";
  steeringMetrics?: DriveSteeringMetrics;
}

export interface DriveLearningModelOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

export class DriveLearningModel {
  /**
   * The output trim remains hard-limited by DriveLineController. These wider
   * learning bounds let persistent, evidence-backed mowing drift use more of
   * that already-safe authority instead of becoming stuck at the historical
   * limits while CTE is still outside the target band.
   */
  private static readonly MAX_CTE_GAIN = 3.0;
  private static readonly MAX_CTE_DAMPING_GAIN = 1.2;
  private static readonly DEFAULT_LONG_HEADING_GAIN_PER_DEG = DRIVE_LONG_STEERING_HEADING_GAIN_PER_DEG;
  private static readonly MAX_LONG_HEADING_GAIN_PER_DEG = 0.03;
  private static readonly MAX_LONG_HEADING_BIAS_PERCENT = 0.2;
  private static readonly LONG_HEADING_BIAS_LEARNING_RATE = 0.5;

  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: DriveParameters;

  constructor(options: DriveLearningModelOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveLearningModel" });
    this.parametersPath = options.parametersPath ?? DRIVE_LEARNING_PARAMETERS_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("drive.learning.parameters_loaded", { path: this.parametersPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

  getBrakeDistanceForDrive(
    startPosition: Position,
    targetPosition: Position,
    directionSign?: 1 | -1,
    learningDistanceClass?: "short" | "long",
  ): Meters {
    const driveDistance = unwrapMeters(distanceBetween(startPosition, targetPosition));
    const direction: 1 | -1 = directionSign ?? 1;
    const distanceClass = learningDistanceClass ?? this.classifyDistance(driveDistance);
    if (distanceClass === "long") {
      return createMeters(direction > 0
        ? this.parameters.longDriveBrakeDistanceForwardMeters
        : this.parameters.longDriveBrakeDistanceReverseMeters);
    }
    return createMeters(this.getShortDriveBrakeDistance(driveDistance, direction));
  }

  getCteGainForDirection(directionSign: 1 | -1): number {
    return directionSign > 0 ? this.parameters.forwardCteGain : this.parameters.reverseCteGain;
  }

  getCteDampingGainForDirection(directionSign: 1 | -1): number {
    return directionSign > 0
      ? this.parameters.forwardCteDampingGain
      : this.parameters.reverseCteDampingGain;
  }

  getLongHeadingBiasForDirection(directionSign: 1 | -1): number {
    return directionSign > 0
      ? this.parameters.longHeadingBiasForwardPercent
      : this.parameters.longHeadingBiasReversePercent;
  }

  getLongHeadingGainForDirection(directionSign: 1 | -1): number {
    return directionSign > 0
      ? this.parameters.longHeadingGainForwardPerDeg
      : this.parameters.longHeadingGainReversePerDeg;
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

  async updateFromDrive(data: DriveUpdateData): Promise<void> {
    const errorXValue = unwrapMeters(data.errorX);
    const errorYValue = unwrapMeters(data.errorY);
    const maxCteValue = Math.abs(unwrapMeters(data.maxCte));
    const avgCteValue = Math.abs(unwrapMeters(data.avgCte));
    const direction: 1 | -1 = data.driveDirectionSign ?? this.inferDirectionSign(data.startPosition, data.targetPosition);
    const driveDistance = unwrapMeters(distanceBetween(data.startPosition, data.targetPosition));
    const distanceClass = data.learningDistanceClass ?? this.classifyDistance(driveDistance);

    if (data.learningScope === "steering_only") {
      const before = {
        proportional: this.getCteGainForDirection(direction),
        damping: this.getCteDampingGainForDirection(direction),
      };
      this.updateSteeringParameters(direction, maxCteValue, avgCteValue, data.steeringMetrics);
      if (direction > 0) {
        this.parameters.operationalSteeringSamplesForward += 1;
      } else {
        this.parameters.operationalSteeringSamplesReverse += 1;
      }
      this.logger.info("drive.learning.updated_operational_steering", {
        direction,
        metrics: data.steeringMetrics ?? null,
        proportionalGain: { before: before.proportional, after: this.getCteGainForDirection(direction) },
        dampingGain: { before: before.damping, after: this.getCteDampingGainForDirection(direction) },
      });
      await this.saveParameters();
      return;
    }

    if (distanceClass === "short") {
      const bucketIndex = this.getBucketIndex(driveDistance);
      const currentBrake = direction > 0
        ? this.parameters.shortDriveBrakeDistancesPositive[bucketIndex]
        : this.parameters.shortDriveBrakeDistancesNegative[bucketIndex];

      // Negative errorX = stopped short = braked too early = decrease brake distance.
      // Positive errorX = overshot = braked too late = increase brake distance.
      const adjustment = errorXValue * DRIVE_LEARNING_RATE;
      // A severe overshoot can prove that braking must begin as soon as the
      // first post-command pose arrives. Preserve that evidence instead of
      // clipping it to the requested leg length; DriveLineController treats a
      // learned distance at/above the leg length as an immediate brake trigger.
      const newBrake = this.clamp(currentBrake + adjustment, 0, DRIVE_SHORT_BUCKET_MAX_METERS);

      const cteGainBefore = this.getCteGainForDirection(direction);
      this.updateSteeringParameters(direction, maxCteValue, avgCteValue, data.steeringMetrics);
      const cteGainAfter = this.getCteGainForDirection(direction);

      if (direction > 0) {
        this.parameters.shortDriveBrakeDistancesPositive[bucketIndex] = newBrake;
        this.parameters.shortDriveSampleCountsPositive[bucketIndex] += 1;
        this.parameters.shortDriveLastErrorPositiveMeters[bucketIndex] = errorXValue;
      } else {
        this.parameters.shortDriveBrakeDistancesNegative[bucketIndex] = newBrake;
        this.parameters.shortDriveSampleCountsNegative[bucketIndex] += 1;
        this.parameters.shortDriveLastErrorNegativeMeters[bucketIndex] = errorXValue;
      }

      this.parameters.updatedAt = new Date().toISOString();
      this.logger.info("drive.learning.updated_short", {
        driveDistance,
        bucketDistanceMeters: this.getBucketDistance(driveDistance),
        direction,
        currentBrakeMeters: currentBrake,
        errorXMeters: errorXValue,
        adjustment,
        newBrakeMeters: newBrake,
        cteGain: { before: cteGainBefore, after: cteGainAfter },
      });
      await this.saveParameters();
      return;
    }

    const longHeadingLearningMode = data.longHeadingLearningMode ?? "standard";
    if (longHeadingLearningMode === "bias-only") {
      const before = this.getLongHeadingBiasForDirection(direction);
      const adjustment = errorYValue * DriveLearningModel.LONG_HEADING_BIAS_LEARNING_RATE;
      const after = this.clamp(
        before + adjustment,
        -DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
        DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
      );
      if (direction > 0) {
        this.parameters.longHeadingBiasForwardPercent = after;
      } else {
        this.parameters.longHeadingBiasReversePercent = after;
      }
      this.logger.info("drive.learning.updated_long_heading_bias", {
        direction,
        errorYMeters: errorYValue,
        biasPercent: { before, after },
      });
      await this.saveParameters();
      return;
    }

    if (longHeadingLearningMode === "gain-only") {
      const before = this.getLongHeadingGainForDirection(direction);
      const lateralSeverity = Math.max(Math.abs(errorYValue), maxCteValue, avgCteValue);
      let gain = before;
      if (lateralSeverity > DRIVE_TARGET_CTE_METERS * 1.2) {
        gain *= 1.08;
      } else if (lateralSeverity > DRIVE_TARGET_CTE_METERS * 0.7) {
        gain *= 1.03;
      } else if (lateralSeverity < DRIVE_TARGET_CTE_METERS * 0.35) {
        gain *= 0.997;
      }
      const after = this.clamp(
        gain,
        0,
        DriveLearningModel.MAX_LONG_HEADING_GAIN_PER_DEG,
      );
      if (direction > 0) {
        this.parameters.longHeadingGainForwardPerDeg = after;
      } else {
        this.parameters.longHeadingGainReversePerDeg = after;
      }
      this.logger.info("drive.learning.updated_long_heading_gain", {
        direction,
        errorYMeters: errorYValue,
        maxCte: maxCteValue,
        avgCte: avgCteValue,
        headingGainPerDeg: { before, after },
      });
      await this.saveParameters();
      return;
    }

    // Long drive: same direct errorX adjustment on the direction-specific scalar.
    const before = direction > 0
      ? this.parameters.longDriveBrakeDistanceForwardMeters
      : this.parameters.longDriveBrakeDistanceReverseMeters;
    const adjustment = errorXValue * DRIVE_LEARNING_RATE;
    const after = this.clamp(before + adjustment, 0.05, 5.0);
    if (direction > 0) {
      this.parameters.longDriveBrakeDistanceForwardMeters = after;
    } else {
      this.parameters.longDriveBrakeDistanceReverseMeters = after;
    }

    const cteGainBefore = this.getCteGainForDirection(direction);
    this.updateSteeringParameters(direction, maxCteValue, avgCteValue, data.steeringMetrics);
    const cteGainAfter = this.getCteGainForDirection(direction);

    this.logger.info("drive.learning.updated", {
      errorXMeters: errorXValue,
      maxCte: maxCteValue,
      brakeDistance: { before, after },
      cteGain: { before: cteGainBefore, after: cteGainAfter },
      direction,
    });

    await this.saveParameters();
  }

  private updateSteeringParameters(
    directionSign: 1 | -1,
    maxCteValue: number,
    avgCteValue: number,
    metrics?: DriveSteeringMetrics,
  ): void {
    const targetCte = DRIVE_TARGET_CTE_METERS;
    let gain = directionSign > 0 ? this.parameters.forwardCteGain : this.parameters.reverseCteGain;
    let damping = this.getCteDampingGainForDirection(directionSign);
    const lateralSeverity = Math.max(maxCteValue, avgCteValue);

    if (metrics && metrics.sampleCount >= 3) {
      const repeatedCrossing = metrics.baselineCrossings >= 2;
      // One crossing is the permitted initial convergence arc. Only teach
      // additional damping after the mower has crossed the baseline again.
      const nonDecayingOscillation = metrics.baselineCrossings >= 2
        && metrics.nonDecayingCrossings >= 1;
      if (repeatedCrossing || nonDecayingOscillation) {
        damping += nonDecayingOscillation ? 0.025 : 0.012;
        // Once damping is already substantial, repeated crossings indicate
        // that proportional authority is itself too aggressive.
        if (metrics.baselineCrossings >= 4 && damping >= 0.25) gain *= 0.985;
      } else if (lateralSeverity > targetCte * 1.2) {
        gain *= 1.05;
      } else if (lateralSeverity > targetCte * 0.7) {
        gain *= 1.015;
      } else if (metrics.meanAbsCteMeters <= targetCte) {
        // A clean strip with no repeat crossing is evidence that the current
        // terrain needs less damping. This lets dry/short grass unwind a gain
        // learned on heavier ground without reacting to a single sample.
        damping *= 0.995;
      }
    } else if (lateralSeverity > targetCte * 1.2) {
      gain *= 1.08;
    } else if (lateralSeverity > targetCte * 0.7) {
      gain *= 1.03;
    } else if (lateralSeverity < targetCte * 0.35) {
      gain *= 0.997;
    }

    const clampedGain = this.clamp(gain, 0.1, DriveLearningModel.MAX_CTE_GAIN);
    const clampedDamping = this.clamp(damping, 0, DriveLearningModel.MAX_CTE_DAMPING_GAIN);
    if (directionSign > 0) {
      this.parameters.forwardCteGain = clampedGain;
      this.parameters.forwardCteDampingGain = clampedDamping;
    } else {
      this.parameters.reverseCteGain = clampedGain;
      this.parameters.reverseCteDampingGain = clampedDamping;
    }
  }

  private inferDirectionSign(startPosition: Position, targetPosition: Position): 1 | -1 {
    const dx = unwrapMeters(targetPosition.xMeters) - unwrapMeters(startPosition.xMeters);
    const dy = unwrapMeters(targetPosition.yMeters) - unwrapMeters(startPosition.yMeters);
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? 1 : -1;
    }
    return dy >= 0 ? 1 : -1;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private classifyDistance(driveDistance: number): "short" | "long" {
    return driveDistance > this.parameters.longDriveMinDistanceMeters ? "long" : "short";
  }

  private getShortDriveBrakeDistance(driveDistance: number, direction: 1 | -1): number {
    const bucketIndex = this.getBucketIndex(driveDistance);
    return direction > 0
      ? this.parameters.shortDriveBrakeDistancesPositive[bucketIndex]
      : this.parameters.shortDriveBrakeDistancesNegative[bucketIndex];
  }

  private getBucketDistance(requestedDistanceMeters: number): number {
    const distances = [...DRIVE_SHORT_BUCKET_DISTANCES_METERS];
    const clamped = Math.max(distances[0], Math.min(distances[distances.length - 1], Math.abs(requestedDistanceMeters)));
    let nearest = distances[0];
    let nearestError = Math.abs(clamped - nearest);
    for (const d of distances.slice(1)) {
      const e = Math.abs(clamped - d);
      if (e < nearestError) { nearest = d; nearestError = e; }
    }
    return nearest;
  }

  private getBucketIndex(requestedDistanceMeters: number): number {
    const bucket = this.getBucketDistance(requestedDistanceMeters);
    const idx = ([...DRIVE_SHORT_BUCKET_DISTANCES_METERS] as number[]).indexOf(bucket);
    return idx >= 0 ? idx : 0;
  }

  private defaultBrakeDistance(bucketDistance: number): number {
    // Default: brake at half the bucket distance. This is conservative — the
    // learner will quickly push it down once real runs start.
    return bucketDistance * 0.5;
  }

  private createDefaultParameters(): DriveParameters {
    const distances = [...DRIVE_SHORT_BUCKET_DISTANCES_METERS];
    const count = distances.length;
    return {
      version: 8,
      longDriveBrakeDistanceForwardMeters: DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
      longDriveBrakeDistanceReverseMeters: DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
      longHeadingBiasForwardPercent: 0,
      longHeadingBiasReversePercent: 0,
      longHeadingGainForwardPerDeg: DriveLearningModel.DEFAULT_LONG_HEADING_GAIN_PER_DEG,
      longHeadingGainReversePerDeg: DriveLearningModel.DEFAULT_LONG_HEADING_GAIN_PER_DEG,
      forwardCteGain: DRIVE_CTE_GAIN_DEFAULT,
      reverseCteGain: DRIVE_CTE_GAIN_DEFAULT,
      forwardCteDampingGain: DRIVE_CTE_DAMPING_GAIN_DEFAULT,
      reverseCteDampingGain: DRIVE_CTE_DAMPING_GAIN_DEFAULT,
      operationalSteeringSamplesForward: 0,
      operationalSteeringSamplesReverse: 0,
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBrakeDistancesPositive: distances.map((d) => this.defaultBrakeDistance(d)),
      shortDriveBrakeDistancesNegative: distances.map((d) => this.defaultBrakeDistance(d)),
      shortDriveSampleCountsPositive: Array(count).fill(0),
      shortDriveSampleCountsNegative: Array(count).fill(0),
      shortDriveLastErrorPositiveMeters: Array(count).fill(0),
      shortDriveLastErrorNegativeMeters: Array(count).fill(0),
      updatedAt: new Date().toISOString(),
    };
  }

  private normalizeParameters(raw: unknown): DriveParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const distances = [...DRIVE_SHORT_BUCKET_DISTANCES_METERS];
    const count = distances.length;

    const shortPos = this.normalizeAbsoluteArray(
      (raw as Record<string, unknown>).shortDriveBrakeDistancesPositive,
      distances,
      (d) => this.defaultBrakeDistance(d),
    );
    const shortNeg = this.normalizeAbsoluteArray(
      (raw as Record<string, unknown>).shortDriveBrakeDistancesNegative,
      distances,
      (d) => this.defaultBrakeDistance(d),
    );

    return {
      version: 8,
      longDriveBrakeDistanceForwardMeters: this.readNumber(
        (raw as Record<string, unknown>).longDriveBrakeDistanceForwardMeters,
        this.readNumber(
          (raw as Record<string, unknown>).longDriveBrakeDistanceMeters,
          DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
        ),
      ),
      longDriveBrakeDistanceReverseMeters: this.readNumber(
        (raw as Record<string, unknown>).longDriveBrakeDistanceReverseMeters,
        this.readNumber(
          (raw as Record<string, unknown>).longDriveBrakeDistanceMeters,
          DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
        ),
      ),
      longHeadingBiasForwardPercent: this.clamp(
        this.readNumber((raw as Record<string, unknown>).longHeadingBiasForwardPercent, 0),
        -DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
        DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
      ),
      longHeadingBiasReversePercent: this.clamp(
        this.readNumber((raw as Record<string, unknown>).longHeadingBiasReversePercent, 0),
        -DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
        DriveLearningModel.MAX_LONG_HEADING_BIAS_PERCENT,
      ),
      longHeadingGainForwardPerDeg: this.clamp(
        this.readNumber(
          (raw as Record<string, unknown>).longHeadingGainForwardPerDeg,
          DriveLearningModel.DEFAULT_LONG_HEADING_GAIN_PER_DEG,
        ),
        0,
        DriveLearningModel.MAX_LONG_HEADING_GAIN_PER_DEG,
      ),
      longHeadingGainReversePerDeg: this.clamp(
        this.readNumber(
          (raw as Record<string, unknown>).longHeadingGainReversePerDeg,
          DriveLearningModel.DEFAULT_LONG_HEADING_GAIN_PER_DEG,
        ),
        0,
        DriveLearningModel.MAX_LONG_HEADING_GAIN_PER_DEG,
      ),
      forwardCteGain: this.clamp(
        this.readNumber((raw as Record<string, unknown>).forwardCteGain, DRIVE_CTE_GAIN_DEFAULT),
        0.1,
        DriveLearningModel.MAX_CTE_GAIN,
      ),
      reverseCteGain: this.clamp(
        this.readNumber((raw as Record<string, unknown>).reverseCteGain, DRIVE_CTE_GAIN_DEFAULT),
        0.1,
        DriveLearningModel.MAX_CTE_GAIN,
      ),
      forwardCteDampingGain: this.clamp(
        this.readNumber((raw as Record<string, unknown>).forwardCteDampingGain, DRIVE_CTE_DAMPING_GAIN_DEFAULT),
        0,
        DriveLearningModel.MAX_CTE_DAMPING_GAIN,
      ),
      reverseCteDampingGain: this.clamp(
        this.readNumber((raw as Record<string, unknown>).reverseCteDampingGain, DRIVE_CTE_DAMPING_GAIN_DEFAULT),
        0,
        DriveLearningModel.MAX_CTE_DAMPING_GAIN,
      ),
      operationalSteeringSamplesForward: Math.max(
        0,
        Math.trunc(this.readNumber((raw as Record<string, unknown>).operationalSteeringSamplesForward, 0)),
      ),
      operationalSteeringSamplesReverse: Math.max(
        0,
        Math.trunc(this.readNumber((raw as Record<string, unknown>).operationalSteeringSamplesReverse, 0)),
      ),
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBrakeDistancesPositive: shortPos,
      shortDriveBrakeDistancesNegative: shortNeg,
      shortDriveSampleCountsPositive: this.normalizeNumericArray(
        (raw as Record<string, unknown>).shortDriveSampleCountsPositive, count, 0,
      ),
      shortDriveSampleCountsNegative: this.normalizeNumericArray(
        (raw as Record<string, unknown>).shortDriveSampleCountsNegative, count, 0,
      ),
      shortDriveLastErrorPositiveMeters: this.normalizeNumericArray(
        (raw as Record<string, unknown>).shortDriveLastErrorPositiveMeters, count, 0,
      ),
      shortDriveLastErrorNegativeMeters: this.normalizeNumericArray(
        (raw as Record<string, unknown>).shortDriveLastErrorNegativeMeters, count, 0,
      ),
      updatedAt: typeof (raw as Record<string, unknown>).updatedAt === "string"
        ? (raw as Record<string, unknown>).updatedAt as string
        : new Date().toISOString(),
    };
  }

  /**
   * Normalise a persisted absolute-brake-distance array.  If the persisted
   * array has the wrong length (e.g. after a bucket-list change) we fall back
   * to defaults for every bucket — don't try to map old indices to new ones.
   */
  private normalizeAbsoluteArray(
    value: unknown,
    distances: readonly number[],
    defaultFn: (d: number) => number,
  ): number[] {
    if (Array.isArray(value) && value.length === distances.length && value.every((v) => typeof v === "number" && Number.isFinite(v))) {
      return value.map((v) => this.clamp(v, 0, DRIVE_SHORT_BUCKET_MAX_METERS));
    }
    return distances.map((d) => defaultFn(d));
  }

  private normalizeNumericArray(value: unknown, count: number, fallback: number): number[] {
    if (Array.isArray(value) && value.length === count) {
      return value.map((v) => this.readNumber(v, fallback));
    }
    return Array(count).fill(fallback);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private getShortDriveBuckets(): DriveShortDriveBucket[] {
    const distances = [...DRIVE_SHORT_BUCKET_DISTANCES_METERS];
    return distances.map((d, i) => ({
      bucketDistanceMeters: d,
      brakeDistancePositiveMeters: this.parameters.shortDriveBrakeDistancesPositive[i],
      brakeDistanceNegativeMeters: this.parameters.shortDriveBrakeDistancesNegative[i],
      sampleCountPositive: this.parameters.shortDriveSampleCountsPositive[i],
      sampleCountNegative: this.parameters.shortDriveSampleCountsNegative[i],
      lastErrorPositiveMeters: this.parameters.shortDriveLastErrorPositiveMeters[i],
      lastErrorNegativeMeters: this.parameters.shortDriveLastErrorNegativeMeters[i],
    }));
  }
}
