/**
 * Turn learning model with parameter persistence
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import {
  RelativeAngle,
  createRelativeAngle,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  TurnLearningInput,
  TurnLearningParameters,
  TurnDirection,
  TurnLearningBin,
  TurnLearningBucket,
} from "./turnControllerTypes.js";
import {
  TURN_SMALL_ANGLE_THRESHOLD_DEG,
  TURN_LEARNING_RATE,
  TURN_LEARNING_PARAMETERS_PATH,
} from "../constants.js";

const SMALL_TURN_BUCKET_STEP_DEG = 3;
const SMALL_TURN_BUCKET_MAX_DEG = 60;
const SMALL_TURN_BUCKET_COUNT = SMALL_TURN_BUCKET_MAX_DEG / SMALL_TURN_BUCKET_STEP_DEG;
const SMALL_TURN_BUCKET_TRAINING_TOLERANCE_DEG = 0.1;
const SMALL_TURN_DEFAULT_BRAKE_MS_PER_DEG = 45;
const SMALL_TURN_MIN_BRAKE_TIME_MS = 60;
const SMALL_TURN_MAX_BRAKE_TIME_MS = 2400;

const LARGE_TURN_BUCKET_STEP_DEG = 10;
const LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG = 25;
const LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG = 0;
const LARGE_TURN_MIN_BIAS_OFFSET_DEG = -15;
const LARGE_TURN_MAX_BIAS_OFFSET_DEG = 15;
const LARGE_TURN_MIN_BRAKE_DISTANCE_DEG = 5;
const LARGE_TURN_MAX_BRAKE_DISTANCE_DEG = 90;
const LARGE_TURN_MIN_ANGLE_DEG =
  Math.floor(TURN_SMALL_ANGLE_THRESHOLD_DEG / LARGE_TURN_BUCKET_STEP_DEG) * LARGE_TURN_BUCKET_STEP_DEG
  + LARGE_TURN_BUCKET_STEP_DEG;
const LARGE_TURN_MAX_ANGLE_DEG = 180;
const LARGE_TURN_BUCKET_COUNT =
  ((LARGE_TURN_MAX_ANGLE_DEG - LARGE_TURN_MIN_ANGLE_DEG) / LARGE_TURN_BUCKET_STEP_DEG) + 1;

export interface TurnLearningModelOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyTurnLearningParametersV2 {
  version?: unknown;
  smallAngleThresholdDeg?: unknown;
  largeTurnBrakeCcwDeg?: unknown;
  largeTurnBrakeCwDeg?: unknown;
  largeTurnSampleCountCcw?: unknown;
  largeTurnSampleCountCw?: unknown;
  lastErrorCcwDeg?: unknown;
  lastErrorCwDeg?: unknown;
  lastUpdated?: unknown;
  smallTurnBrakeFractionCcw?: unknown;
  smallTurnBrakeFractionCw?: unknown;
  smallTurnSampleCountCcw?: unknown;
  smallTurnSampleCountCw?: unknown;
  lastSmallErrorCcwDeg?: unknown;
  lastSmallErrorCwDeg?: unknown;
}

export class TurnLearningModel {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: TurnLearningParameters;
  private readonly learningRate: number;

  constructor(options: TurnLearningModelOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnLearningModel" });
    this.parametersPath = options.parametersPath ?? TURN_LEARNING_PARAMETERS_PATH;
    this.parameters = this.createDefaultParameters();
    this.learningRate = TURN_LEARNING_RATE;
  }

  async loadParameters(): Promise<void> {
    try {
      const json = await readFile(this.parametersPath, "utf-8");
      const parsed = JSON.parse(json) as unknown;
      this.parameters = this.normalizeParameters(parsed);
      this.logger.info("turn.learning.loaded", {
        version: this.parameters.version,
        smallAngleThresholdDeg: this.parameters.smallAngleThresholdDeg,
        largeTurnBucketStepDeg: this.parameters.largeTurnBucketStepDeg,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("turn.learning.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
        this.parameters = this.createDefaultParameters();
        await this.saveParameters();
      } else {
        this.logger.warn("turn.learning.load_failed", {
          error: String(error),
          using: "defaults",
        });
        this.parameters = this.createDefaultParameters();
        await this.saveParameters();
      }
    }
  }

  async saveParameters(): Promise<void> {
    try {
      const dir = dirname(this.parametersPath);
      await mkdir(dir, { recursive: true });
      await writeFile(this.parametersPath, JSON.stringify(this.parameters, null, 2), "utf-8");
    } catch (error) {
      this.logger.error("turn.learning.save_failed", {
        error: String(error),
        path: this.parametersPath,
      });
    }
  }

  async updateFromTurn(result: TurnLearningInput): Promise<void> {
    const requestedAbs = Math.abs(unwrapRelativeAngle(result.requestedAngle));
    const achievedAbs = result.achievedAngleUnwrappedDeg !== undefined
      ? Math.abs(result.achievedAngleUnwrappedDeg)
      : Math.abs(unwrapRelativeAngle(result.achievedAngle));

    if (requestedAbs <= this.parameters.smallAngleThresholdDeg) {
      const bucketAngleDeg = this.getSmallTurnBucketAngle(requestedAbs);
      if (!this.isNearSmallTurnBucket(requestedAbs, bucketAngleDeg)) {
        this.logger.info("turn.learning.skipped_small_non_bucket", {
          direction: result.direction,
          requestedAngleDeg: requestedAbs,
          nearestBucketAngleDeg: bucketAngleDeg,
          toleranceDeg: SMALL_TURN_BUCKET_TRAINING_TOLERANCE_DEG,
          achievedAngleDeg: achievedAbs,
        });
        return;
      }
      const bucketIndex = this.getSmallTurnBucketIndex(requestedAbs);
      const currentBrakeTimeMs = this.getSmallTurnBrakeTimeBucketValue(
        result.direction,
        bucketAngleDeg,
      );
      const errorDeg = achievedAbs - requestedAbs;
      const normalizedError = errorDeg / Math.max(1, requestedAbs);
      const adjustmentMs = -currentBrakeTimeMs * normalizedError * this.learningRate;
      const clampedBrakeTimeMs = Math.max(
        SMALL_TURN_MIN_BRAKE_TIME_MS,
        Math.min(SMALL_TURN_MAX_BRAKE_TIME_MS, currentBrakeTimeMs + adjustmentMs),
      );

      if (result.direction === "ccw") {
        this.parameters.smallTurnBrakeTimesCcwMs[bucketIndex] = clampedBrakeTimeMs;
        this.parameters.smallTurnSampleCountsCcw[bucketIndex] += 1;
        this.parameters.smallTurnLastErrorCcwDeg[bucketIndex] = achievedAbs - requestedAbs;
      } else {
        this.parameters.smallTurnBrakeTimesCwMs[bucketIndex] = clampedBrakeTimeMs;
        this.parameters.smallTurnSampleCountsCw[bucketIndex] += 1;
        this.parameters.smallTurnLastErrorCwDeg[bucketIndex] = achievedAbs - requestedAbs;
      }

      this.parameters.lastUpdated = new Date().toISOString();
      this.logger.info("turn.learning.updated_small", {
        direction: result.direction,
        bucketAngleDeg,
        requestedAngleDeg: requestedAbs,
        achievedAngleDeg: achievedAbs,
        mode: "bucketed_timeout_and_halt",
        currentBrakeTimeMs,
        brakeTimeUsedMs: result.brakeTimeUsedMs,
        errorDeg,
        normalizedError,
        adjustmentMs,
        newBrakeTimeMs: clampedBrakeTimeMs,
      });
      await this.saveParameters();
      return;
    }

    const bucketAngleDeg = this.getLargeTurnBucketAngle(requestedAbs);
    const bucketIndex = this.getLargeTurnBucketIndex(requestedAbs);
    const currentBrakeDistance = this.getLargeTurnBrakeDistance(result.direction, requestedAbs);
    const errorDeg = achievedAbs - requestedAbs;
    const adjustment = errorDeg * this.learningRate;
    const clampedBrakeDistance = Math.max(
      LARGE_TURN_MIN_BRAKE_DISTANCE_DEG,
      Math.min(LARGE_TURN_MAX_BRAKE_DISTANCE_DEG, currentBrakeDistance + adjustment),
    );

    // Update bias offset: the error after rate-based prediction is the
    // residual the bias corrects. Positive error (overshot) → increase bias so
    // brake fires earlier next time; negative error (undershot) → decrease.
    const currentBias = result.direction === "ccw"
      ? this.parameters.largeTurnBiasOffsetsCcwDeg[bucketIndex]
      : this.parameters.largeTurnBiasOffsetsCwDeg[bucketIndex];
    const biasAdjustment = errorDeg * this.learningRate;
    const clampedBias = Math.max(
      LARGE_TURN_MIN_BIAS_OFFSET_DEG,
      Math.min(LARGE_TURN_MAX_BIAS_OFFSET_DEG, currentBias + biasAdjustment),
    );

    if (result.direction === "ccw") {
      this.parameters.largeTurnBrakeDistancesCcwDeg[bucketIndex] = clampedBrakeDistance;
      this.parameters.largeTurnBiasOffsetsCcwDeg[bucketIndex] = clampedBias;
      this.parameters.largeTurnSampleCountsCcw[bucketIndex] += 1;
      this.parameters.largeTurnLastErrorsCcwDeg[bucketIndex] = errorDeg;
    } else {
      this.parameters.largeTurnBrakeDistancesCwDeg[bucketIndex] = clampedBrakeDistance;
      this.parameters.largeTurnBiasOffsetsCwDeg[bucketIndex] = clampedBias;
      this.parameters.largeTurnSampleCountsCw[bucketIndex] += 1;
      this.parameters.largeTurnLastErrorsCwDeg[bucketIndex] = errorDeg;
    }

    this.parameters.lastUpdated = new Date().toISOString();
    this.logger.info("turn.learning.updated_large", {
      direction: result.direction,
      bucketAngleDeg,
      requestedAngleDeg: requestedAbs,
      achievedAngleDeg: achievedAbs,
      errorDeg,
      adjustment,
      newBrakeDistanceDeg: clampedBrakeDistance,
      biasAdjustment,
      newBiasOffsetDeg: clampedBias,
    });
    await this.saveParameters();
  }

  getBrakeDistance(direction: TurnDirection, requestedAngleDeg: number): RelativeAngle {
    const brakeDistanceDeg = requestedAngleDeg <= this.parameters.smallAngleThresholdDeg
      ? this.getLegacyLargeDirectionDefault(direction)
      : this.getLargeTurnBrakeDistance(direction, requestedAngleDeg);
    return createRelativeAngle(brakeDistanceDeg);
  }

  getBrakeAngle(requestedAngleDeg: number, direction: TurnDirection): RelativeAngle {
    const requested = Math.abs(requestedAngleDeg);
    if (requested <= this.parameters.smallAngleThresholdDeg) {
      return createRelativeAngle(0);
    }
    const brakeDistance = this.getLargeTurnBrakeDistance(direction, requested);
    return createRelativeAngle(Math.max(1, Math.min(requested, brakeDistance)));
  }

  /**
   * Return the persisted residual bias offset (degrees) for the large-turn
   * rate-based brake prediction for the given direction and angle.
   *
   * The controller computes its brake trigger as:
   *   remaining <= liveRate × (rampDownTime / 2) + biasOffset
   *
   * A positive bias means the mower historically coasts further than the rate
   * prediction alone; a negative bias means it stops short.
   */
  getLargeBiasOffset(requestedAngleDeg: number, direction: TurnDirection): number {
    const requested = Math.abs(requestedAngleDeg);
    if (requested <= this.parameters.smallAngleThresholdDeg) {
      return LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG;
    }
    const bucketIndex = this.getLargeTurnBucketIndex(requested);
    return direction === "ccw"
      ? this.parameters.largeTurnBiasOffsetsCcwDeg[bucketIndex]
      : this.parameters.largeTurnBiasOffsetsCwDeg[bucketIndex];
  }

  getSmallTurnBrakeTimeMs(direction: TurnDirection, requestedAngleDeg: number): number {
    const requested = Math.abs(requestedAngleDeg);
    const clamped = Math.max(
      SMALL_TURN_BUCKET_STEP_DEG,
      Math.min(SMALL_TURN_BUCKET_MAX_DEG, requested),
    );
    const lowerBucketAngleDeg = Math.floor(clamped / SMALL_TURN_BUCKET_STEP_DEG) * SMALL_TURN_BUCKET_STEP_DEG;
    const upperBucketAngleDeg = Math.ceil(clamped / SMALL_TURN_BUCKET_STEP_DEG) * SMALL_TURN_BUCKET_STEP_DEG;
    const boundedLowerBucketAngleDeg = Math.max(SMALL_TURN_BUCKET_STEP_DEG, lowerBucketAngleDeg);
    const boundedUpperBucketAngleDeg = Math.min(SMALL_TURN_BUCKET_MAX_DEG, upperBucketAngleDeg);

    const lowerBrakeTimeMs = this.getSmallTurnBrakeTimeBucketValue(direction, boundedLowerBucketAngleDeg);
    if (boundedLowerBucketAngleDeg === boundedUpperBucketAngleDeg) {
      return lowerBrakeTimeMs;
    }

    const upperBrakeTimeMs = this.getSmallTurnBrakeTimeBucketValue(direction, boundedUpperBucketAngleDeg);
    const interpolationFraction =
      (clamped - boundedLowerBucketAngleDeg) / (boundedUpperBucketAngleDeg - boundedLowerBucketAngleDeg);
    return lowerBrakeTimeMs + ((upperBrakeTimeMs - lowerBrakeTimeMs) * interpolationFraction);
  }

  getSmallTurnBucketAngleDeg(requestedAngleDeg: number): number {
    return this.getSmallTurnBucketAngle(requestedAngleDeg);
  }

  getLargeTurnBucketAngleDeg(requestedAngleDeg: number): number {
    return this.getLargeTurnBucketAngle(requestedAngleDeg);
  }

  getSmallAngleThreshold(): number {
    return this.parameters.smallAngleThresholdDeg;
  }

  getParameters(): TurnLearningParameters {
    const parameters: TurnLearningBin[] = [];
    for (let requestedAngleDeg = LARGE_TURN_MIN_ANGLE_DEG; requestedAngleDeg <= LARGE_TURN_MAX_ANGLE_DEG; requestedAngleDeg += LARGE_TURN_BUCKET_STEP_DEG) {
      const index = this.getLargeTurnBucketIndex(requestedAngleDeg);
      parameters.push({
        requestedAngleDeg,
        brakeDistanceDeg: this.parameters.largeTurnBrakeDistancesCcwDeg[index],
        biasOffsetDeg: this.parameters.largeTurnBiasOffsetsCcwDeg[index],
        direction: "ccw",
        sampleCount: this.parameters.largeTurnSampleCountsCcw[index],
        lastErrorDeg: this.parameters.largeTurnLastErrorsCcwDeg[index],
      });
      parameters.push({
        requestedAngleDeg,
        brakeDistanceDeg: this.parameters.largeTurnBrakeDistancesCwDeg[index],
        biasOffsetDeg: this.parameters.largeTurnBiasOffsetsCwDeg[index],
        direction: "cw",
        sampleCount: this.parameters.largeTurnSampleCountsCw[index],
        lastErrorDeg: this.parameters.largeTurnLastErrorsCwDeg[index],
      });
    }

    return {
      ...this.parameters,
      parameters,
      smallTurnBuckets: this.getSmallTurnBuckets(),
    };
  }

  getLearningDiagnostics(): {
    learningRate: number;
    smallTurnBrakeTimeMinMs: number;
    smallTurnBrakeTimeMaxMs: number;
    largeTurnBrakeDistanceMinDeg: number;
    largeTurnBrakeDistanceMaxDeg: number;
    largeTurnBiasOffsetMinDeg: number;
    largeTurnBiasOffsetMaxDeg: number;
  } {
    return {
      learningRate: this.learningRate,
      smallTurnBrakeTimeMinMs: SMALL_TURN_MIN_BRAKE_TIME_MS,
      smallTurnBrakeTimeMaxMs: SMALL_TURN_MAX_BRAKE_TIME_MS,
      largeTurnBrakeDistanceMinDeg: LARGE_TURN_MIN_BRAKE_DISTANCE_DEG,
      largeTurnBrakeDistanceMaxDeg: LARGE_TURN_MAX_BRAKE_DISTANCE_DEG,
      largeTurnBiasOffsetMinDeg: LARGE_TURN_MIN_BIAS_OFFSET_DEG,
      largeTurnBiasOffsetMaxDeg: LARGE_TURN_MAX_BIAS_OFFSET_DEG,
    };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("turn.learning.reset", {
      smallAngleThresholdDeg: this.parameters.smallAngleThresholdDeg,
      largeTurnBucketStepDeg: this.parameters.largeTurnBucketStepDeg,
    });
  }

  private normalizeParameters(raw: unknown): TurnLearningParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    if (
      this.isNumericArray(raw.smallTurnBrakeTimesCcwMs)
      && this.isNumericArray(raw.smallTurnBrakeTimesCwMs)
      && this.isNumericArray(raw.largeTurnBrakeDistancesCcwDeg)
      && this.isNumericArray(raw.largeTurnBrakeDistancesCwDeg)
    ) {
      return {
        version: this.readNumber(raw.version, 3),
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
        largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
        largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
        largeTurnBrakeDistancesCcwDeg: this.normalizeNumericArray(
          raw.largeTurnBrakeDistancesCcwDeg,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG,
        ),
        largeTurnBrakeDistancesCwDeg: this.normalizeNumericArray(
          raw.largeTurnBrakeDistancesCwDeg,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG,
        ),
        largeTurnBiasOffsetsCcwDeg: this.normalizeNumericArray(
          raw.largeTurnBiasOffsetsCcwDeg,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG,
        ),
        largeTurnBiasOffsetsCwDeg: this.normalizeNumericArray(
          raw.largeTurnBiasOffsetsCwDeg,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG,
        ),
        largeTurnSampleCountsCcw: this.normalizeNumericArray(raw.largeTurnSampleCountsCcw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnSampleCountsCw: this.normalizeNumericArray(raw.largeTurnSampleCountsCw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCcwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCcwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        smallTurnBrakeTimesCcwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCcwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_MS_PER_DEG * SMALL_TURN_BUCKET_STEP_DEG,
        ),
        smallTurnBrakeTimesCwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_MS_PER_DEG * SMALL_TURN_BUCKET_STEP_DEG,
        ),
        smallTurnSampleCountsCcw: this.normalizeNumericArray(raw.smallTurnSampleCountsCcw, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnSampleCountsCw: this.normalizeNumericArray(raw.smallTurnSampleCountsCw, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnLastErrorCcwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCcwDeg, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnLastErrorCwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCwDeg, SMALL_TURN_BUCKET_COUNT, 0),
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
      };
    }

    if (
      typeof raw.smallTurnBrakeFractionCcw === "number"
      && typeof raw.smallTurnBrakeFractionCw === "number"
    ) {
      return this.createDefaultParameters({
        smallTurnBrakeTimeCcwMs: this.convertLegacyFractionToBrakeTimeMs(this.readNumber(raw.smallTurnBrakeFractionCcw, 0.5)),
        smallTurnBrakeTimeCwMs: this.convertLegacyFractionToBrakeTimeMs(this.readNumber(raw.smallTurnBrakeFractionCw, 0.5)),
      });
    }

    if (typeof raw.largeTurnBrakeCcwDeg === "number" && typeof raw.largeTurnBrakeCwDeg === "number") {
      const legacy = raw as LegacyTurnLearningParametersV2;
      return {
        version: 3,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
        largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
        largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
        largeTurnBrakeDistancesCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG),
        largeTurnBrakeDistancesCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG),
        largeTurnBiasOffsetsCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG),
        largeTurnBiasOffsetsCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG),
        largeTurnSampleCountsCcw: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnSampleCountsCw: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
        smallTurnBrakeTimesCcwMs: this.isNumericArray(raw.smallTurnBrakeFractionsCcw)
          ? this.convertLegacyFractionArrayToBrakeTimes(raw.smallTurnBrakeFractionsCcw)
          : this.createNumericArray(
            SMALL_TURN_BUCKET_COUNT,
            this.convertLegacyFractionToBrakeTimeMs(this.readNumber(legacy.smallTurnBrakeFractionCcw, 0.5)),
          ),
        smallTurnBrakeTimesCwMs: this.isNumericArray(raw.smallTurnBrakeFractionsCw)
          ? this.convertLegacyFractionArrayToBrakeTimes(raw.smallTurnBrakeFractionsCw)
          : this.createNumericArray(
            SMALL_TURN_BUCKET_COUNT,
            this.convertLegacyFractionToBrakeTimeMs(this.readNumber(legacy.smallTurnBrakeFractionCw, 0.5)),
          ),
        smallTurnSampleCountsCcw: this.normalizeNumericArray(raw.smallTurnSampleCountsCcw, SMALL_TURN_BUCKET_COUNT, this.readNumber(legacy.smallTurnSampleCountCcw, 0)),
        smallTurnSampleCountsCw: this.normalizeNumericArray(raw.smallTurnSampleCountsCw, SMALL_TURN_BUCKET_COUNT, this.readNumber(legacy.smallTurnSampleCountCw, 0)),
        smallTurnLastErrorCcwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCcwDeg, SMALL_TURN_BUCKET_COUNT, this.readNumber(legacy.lastSmallErrorCcwDeg, 0)),
        smallTurnLastErrorCwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCwDeg, SMALL_TURN_BUCKET_COUNT, this.readNumber(legacy.lastSmallErrorCwDeg, 0)),
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
      };
    }

    return this.createDefaultParameters();
  }

  private createDefaultParameters(
    overrides: Partial<{
      smallTurnBrakeTimeCcwMs: number;
      smallTurnBrakeTimeCwMs: number;
      smallTurnSampleCountCcw: number;
      smallTurnSampleCountCw: number;
      lastSmallErrorCcwDeg: number;
      lastSmallErrorCwDeg: number;
      lastUpdated: string | undefined;
    }> = {},
  ): TurnLearningParameters {
    const smallTurnBrakeTimesCcwMs = Array.from(
      { length: SMALL_TURN_BUCKET_COUNT },
      (_, index) => overrides.smallTurnBrakeTimeCcwMs
        ?? this.getDefaultSmallTurnBrakeTimeMs((index + 1) * SMALL_TURN_BUCKET_STEP_DEG),
    );
    const smallTurnBrakeTimesCwMs = Array.from(
      { length: SMALL_TURN_BUCKET_COUNT },
      (_, index) => overrides.smallTurnBrakeTimeCwMs
        ?? this.getDefaultSmallTurnBrakeTimeMs((index + 1) * SMALL_TURN_BUCKET_STEP_DEG),
    );
    const smallTurnSampleCountsCcw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnSampleCountCcw ?? 0);
    const smallTurnSampleCountsCw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnSampleCountCw ?? 0);
    const smallTurnLastErrorCcwDeg = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.lastSmallErrorCcwDeg ?? 0);
    const smallTurnLastErrorCwDeg = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.lastSmallErrorCwDeg ?? 0);

    return {
      version: 3,
      smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
      smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
      smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
      largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
      largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
      largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
      largeTurnBrakeDistancesCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG),
      largeTurnBrakeDistancesCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_DISTANCE_DEG),
      largeTurnBiasOffsetsCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG),
      largeTurnBiasOffsetsCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BIAS_OFFSET_DEG),
      largeTurnSampleCountsCcw: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
      largeTurnSampleCountsCw: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
      largeTurnLastErrorsCcwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
      largeTurnLastErrorsCwDeg: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, 0),
      smallTurnBrakeTimesCcwMs,
      smallTurnBrakeTimesCwMs,
      smallTurnSampleCountsCcw,
      smallTurnSampleCountsCw,
      smallTurnLastErrorCcwDeg,
      smallTurnLastErrorCwDeg,
      lastUpdated: overrides.lastUpdated ?? new Date().toISOString(),
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

  private normalizeNumericArray(value: unknown, expectedLength: number, fallback: number): number[] {
    if (!Array.isArray(value)) {
      return this.createNumericArray(expectedLength, fallback);
    }

    const items = value.slice(0, expectedLength).map((item) => this.readNumber(item, fallback));
    while (items.length < expectedLength) {
      items.push(fallback);
    }
    return items;
  }

  private isNumericArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
  }

  private getSmallTurnBucketAngle(requestedAngleDeg: number): number {
    const clamped = Math.max(SMALL_TURN_BUCKET_STEP_DEG, Math.min(SMALL_TURN_BUCKET_MAX_DEG, Math.abs(requestedAngleDeg)));
    const bucket = Math.round(clamped / SMALL_TURN_BUCKET_STEP_DEG) * SMALL_TURN_BUCKET_STEP_DEG;
    return Math.max(SMALL_TURN_BUCKET_STEP_DEG, Math.min(SMALL_TURN_BUCKET_MAX_DEG, bucket));
  }

  private getSmallTurnBucketIndex(requestedAngleDeg: number): number {
    return (this.getSmallTurnBucketAngle(requestedAngleDeg) / SMALL_TURN_BUCKET_STEP_DEG) - 1;
  }

  private isNearSmallTurnBucket(requestedAngleDeg: number, bucketAngleDeg: number): boolean {
    return Math.abs(Math.abs(requestedAngleDeg) - bucketAngleDeg) <= SMALL_TURN_BUCKET_TRAINING_TOLERANCE_DEG;
  }

  private getSmallTurnBrakeTimeBucketValue(direction: TurnDirection, bucketAngleDeg: number): number {
    const bucketIndex = this.getSmallTurnBucketIndex(bucketAngleDeg);
    return direction === "ccw"
      ? this.parameters.smallTurnBrakeTimesCcwMs[bucketIndex]
      : this.parameters.smallTurnBrakeTimesCwMs[bucketIndex];
  }

  private getLargeTurnBucketAngle(requestedAngleDeg: number): number {
    const clamped = Math.max(LARGE_TURN_MIN_ANGLE_DEG, Math.min(LARGE_TURN_MAX_ANGLE_DEG, Math.abs(requestedAngleDeg)));
    const bucket = Math.round(clamped / LARGE_TURN_BUCKET_STEP_DEG) * LARGE_TURN_BUCKET_STEP_DEG;
    return Math.max(LARGE_TURN_MIN_ANGLE_DEG, Math.min(LARGE_TURN_MAX_ANGLE_DEG, bucket));
  }

  private getLargeTurnBucketIndex(requestedAngleDeg: number): number {
    return ((this.getLargeTurnBucketAngle(requestedAngleDeg) - LARGE_TURN_MIN_ANGLE_DEG) / LARGE_TURN_BUCKET_STEP_DEG);
  }

  private getLargeTurnBrakeDistance(direction: TurnDirection, requestedAngleDeg: number): number {
    const bucketIndex = this.getLargeTurnBucketIndex(requestedAngleDeg);
    return direction === "ccw"
      ? this.parameters.largeTurnBrakeDistancesCcwDeg[bucketIndex]
      : this.parameters.largeTurnBrakeDistancesCwDeg[bucketIndex];
  }

  private getLegacyLargeDirectionDefault(direction: TurnDirection): number {
    const bucketIndex = this.getLargeTurnBucketIndex(LARGE_TURN_MIN_ANGLE_DEG);
    return direction === "ccw"
      ? this.parameters.largeTurnBrakeDistancesCcwDeg[bucketIndex]
      : this.parameters.largeTurnBrakeDistancesCwDeg[bucketIndex];
  }

  private getSmallTurnBuckets(): TurnLearningBucket[] {
    const buckets: TurnLearningBucket[] = [];
    for (let index = 0; index < SMALL_TURN_BUCKET_COUNT; index += 1) {
      buckets.push({
        bucketAngleDeg: (index + 1) * SMALL_TURN_BUCKET_STEP_DEG,
        brakeTimeCcwMs: this.parameters.smallTurnBrakeTimesCcwMs[index],
        brakeTimeCwMs: this.parameters.smallTurnBrakeTimesCwMs[index],
        sampleCountCcw: this.parameters.smallTurnSampleCountsCcw[index],
        sampleCountCw: this.parameters.smallTurnSampleCountsCw[index],
        lastErrorCcwDeg: this.parameters.smallTurnLastErrorCcwDeg[index],
        lastErrorCwDeg: this.parameters.smallTurnLastErrorCwDeg[index],
      });
    }
    return buckets;
  }

  private getDefaultSmallTurnBrakeTimeMs(bucketAngleDeg: number): number {
    return Math.max(
      SMALL_TURN_MIN_BRAKE_TIME_MS,
      Math.min(SMALL_TURN_MAX_BRAKE_TIME_MS, bucketAngleDeg * SMALL_TURN_DEFAULT_BRAKE_MS_PER_DEG),
    );
  }

  private convertLegacyFractionToBrakeTimeMs(fraction: number): number {
    const clampedFraction = Math.max(0.05, Math.min(0.95, fraction));
    const representativeAngleDeg = 12;
    return Math.round(this.getDefaultSmallTurnBrakeTimeMs(representativeAngleDeg) * clampedFraction / 0.5);
  }

  private convertLegacyFractionArrayToBrakeTimes(value: unknown): number[] {
    const fractions = this.normalizeNumericArray(value, SMALL_TURN_BUCKET_COUNT, 0.5);
    return fractions.map((fraction, index) => {
      const bucketAngleDeg = (index + 1) * SMALL_TURN_BUCKET_STEP_DEG;
      const clampedFraction = Math.max(0.05, Math.min(0.95, fraction));
      return Math.round(this.getDefaultSmallTurnBrakeTimeMs(bucketAngleDeg) * clampedFraction / 0.5);
    });
  }
}
