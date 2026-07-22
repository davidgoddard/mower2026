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
const SMALL_TURN_MIN_BRAKE_TIME_MS = 60;
const SMALL_TURN_MAX_BRAKE_TIME_MS = 2400;
// Seeded from the July 2026 small-turn tuning runs through 30 degrees. The 6 degree
// CCW samples were excluded because their near-zero reverse movement was reported
// as almost 360 degrees. Values above 30 degrees conservatively extrapolate the
// observed upper-range slope until those buckets have dedicated training data.
const SMALL_TURN_DEFAULT_BRAKE_TIMES_MS = [
  230, 320, 410, 470, 505, 550, 610, 675, 715, 785,
  840, 895, 950, 1005, 1060, 1115, 1170, 1225, 1280, 1335,
];

const LARGE_TURN_BUCKET_STEP_DEG = 10;
const LARGE_TURN_BUCKET_TRAINING_TOLERANCE_DEG = 0.1;
const LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS = 90;
const LARGE_TURN_MIN_BRAKE_SCALAR_MS = 20;
const LARGE_TURN_MAX_BRAKE_SCALAR_MS = 220;
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
  largeTurnBrakeTimesCcwMs?: unknown;
  largeTurnBrakeTimesCwMs?: unknown;
  largeTurnBrakeScalarsCcwMs?: unknown;
  largeTurnBrakeScalarsCwMs?: unknown;
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

    if (requestedAbs <= this.parameters.smallAngleThresholdDeg) {
      // A small turn cannot legitimately wrap through 360 degrees. Use the
      // normalized result so a tiny movement in the opposite direction cannot
      // be learned as a near-complete revolution.
      const achievedAbs = Math.abs(unwrapRelativeAngle(result.achievedAngle));
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

    const achievedAbs = result.achievedAngleUnwrappedDeg !== undefined
      ? Math.abs(result.achievedAngleUnwrappedDeg)
      : Math.abs(unwrapRelativeAngle(result.achievedAngle));

    const bucketAngleDeg = this.getLargeTurnBucketAngle(requestedAbs);
    if (!this.isNearLargeTurnBucket(requestedAbs, bucketAngleDeg)) {
      this.logger.info("turn.learning.skipped_large_non_bucket", {
        direction: result.direction,
        requestedAngleDeg: requestedAbs,
        nearestBucketAngleDeg: bucketAngleDeg,
        toleranceDeg: LARGE_TURN_BUCKET_TRAINING_TOLERANCE_DEG,
        achievedAngleDeg: achievedAbs,
      });
      return;
    }
    const bucketIndex = this.getLargeTurnBucketIndex(requestedAbs);
    const currentBrakeScalarMs = this.getLargeTurnBrakeScalarBucketValue(
      result.direction,
      bucketAngleDeg,
    );
    const errorDeg = achievedAbs - requestedAbs;
    const effectiveRateDegPerMs = Math.max(0.001, result.brakeRateUsedDegPerMs ?? 0.001);
    const scalarAdjustmentMs = (errorDeg / effectiveRateDegPerMs) * this.learningRate;
    const clampedBrakeScalarMs = Math.max(
      LARGE_TURN_MIN_BRAKE_SCALAR_MS,
      Math.min(LARGE_TURN_MAX_BRAKE_SCALAR_MS, currentBrakeScalarMs + scalarAdjustmentMs),
    );

    if (result.direction === "ccw") {
      this.parameters.largeTurnBrakeScalarsCcwMs[bucketIndex] = clampedBrakeScalarMs;
      this.parameters.largeTurnSampleCountsCcw[bucketIndex] += 1;
      this.parameters.largeTurnLastErrorsCcwDeg[bucketIndex] = errorDeg;
    } else {
      this.parameters.largeTurnBrakeScalarsCwMs[bucketIndex] = clampedBrakeScalarMs;
      this.parameters.largeTurnSampleCountsCw[bucketIndex] += 1;
      this.parameters.largeTurnLastErrorsCwDeg[bucketIndex] = errorDeg;
    }

    this.parameters.lastUpdated = new Date().toISOString();
    this.logger.info("turn.learning.updated_large", {
      direction: result.direction,
      bucketAngleDeg,
      requestedAngleDeg: requestedAbs,
      achievedAngleDeg: achievedAbs,
      mode: "bucketed_rate_scalar",
      currentBrakeScalarMs,
      brakeRateUsedDegPerMs: result.brakeRateUsedDegPerMs,
      errorDeg,
      scalarAdjustmentMs,
      newBrakeScalarMs: clampedBrakeScalarMs,
    });
    await this.saveParameters();
  }

  getBrakeDistance(direction: TurnDirection, requestedAngleDeg: number): RelativeAngle {
    void direction;
    void requestedAngleDeg;
    return createRelativeAngle(0);
  }

  getBrakeAngle(requestedAngleDeg: number, direction: TurnDirection): RelativeAngle {
    void requestedAngleDeg;
    void direction;
    return createRelativeAngle(0);
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

  getLargeTurnBrakeScalarMs(direction: TurnDirection, requestedAngleDeg: number): number {
    const requested = Math.abs(requestedAngleDeg);
    const clamped = Math.max(
      LARGE_TURN_MIN_ANGLE_DEG,
      Math.min(LARGE_TURN_MAX_ANGLE_DEG, requested),
    );
    const lowerBucketAngleDeg = Math.floor(clamped / LARGE_TURN_BUCKET_STEP_DEG) * LARGE_TURN_BUCKET_STEP_DEG;
    const upperBucketAngleDeg = Math.ceil(clamped / LARGE_TURN_BUCKET_STEP_DEG) * LARGE_TURN_BUCKET_STEP_DEG;
    const boundedLowerBucketAngleDeg = Math.max(LARGE_TURN_MIN_ANGLE_DEG, lowerBucketAngleDeg);
    const boundedUpperBucketAngleDeg = Math.min(LARGE_TURN_MAX_ANGLE_DEG, upperBucketAngleDeg);

    const lowerBrakeScalarMs = this.getLargeTurnBrakeScalarBucketValue(direction, boundedLowerBucketAngleDeg);
    if (boundedLowerBucketAngleDeg === boundedUpperBucketAngleDeg) {
      return lowerBrakeScalarMs;
    }

    const upperBrakeScalarMs = this.getLargeTurnBrakeScalarBucketValue(direction, boundedUpperBucketAngleDeg);
    const interpolationFraction =
      (clamped - boundedLowerBucketAngleDeg) / (boundedUpperBucketAngleDeg - boundedLowerBucketAngleDeg);
    return lowerBrakeScalarMs + ((upperBrakeScalarMs - lowerBrakeScalarMs) * interpolationFraction);
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
        brakeScalarMs: this.parameters.largeTurnBrakeScalarsCcwMs[index],
        direction: "ccw",
        sampleCount: this.parameters.largeTurnSampleCountsCcw[index],
        lastErrorDeg: this.parameters.largeTurnLastErrorsCcwDeg[index],
      });
      parameters.push({
        requestedAngleDeg,
        brakeScalarMs: this.parameters.largeTurnBrakeScalarsCwMs[index],
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
    largeTurnBrakeScalarMinMs: number;
    largeTurnBrakeScalarMaxMs: number;
  } {
    return {
      learningRate: this.learningRate,
      smallTurnBrakeTimeMinMs: SMALL_TURN_MIN_BRAKE_TIME_MS,
      smallTurnBrakeTimeMaxMs: SMALL_TURN_MAX_BRAKE_TIME_MS,
      largeTurnBrakeScalarMinMs: LARGE_TURN_MIN_BRAKE_SCALAR_MS,
      largeTurnBrakeScalarMaxMs: LARGE_TURN_MAX_BRAKE_SCALAR_MS,
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
      && this.isNumericArray(raw.largeTurnBrakeScalarsCcwMs)
      && this.isNumericArray(raw.largeTurnBrakeScalarsCwMs)
    ) {
      return {
        version: this.readNumber(raw.version, 5),
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
        largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
        largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
        largeTurnBrakeScalarsCcwMs: this.normalizeNumericArray(
          raw.largeTurnBrakeScalarsCcwMs,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS,
        ),
        largeTurnBrakeScalarsCwMs: this.normalizeNumericArray(
          raw.largeTurnBrakeScalarsCwMs,
          LARGE_TURN_BUCKET_COUNT,
          LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS,
        ),
        largeTurnSampleCountsCcw: this.normalizeNumericArray(raw.largeTurnSampleCountsCcw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnSampleCountsCw: this.normalizeNumericArray(raw.largeTurnSampleCountsCw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCcwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCcwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        smallTurnBrakeTimesCcwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCcwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_TIMES_MS[0],
        ),
        smallTurnBrakeTimesCwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_TIMES_MS[0],
        ),
        smallTurnSampleCountsCcw: this.normalizeNumericArray(raw.smallTurnSampleCountsCcw, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnSampleCountsCw: this.normalizeNumericArray(raw.smallTurnSampleCountsCw, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnLastErrorCcwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCcwDeg, SMALL_TURN_BUCKET_COUNT, 0),
        smallTurnLastErrorCwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCwDeg, SMALL_TURN_BUCKET_COUNT, 0),
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
      };
    }

    if (
      this.isNumericArray(raw.smallTurnBrakeTimesCcwMs)
      && this.isNumericArray(raw.smallTurnBrakeTimesCwMs)
      && this.isNumericArray(raw.largeTurnBrakeTimesCcwMs)
      && this.isNumericArray(raw.largeTurnBrakeTimesCwMs)
    ) {
      return {
        version: 5,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
        largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
        largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
        largeTurnBrakeScalarsCcwMs: this.convertLegacyLargeBrakeTimesToScalars(raw.largeTurnBrakeTimesCcwMs),
        largeTurnBrakeScalarsCwMs: this.convertLegacyLargeBrakeTimesToScalars(raw.largeTurnBrakeTimesCwMs),
        largeTurnSampleCountsCcw: this.normalizeNumericArray(raw.largeTurnSampleCountsCcw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnSampleCountsCw: this.normalizeNumericArray(raw.largeTurnSampleCountsCw, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCcwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCcwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        largeTurnLastErrorsCwDeg: this.normalizeNumericArray(raw.largeTurnLastErrorsCwDeg, LARGE_TURN_BUCKET_COUNT, 0),
        smallTurnBrakeTimesCcwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCcwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_TIMES_MS[0],
        ),
        smallTurnBrakeTimesCwMs: this.normalizeNumericArray(
          raw.smallTurnBrakeTimesCwMs,
          SMALL_TURN_BUCKET_COUNT,
          SMALL_TURN_DEFAULT_BRAKE_TIMES_MS[0],
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
        version: 5,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
        largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
        largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
        largeTurnBrakeScalarsCcwMs: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS),
        largeTurnBrakeScalarsCwMs: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS),
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
      version: 5,
      smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
      smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
      smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
      largeTurnBucketStepDeg: LARGE_TURN_BUCKET_STEP_DEG,
      largeTurnMinAngleDeg: LARGE_TURN_MIN_ANGLE_DEG,
      largeTurnMaxAngleDeg: LARGE_TURN_MAX_ANGLE_DEG,
      largeTurnBrakeScalarsCcwMs: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS),
      largeTurnBrakeScalarsCwMs: this.createNumericArray(LARGE_TURN_BUCKET_COUNT, LARGE_TURN_DEFAULT_BRAKE_SCALAR_MS),
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

  private isNearLargeTurnBucket(requestedAngleDeg: number, bucketAngleDeg: number): boolean {
    return Math.abs(Math.abs(requestedAngleDeg) - bucketAngleDeg) <= LARGE_TURN_BUCKET_TRAINING_TOLERANCE_DEG;
  }

  private getLargeTurnBrakeScalarBucketValue(direction: TurnDirection, bucketAngleDeg: number): number {
    const bucketIndex = this.getLargeTurnBucketIndex(bucketAngleDeg);
    return direction === "ccw"
      ? this.parameters.largeTurnBrakeScalarsCcwMs[bucketIndex]
      : this.parameters.largeTurnBrakeScalarsCwMs[bucketIndex];
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
    const bucketIndex = this.getSmallTurnBucketIndex(bucketAngleDeg);
    return SMALL_TURN_DEFAULT_BRAKE_TIMES_MS[bucketIndex];
  }

  private convertLegacyLargeBrakeTimesToScalars(value: unknown): number[] {
    const times = this.normalizeNumericArray(value, LARGE_TURN_BUCKET_COUNT, 3000);
    return times.map((timeMs, index) => {
      const representativeAngleDeg = LARGE_TURN_MIN_ANGLE_DEG + (index * LARGE_TURN_BUCKET_STEP_DEG);
      const representativeRateDegPerMs = representativeAngleDeg <= 110 ? 0.03 : 0.04;
      const scalarMs = timeMs * representativeRateDegPerMs;
      return Math.max(
        LARGE_TURN_MIN_BRAKE_SCALAR_MS,
        Math.min(LARGE_TURN_MAX_BRAKE_SCALAR_MS, scalarMs),
      );
    });
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
