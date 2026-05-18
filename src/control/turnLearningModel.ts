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
  TurnParameterEntry,
  TurnDirection,
} from "./turnControllerTypes.js";
import {
  MOTOR_RAMP_DOWN_TIME_MS,
  MOTOR_RAMP_UP_TIME_MS,
  TURN_SMALL_ANGLE_THRESHOLD_DEG,
  TURN_LEARNING_RATE,
  TURN_ANGLE_BINS,
  TURN_LEARNING_PARAMETERS_PATH,
} from "../constants.js";

export interface TurnLearningModelOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

export class TurnLearningModel {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: TurnLearningParameters;

  constructor(options: TurnLearningModelOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnLearningModel" });
    this.parametersPath = options.parametersPath ?? TURN_LEARNING_PARAMETERS_PATH;
    this.parameters = this.createDefaultParameters();
  }

  /**
   * Load parameters from disk, or use defaults if file doesn't exist
   */
  async loadParameters(): Promise<void> {
    try {
      const json = await readFile(this.parametersPath, "utf-8");
      this.parameters = JSON.parse(json);
      this.logger.info("turn.learning.loaded", {
        bins: this.parameters.parameters.length,
        version: this.parameters.version,
      });
    } catch (error) {
      if ((error as any)?.code === "ENOENT") {
        this.logger.info("turn.learning.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        this.logger.warn("turn.learning.load_failed", {
          error: String(error),
          using: "defaults",
        });
      }
    }
  }

  /**
   * Save current parameters to disk
   */
  async saveParameters(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = dirname(this.parametersPath);
      await mkdir(dir, { recursive: true });

      const json = JSON.stringify(this.parameters, null, 2);
      await writeFile(this.parametersPath, json, "utf-8");
    } catch (error) {
      this.logger.error("turn.learning.save_failed", {
        error: String(error),
        path: this.parametersPath,
      });
    }
  }

  /**
   * Update learning parameters based on turn result
   */
  async updateFromTurn(result: TurnLearningInput): Promise<void> {
    const absAngle = Math.abs(unwrapRelativeAngle(result.requestedAngle));
    const bin = this.getBinForAngle(absAngle);
    const entry = this.getOrCreateEntry(bin);

    const errorDeg = unwrapRelativeAngle(result.errorAngle);
    const currentBrake = result.direction === "ccw"
      ? entry.brakeAngleCcwDeg
      : entry.brakeAngleCwDeg;

    // Adaptive update: reduce brake angle if we overshot, increase if undershot
    // Error > 0 means we went too far → reduce brake angle
    // Error < 0 means we didn't go far enough → increase brake angle
    const adjustment = -errorDeg * this.parameters.learningRate;
    const newBrake = currentBrake + adjustment;

    // Clamp brake angle to reasonable bounds
    const minBrake = bin * 0.3;  // At least 30% of turn angle
    const maxBrake = bin * 0.95; // At most 95% of turn angle
    const clampedBrake = Math.max(minBrake, Math.min(maxBrake, newBrake));

    // Update parameters
    if (result.direction === "ccw") {
      entry.brakeAngleCcwDeg = clampedBrake;
      entry.sampleCountCcw++;
      entry.lastErrorCcwDeg = errorDeg;
    } else {
      entry.brakeAngleCwDeg = clampedBrake;
      entry.sampleCountCw++;
      entry.lastErrorCwDeg = errorDeg;
    }

    entry.lastUpdated = new Date().toISOString();

    this.logger.info("turn.learning.updated", {
      bin,
      direction: result.direction,
      errorDeg,
      adjustment,
      newBrake: clampedBrake,
      sampleCount: result.direction === "ccw" ? entry.sampleCountCcw : entry.sampleCountCw,
    });

    // Persist to disk immediately
    await this.saveParameters();
  }

  /**
   * Get brake angle for requested turn angle and direction
   */
  getBrakeAngle(absAngleDeg: number, direction: TurnDirection): RelativeAngle {
    const bin = this.getBinForAngle(absAngleDeg);
    const entry = this.getOrCreateEntry(bin);
    const brakeAngleDeg = direction === "ccw"
      ? entry.brakeAngleCcwDeg
      : entry.brakeAngleCwDeg;
    return createRelativeAngle(brakeAngleDeg);
  }

  /**
   * Get motor ramp-down time
   */
  getMotorRampDownTime(): number {
    return this.parameters.motorRampDownTimeMs;
  }

  /**
   * Get motor ramp-up time
   */
  getMotorRampUpTime(): number {
    return this.parameters.motorRampUpTimeMs;
  }

  /**
   * Get small angle threshold
   */
  getSmallAngleThreshold(): number {
    return this.parameters.smallAngleThresholdDeg;
  }

  /**
   * Get all learning parameters
   */
  getParameters(): TurnLearningParameters {
    return this.parameters;
  }

  /**
   * Reset to default parameters
   */
  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("turn.learning.reset", { bins: this.parameters.parameters.length });
  }

  /**
   * Map requested angle to nearest bin
   */
  private getBinForAngle(angleDeg: number): number {
    const bins = [...TURN_ANGLE_BINS];
    return bins.reduce((prev, curr) =>
      Math.abs(curr - angleDeg) < Math.abs(prev - angleDeg) ? curr : prev
    );
  }

  /**
   * Get or create parameter entry for angle bin
   */
  private getOrCreateEntry(bin: number): TurnParameterEntry {
    let entry = this.parameters.parameters.find(p => p.requestedAngleDeg === bin);
    if (!entry) {
      entry = {
        requestedAngleDeg: bin,
        brakeAngleCcwDeg: bin * 0.70,
        brakeAngleCwDeg: bin * 0.70,
        sampleCountCcw: 0,
        sampleCountCw: 0,
        lastErrorCcwDeg: 0,
        lastErrorCwDeg: 0,
        lastUpdated: new Date().toISOString(),
      };
      this.parameters.parameters.push(entry);
    }
    return entry;
  }

  /**
   * Create default conservative parameters
   */
  private createDefaultParameters(): TurnLearningParameters {
    const bins = [...TURN_ANGLE_BINS];
    return {
      version: 1,
      motorRampDownTimeMs: MOTOR_RAMP_DOWN_TIME_MS,
      motorRampUpTimeMs: MOTOR_RAMP_UP_TIME_MS,
      smallAngleThresholdDeg: TURN_SMALL_ANGLE_THRESHOLD_DEG,
      learningRate: TURN_LEARNING_RATE,
      parameters: bins.map(angle => ({
        requestedAngleDeg: angle,
        // Start conservatively - brake earlier than target
        brakeAngleCcwDeg: angle * 0.70,
        brakeAngleCwDeg: angle * 0.70,
        sampleCountCcw: 0,
        sampleCountCw: 0,
        lastErrorCcwDeg: 0,
        lastErrorCwDeg: 0,
        lastUpdated: new Date().toISOString(),
      })),
    };
  }
}
