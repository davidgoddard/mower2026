/**
 * Drive learning model - adaptive parameter tuning for drive controller
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { Position, Meters, unwrapMeters, distanceBetween } from "../geometry/positionTypes.js";
import {
  DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
  DRIVE_CTE_GAIN_DEFAULT,
  DRIVE_MIN_DISTANCE_FOR_LEARNING_METERS,
  MOTOR_RAMP_DOWN_TIME_MS,
  DRIVE_TARGET_CTE_METERS,
  DATA_DIR,
} from "../constants.js";

export interface DriveParameters {
  version: number;
  brakeDistanceMeters: number; // Single value for full-speed drives
  cteGain: number; // Proportional gain for CTE correction
  minDriveDistanceForLearning: number; // Threshold for short drives (meters)
  motorRampDownTimeMs: number; // From hardware spec
  updatedAt: string;
}

export interface DriveUpdateData {
  startPosition: Position;
  targetPosition: Position;
  finalPosition: Position;
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
  private parameters: DriveParameters;

  constructor(options: DriveLearningModelOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveLearningModel" });
    this.parametersPath =
      options.parametersPath ?? path.join(DATA_DIR, "drive-learning-params.json");

    // Initialize with defaults
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const content = await fs.readFile(this.parametersPath, "utf8");
      this.parameters = JSON.parse(content);
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
      }
    }
  }

  async saveParameters(): Promise<void> {
    try {
      this.parameters.updatedAt = new Date().toISOString();
      await fs.writeFile(this.parametersPath, JSON.stringify(this.parameters, null, 2), "utf8");
      this.logger.info("drive.learning.parameters_saved", { path: this.parametersPath });
    } catch (error) {
      this.logger.error("drive.learning.save_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getBrakeDistance(): Meters {
    return this.parameters.brakeDistanceMeters as Meters;
  }

  getCteGain(): number {
    return this.parameters.cteGain;
  }

  getMotorRampDownTime(): number {
    return this.parameters.motorRampDownTimeMs;
  }

  getParameters(): DriveParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("drive.learning.reset_to_defaults", {});
  }

  async updateFromDrive(data: DriveUpdateData): Promise<void> {
    const errorXValue = unwrapMeters(data.errorX);
    const maxCteValue = Math.abs(unwrapMeters(data.maxCte));

    // Only learn from drives that likely reached full speed
    const driveDistance = unwrapMeters(distanceBetween(data.startPosition, data.targetPosition));
    if (driveDistance < this.parameters.minDriveDistanceForLearning) {
      this.logger.info("drive.learning.skipped_short_drive", { driveDistance });
      return;
    }

    // Update brake distance
    const brakeDistanceBefore = this.parameters.brakeDistanceMeters;
    this.updateBrakeDistance(errorXValue);

    // Update CTE gain
    const cteGainBefore = this.parameters.cteGain;
    this.updateCteGain(maxCteValue);

    this.logger.info("drive.learning.updated", {
      errorX: errorXValue,
      maxCte: maxCteValue,
      brakeDistance: { before: brakeDistanceBefore, after: this.parameters.brakeDistanceMeters },
      cteGain: { before: cteGainBefore, after: this.parameters.cteGain },
    });

    await this.saveParameters();
  }

  private updateBrakeDistance(errorXValue: number): void {
    // Positive error = overshot, need to increase brake distance
    // Negative error = undershot, need to decrease brake distance
    const alpha = 0.1; // Learning rate
    const adjustment = errorXValue * alpha;
    this.parameters.brakeDistanceMeters += adjustment;

    // Clamp to reasonable range
    this.parameters.brakeDistanceMeters = Math.max(
      0.5,
      Math.min(5.0, this.parameters.brakeDistanceMeters)
    );
  }

  private updateCteGain(maxCteValue: number): void {
    const targetCte = DRIVE_TARGET_CTE_METERS;

    if (maxCteValue > targetCte * 1.5) {
      // CTE too high - increase gain
      this.parameters.cteGain *= 1.05;
    } else if (maxCteValue < targetCte * 0.5) {
      // CTE very low - could decrease gain (more efficient)
      this.parameters.cteGain *= 0.98;
    }

    // Clamp gain
    this.parameters.cteGain = Math.max(0.1, Math.min(1.0, this.parameters.cteGain));
  }

  private createDefaultParameters(): DriveParameters {
    return {
      version: 1,
      brakeDistanceMeters: DRIVE_BRAKE_DISTANCE_DEFAULT_METERS,
      cteGain: DRIVE_CTE_GAIN_DEFAULT,
      minDriveDistanceForLearning: DRIVE_MIN_DISTANCE_FOR_LEARNING_METERS,
      motorRampDownTimeMs: MOTOR_RAMP_DOWN_TIME_MS,
      updatedAt: new Date().toISOString(),
    };
  }
}
