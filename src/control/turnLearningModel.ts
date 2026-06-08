/**
 * Turn learning model with parameter persistence
 */

import { mkdir } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
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
const SMALL_TURN_FRACTION_MIN = 0.05;
const SMALL_TURN_FRACTION_MAX = 0.95;

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
      });
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
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

  /**
   * Update learning based on a completed turn.
   *
   * Large turns learn the remaining brake distance.
   * Small turns learn the brake fraction used to decide when to halt.
   *
   * NOTE on the sign convention: small-turn and large-turn updates use
   * opposite error-sign conventions on purpose. For small turns the
   * adjusted parameter is a brake-fraction (0..1) where smaller fractions
   * mean "brake earlier", so an overshoot (achieved > requested) reduces
   * the fraction via a positive `requestedAbs - achievedAbs` error driving
   * `currentFraction + adjustment` down. For large turns the adjusted
   * parameter is a brake-distance in degrees where bigger distances mean
   * "brake earlier", so an overshoot (achieved > requested) increases the
   * distance via a positive `achievedAbs - requestedAbs` error. Each
   * branch is internally self-consistent: do not unify the signs.
   */
  async updateFromTurn(result: TurnLearningInput): Promise<void> {
    const requestedAbs = Math.abs(unwrapRelativeAngle(result.requestedAngle));
    const achievedAbs = Math.abs(unwrapRelativeAngle(result.achievedAngle));

    if (requestedAbs <= this.parameters.smallAngleThresholdDeg) {
      const bucketAngleDeg = this.getSmallTurnBucketAngle(requestedAbs);
      const bucketIndex = this.getSmallTurnBucketIndex(requestedAbs);
      const currentFraction = this.getSmallTurnBrakeFraction(result.direction, requestedAbs);
      const normalizedError = (requestedAbs - achievedAbs) / Math.max(1, requestedAbs);
      const adjustment = normalizedError * this.learningRate;
      const clampedFraction = Math.max(SMALL_TURN_FRACTION_MIN, Math.min(SMALL_TURN_FRACTION_MAX, currentFraction + adjustment));

      if (result.direction === "ccw") {
        this.parameters.smallTurnBrakeFractionsCcw[bucketIndex] = clampedFraction;
        this.parameters.smallTurnSampleCountsCcw[bucketIndex] += 1;
        this.parameters.smallTurnLastErrorCcwDeg[bucketIndex] = achievedAbs - requestedAbs;
      } else {
        this.parameters.smallTurnBrakeFractionsCw[bucketIndex] = clampedFraction;
        this.parameters.smallTurnSampleCountsCw[bucketIndex] += 1;
        this.parameters.smallTurnLastErrorCwDeg[bucketIndex] = achievedAbs - requestedAbs;
      }

      this.parameters.lastUpdated = new Date().toISOString();
      this.logger.info("turn.learning.updated_small", {
        direction: result.direction,
        bucketAngleDeg,
        requestedAngleDeg: requestedAbs,
        achievedAngleDeg: achievedAbs,
        mode: "bucketed_crawl_and_halt",
        currentFraction,
        normalizedError,
        adjustment,
        newFraction: clampedFraction,
      });
      await this.saveParameters();
      return;
    }

    const currentBrakeDistance = result.direction === "ccw"
      ? this.parameters.largeTurnBrakeCcwDeg
      : this.parameters.largeTurnBrakeCwDeg;

    const errorDeg = achievedAbs - requestedAbs;
    const adjustment = errorDeg * this.learningRate;
    const clampedBrakeDistance = Math.max(5, Math.min(90, currentBrakeDistance + adjustment));

    if (result.direction === "ccw") {
      this.parameters.largeTurnBrakeCcwDeg = clampedBrakeDistance;
      this.parameters.largeTurnSampleCountCcw += 1;
      this.parameters.lastLargeErrorCcwDeg = errorDeg;
    } else {
      this.parameters.largeTurnBrakeCwDeg = clampedBrakeDistance;
      this.parameters.largeTurnSampleCountCw += 1;
      this.parameters.lastLargeErrorCwDeg = errorDeg;
    }

    this.parameters.lastUpdated = new Date().toISOString();
    this.logger.info("turn.learning.updated_large", {
      direction: result.direction,
      requestedAngleDeg: requestedAbs,
      achievedAngleDeg: achievedAbs,
      errorDeg,
      adjustment,
      newBrakeDistanceDeg: clampedBrakeDistance,
    });
    await this.saveParameters();
  }

  getBrakeDistance(direction: TurnDirection): RelativeAngle {
    const brakeDistanceDeg = direction === "ccw"
      ? this.parameters.largeTurnBrakeCcwDeg
      : this.parameters.largeTurnBrakeCwDeg;
    return createRelativeAngle(brakeDistanceDeg);
  }

  getBrakeAngle(requestedAngleDeg: number, direction: TurnDirection): RelativeAngle {
    const requested = Math.abs(requestedAngleDeg);
    const brakeDistance = unwrapRelativeAngle(this.getBrakeDistance(direction));
    return createRelativeAngle(Math.max(1, Math.min(requested, brakeDistance)));
  }

  getSmallTurnBrakeFraction(direction: TurnDirection, requestedAngleDeg: number): number {
    const bucketIndex = this.getSmallTurnBucketIndex(requestedAngleDeg);
    return direction === "ccw"
      ? this.parameters.smallTurnBrakeFractionsCcw[bucketIndex]
      : this.parameters.smallTurnBrakeFractionsCw[bucketIndex];
  }

  getSmallAngleThreshold(): number {
    return this.parameters.smallAngleThresholdDeg;
  }

  getParameters(): TurnLearningParameters {
    const parameters: TurnLearningBin[] = [];
    for (let requestedAngleDeg = 10; requestedAngleDeg <= 180; requestedAngleDeg += 10) {
      parameters.push({
        requestedAngleDeg,
        brakeDistanceDeg: unwrapRelativeAngle(this.getBrakeDistance("ccw")),
        direction: "ccw",
      });
    }

    return {
      ...this.parameters,
      parameters,
      smallTurnBuckets: this.getSmallTurnBuckets(),
    };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("turn.learning.reset", {
      smallAngleThresholdDeg: this.parameters.smallAngleThresholdDeg,
    });
  }

  private normalizeParameters(raw: unknown): TurnLearningParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    if (this.isNumericArray(raw.smallTurnBrakeFractionsCcw) && this.isNumericArray(raw.smallTurnBrakeFractionsCw)) {
      return {
        version: 1,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
        smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
        largeTurnBrakeCcwDeg: this.readNumber(raw.largeTurnBrakeCcwDeg, 15),
        largeTurnBrakeCwDeg: this.readNumber(raw.largeTurnBrakeCwDeg, 15),
        largeTurnSampleCountCcw: this.readNumber(raw.largeTurnSampleCountCcw, 0),
        largeTurnSampleCountCw: this.readNumber(raw.largeTurnSampleCountCw, 0),
        lastLargeErrorCcwDeg: this.readNumber(raw.lastLargeErrorCcwDeg, 0),
        lastLargeErrorCwDeg: this.readNumber(raw.lastLargeErrorCwDeg, 0),
        smallTurnBrakeFractionsCcw: this.normalizeNumericArray(raw.smallTurnBrakeFractionsCcw, 0.5),
        smallTurnBrakeFractionsCw: this.normalizeNumericArray(raw.smallTurnBrakeFractionsCw, 0.5),
        smallTurnSampleCountsCcw: this.normalizeNumericArray(raw.smallTurnSampleCountsCcw, 0),
        smallTurnSampleCountsCw: this.normalizeNumericArray(raw.smallTurnSampleCountsCw, 0),
        smallTurnLastErrorCcwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCcwDeg, 0),
        smallTurnLastErrorCwDeg: this.normalizeNumericArray(raw.smallTurnLastErrorCwDeg, 0),
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
      };
    }

    if (
      typeof raw.smallTurnBrakeFractionCcw === "number"
      && typeof raw.smallTurnBrakeFractionCw === "number"
    ) {
      return this.createDefaultParameters({
        smallTurnBrakeFractionCcw: this.readNumber(raw.smallTurnBrakeFractionCcw, 0.5),
        smallTurnBrakeFractionCw: this.readNumber(raw.smallTurnBrakeFractionCw, 0.5),
      });
    }

    if (typeof raw.largeTurnBrakeCcwDeg === "number" && typeof raw.largeTurnBrakeCwDeg === "number") {
      const legacy = raw as LegacyTurnLearningParametersV2;
      return this.createDefaultParameters({
        largeTurnBrakeCcwDeg: this.readNumber(legacy.largeTurnBrakeCcwDeg, 15),
        largeTurnBrakeCwDeg: this.readNumber(legacy.largeTurnBrakeCwDeg, 15),
        largeTurnSampleCountCcw: this.readNumber(legacy.largeTurnSampleCountCcw, 0),
        largeTurnSampleCountCw: this.readNumber(legacy.largeTurnSampleCountCw, 0),
        lastLargeErrorCcwDeg: this.readNumber(legacy.lastErrorCcwDeg, 0),
        lastLargeErrorCwDeg: this.readNumber(legacy.lastErrorCwDeg, 0),
        smallTurnBrakeFractionCcw: this.readNumber(legacy.smallTurnBrakeFractionCcw, 0.5),
        smallTurnBrakeFractionCw: this.readNumber(legacy.smallTurnBrakeFractionCw, 0.5),
      });
    }

    return this.createDefaultParameters();
  }

  private createDefaultParameters(
    overrides: Partial<{
      largeTurnBrakeCcwDeg: number;
      largeTurnBrakeCwDeg: number;
      largeTurnSampleCountCcw: number;
      largeTurnSampleCountCw: number;
      lastLargeErrorCcwDeg: number;
      lastLargeErrorCwDeg: number;
      smallTurnBrakeFractionCcw: number;
      smallTurnBrakeFractionCw: number;
      smallTurnSampleCountCcw: number;
      smallTurnSampleCountCw: number;
      lastSmallErrorCcwDeg: number;
      lastSmallErrorCwDeg: number;
      lastUpdated: string | undefined;
    }> = {},
  ): TurnLearningParameters {
    const smallTurnBrakeFractionsCcw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnBrakeFractionCcw ?? 0.5);
    const smallTurnBrakeFractionsCw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnBrakeFractionCw ?? 0.5);
    const smallTurnSampleCountsCcw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnSampleCountCcw ?? 0);
    const smallTurnSampleCountsCw = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.smallTurnSampleCountCw ?? 0);
    const smallTurnLastErrorCcwDeg = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.lastSmallErrorCcwDeg ?? 0);
    const smallTurnLastErrorCwDeg = this.createNumericArray(SMALL_TURN_BUCKET_COUNT, overrides.lastSmallErrorCwDeg ?? 0);

    return {
      version: 1,
      smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
      smallTurnBucketStepDeg: SMALL_TURN_BUCKET_STEP_DEG,
      smallTurnMaxAngleDeg: SMALL_TURN_BUCKET_MAX_DEG,
      largeTurnBrakeCcwDeg: overrides.largeTurnBrakeCcwDeg ?? 15,
      largeTurnBrakeCwDeg: overrides.largeTurnBrakeCwDeg ?? 15,
      largeTurnSampleCountCcw: overrides.largeTurnSampleCountCcw ?? 0,
      largeTurnSampleCountCw: overrides.largeTurnSampleCountCw ?? 0,
      lastLargeErrorCcwDeg: overrides.lastLargeErrorCcwDeg ?? 0,
      lastLargeErrorCwDeg: overrides.lastLargeErrorCwDeg ?? 0,
      smallTurnBrakeFractionsCcw,
      smallTurnBrakeFractionsCw,
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

  private normalizeNumericArray(value: unknown, fallback: number): number[] {
    if (!Array.isArray(value)) {
      return this.createNumericArray(SMALL_TURN_BUCKET_COUNT, fallback);
    }

    const items = value.slice(0, SMALL_TURN_BUCKET_COUNT).map((item) => this.readNumber(item, fallback));
    while (items.length < SMALL_TURN_BUCKET_COUNT) {
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

  private getSmallTurnBuckets(): TurnLearningBucket[] {
    const buckets: TurnLearningBucket[] = [];
    for (let index = 0; index < SMALL_TURN_BUCKET_COUNT; index += 1) {
      buckets.push({
        bucketAngleDeg: (index + 1) * SMALL_TURN_BUCKET_STEP_DEG,
        brakeFractionCcw: this.parameters.smallTurnBrakeFractionsCcw[index],
        brakeFractionCw: this.parameters.smallTurnBrakeFractionsCw[index],
        sampleCountCcw: this.parameters.smallTurnSampleCountsCcw[index],
        sampleCountCw: this.parameters.smallTurnSampleCountsCw[index],
        lastErrorCcwDeg: this.parameters.smallTurnLastErrorCcwDeg[index],
        lastErrorCwDeg: this.parameters.smallTurnLastErrorCwDeg[index],
      });
    }
    return buckets;
  }
}
