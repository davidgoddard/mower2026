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
} from "./turnControllerTypes.js";
import {
  TURN_SMALL_ANGLE_THRESHOLD_DEG,
  TURN_LEARNING_RATE,
  TURN_LEARNING_PARAMETERS_PATH,
} from "../constants.js";

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
   * Small turns use a fixed crawl-and-halt strategy and do not learn.
   */
  async updateFromTurn(result: TurnLearningInput): Promise<void> {
    const requestedAbs = Math.abs(unwrapRelativeAngle(result.requestedAngle));
    const achievedAbs = Math.abs(unwrapRelativeAngle(result.achievedAngle));

    if (requestedAbs < this.parameters.smallAngleThresholdDeg) {
      this.logger.info("turn.learning.skipped_small", {
        direction: result.direction,
        requestedAngleDeg: requestedAbs,
        achievedAngleDeg: achievedAbs,
        mode: "crawl_and_halt",
        storedFraction: result.direction === "ccw"
          ? this.parameters.smallTurnBrakeFractionCcw
          : this.parameters.smallTurnBrakeFractionCw,
      });
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

  getSmallTurnBrakeFraction(direction: TurnDirection): number {
    return direction === "ccw"
      ? this.parameters.smallTurnBrakeFractionCcw
      : this.parameters.smallTurnBrakeFractionCw;
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

    if (typeof raw.smallTurnBrakeFractionCcw === "number" && typeof raw.smallTurnBrakeFractionCw === "number") {
      return {
        version: 1,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        largeTurnBrakeCcwDeg: this.readNumber(raw.largeTurnBrakeCcwDeg, 15),
        largeTurnBrakeCwDeg: this.readNumber(raw.largeTurnBrakeCwDeg, 15),
        smallTurnBrakeFractionCcw: this.readNumber(raw.smallTurnBrakeFractionCcw, 0.5),
        smallTurnBrakeFractionCw: this.readNumber(raw.smallTurnBrakeFractionCw, 0.5),
        largeTurnSampleCountCcw: this.readNumber(raw.largeTurnSampleCountCcw, 0),
        largeTurnSampleCountCw: this.readNumber(raw.largeTurnSampleCountCw, 0),
        smallTurnSampleCountCcw: this.readNumber(raw.smallTurnSampleCountCcw, 0),
        smallTurnSampleCountCw: this.readNumber(raw.smallTurnSampleCountCw, 0),
        lastLargeErrorCcwDeg: this.readNumber(raw.lastLargeErrorCcwDeg, 0),
        lastLargeErrorCwDeg: this.readNumber(raw.lastLargeErrorCwDeg, 0),
        lastSmallErrorCcwDeg: this.readNumber(raw.lastSmallErrorCcwDeg, 0),
        lastSmallErrorCwDeg: this.readNumber(raw.lastSmallErrorCwDeg, 0),
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date().toISOString(),
      };
    }

    if (typeof raw.largeTurnBrakeCcwDeg === "number" && typeof raw.largeTurnBrakeCwDeg === "number") {
      const legacy = raw as LegacyTurnLearningParametersV2;
      return {
        version: 1,
        smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
        largeTurnBrakeCcwDeg: this.readNumber(legacy.largeTurnBrakeCcwDeg, 15),
        largeTurnBrakeCwDeg: this.readNumber(legacy.largeTurnBrakeCwDeg, 15),
        smallTurnBrakeFractionCcw: 0.5,
        smallTurnBrakeFractionCw: 0.5,
        largeTurnSampleCountCcw: this.readNumber(legacy.largeTurnSampleCountCcw, 0),
        largeTurnSampleCountCw: this.readNumber(legacy.largeTurnSampleCountCw, 0),
        smallTurnSampleCountCcw: 0,
        smallTurnSampleCountCw: 0,
        lastLargeErrorCcwDeg: this.readNumber(legacy.lastErrorCcwDeg, 0),
        lastLargeErrorCwDeg: this.readNumber(legacy.lastErrorCwDeg, 0),
        lastSmallErrorCcwDeg: 0,
        lastSmallErrorCwDeg: 0,
        lastUpdated: typeof legacy.lastUpdated === "string" ? legacy.lastUpdated : new Date().toISOString(),
      };
    }

    return this.createDefaultParameters();
  }

  private createDefaultParameters(): TurnLearningParameters {
    return {
      version: 1,
      smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
      largeTurnBrakeCcwDeg: 15,
      largeTurnBrakeCwDeg: 15,
      smallTurnBrakeFractionCcw: 0.5,
      smallTurnBrakeFractionCw: 0.5,
      largeTurnSampleCountCcw: 0,
      largeTurnSampleCountCw: 0,
      smallTurnSampleCountCcw: 0,
      smallTurnSampleCountCw: 0,
      lastLargeErrorCcwDeg: 0,
      lastLargeErrorCwDeg: 0,
      lastSmallErrorCcwDeg: 0,
      lastSmallErrorCwDeg: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
}
