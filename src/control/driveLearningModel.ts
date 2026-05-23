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
  DRIVE_SHORT_BUCKET_COARSE_START_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
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
}

export interface DriveLearningModelOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

export class DriveLearningModel {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private readonly legacyParametersPath: string;
  private parameters: DriveParameters;

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
    if (driveDistance > this.parameters.shortDriveMaxDistanceMeters) {
      return this.parameters.longDriveBrakeDistanceMeters as Meters;
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

  async updateFromDrive(data: DriveUpdateData): Promise<void> {
    const errorXValue = unwrapMeters(data.errorX);
    const maxCteValue = Math.abs(unwrapMeters(data.maxCte));
    const avgCteValue = Math.abs(unwrapMeters(data.avgCte));
    const direction: 1 | -1 = data.driveDirectionSign ?? this.getShortDriveDirectionSign(data.startPosition, data.targetPosition);

    const driveDistance = unwrapMeters(distanceBetween(data.startPosition, data.targetPosition));
    if (driveDistance <= this.parameters.shortDriveMaxDistanceMeters) {
      const bucketDistanceMeters = this.getShortDriveBucketDistance(driveDistance);
      const bucketIndex = this.getShortDriveBucketIndex(driveDistance);
      const currentFraction = this.getShortDriveBrakeFraction(data.startPosition, data.targetPosition, direction);
      const normalizedError = errorXValue / Math.max(bucketDistanceMeters, 0.05);
      const learningRate = this.getAdaptiveLearningRate(Math.abs(errorXValue), Math.max(bucketDistanceMeters * 0.25, 0.04), 0.08, 0.30);
      const adjustment = normalizedError * learningRate;
      const clampedFraction = Math.max(0.05, Math.min(0.95, currentFraction + adjustment));
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
      gain *= 1.12;
    } else if (lateralSeverity > targetCte * 0.7) {
      // Lateral error is still meaningful - nudge gain upward
      gain *= 1.06;
    } else if (lateralSeverity < targetCte * 0.35) {
      // Lateral error is very low - back gain off only slightly
      gain *= 0.995;
    }

    // Keep the gain bounded, but allow it to rise well above unity so the
    // controller can become much more assertive when the mower is drifting.
    const clampedGain = Math.max(0.1, Math.min(2.5, gain));
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

  private createDefaultParameters(): DriveParameters {
    return {
      version: 3,
      longDriveBrakeDistanceMeters: DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
      forwardCteGain: DRIVE_CTE_GAIN_DEFAULT,
      reverseCteGain: DRIVE_CTE_GAIN_DEFAULT,
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBucketStepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      shortDriveMaxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
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
        forwardCteGain: this.readNumber(raw.forwardCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT),
        reverseCteGain: this.readNumber(raw.reverseCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT),
        longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
        shortDriveBucketStepMeters: this.readNumber(raw.shortDriveBucketStepMeters, DRIVE_SHORT_BUCKET_STEP_METERS),
        shortDriveMaxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
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
      forwardCteGain: this.readNumber(raw.forwardCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT),
      reverseCteGain: this.readNumber(raw.reverseCteGain ?? raw.cteGain, DRIVE_CTE_GAIN_DEFAULT),
      longDriveMinDistanceMeters: DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS,
      shortDriveBucketStepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      shortDriveMaxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
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
    const requested = Math.max(DRIVE_SHORT_BUCKET_STEP_METERS, Math.min(this.parameters.shortDriveMaxDistanceMeters, Math.abs(requestedDistanceMeters)));
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
    const distances: number[] = [];

    for (let distance = DRIVE_SHORT_BUCKET_STEP_METERS; distance <= DRIVE_LONG_DRIVE_MIN_DISTANCE_METERS + 1e-9; distance += DRIVE_SHORT_BUCKET_STEP_METERS) {
      distances.push(Number(distance.toFixed(2)));
    }

    distances.push(Number(DRIVE_SHORT_BUCKET_COARSE_START_METERS.toFixed(2)));

    return distances;
  }
}
