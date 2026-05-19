import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { MOTOR_RAMP_DOWN_TIME_MS, MOTOR_RAMP_UP_TIME_MS, MOTOR_CALIBRATION_PATH } from "../constants.js";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface MotorCalibrationParameters {
  version: number;
  motorRampDownTimeMs: number;
  motorRampUpTimeMs: number;
  updatedAt: string;
}

export interface MotorCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyMotorCalibrationParameters {
  version?: unknown;
  motorRampDownTimeMs?: unknown;
  motorRampUpTimeMs?: unknown;
  updatedAt?: unknown;
}

export class MotorCalibration {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: MotorCalibrationParameters;

  constructor(options: MotorCalibrationOptions) {
    this.logger = options.logger.child({ context: "config", source: "MotorCalibration" });
    this.parametersPath = options.parametersPath ?? MOTOR_CALIBRATION_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("motor.calibration.loaded", {
        path: this.parametersPath,
        motorRampDownTimeMs: this.parameters.motorRampDownTimeMs,
        motorRampUpTimeMs: this.parameters.motorRampUpTimeMs,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("motor.calibration.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        this.logger.warn("motor.calibration.load_failed", {
          path: this.parametersPath,
          error: error instanceof Error ? error.message : String(error),
          using: "defaults",
        });
      }

      this.parameters = this.createDefaultParameters();
      await this.saveParameters();
    }
  }

  async saveParameters(): Promise<void> {
    this.parameters.updatedAt = new Date().toISOString();
    try {
      await writeJsonFile(this.parametersPath, this.parameters);
    } catch (error) {
      this.logger.error("motor.calibration.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRampDownTime(): number {
    return this.parameters.motorRampDownTimeMs;
  }

  getRampUpTime(): number {
    return this.parameters.motorRampUpTimeMs;
  }

  getParameters(): MotorCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("motor.calibration.reset", {
      motorRampDownTimeMs: this.parameters.motorRampDownTimeMs,
      motorRampUpTimeMs: this.parameters.motorRampUpTimeMs,
    });
  }

  private normalizeParameters(raw: unknown): MotorCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyMotorCalibrationParameters;
    return {
      version: this.readNumber(legacy.version, 1),
      motorRampDownTimeMs: this.readNumber(legacy.motorRampDownTimeMs, MOTOR_RAMP_DOWN_TIME_MS),
      motorRampUpTimeMs: this.readNumber(legacy.motorRampUpTimeMs, MOTOR_RAMP_UP_TIME_MS),
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private createDefaultParameters(): MotorCalibrationParameters {
    return {
      version: 1,
      motorRampDownTimeMs: MOTOR_RAMP_DOWN_TIME_MS,
      motorRampUpTimeMs: MOTOR_RAMP_UP_TIME_MS,
      updatedAt: new Date().toISOString(),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
}
