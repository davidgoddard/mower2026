import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { MOTOR_DECEL_PERCENT_PER_SECOND, MOTOR_ACCEL_PERCENT_PER_SECOND, MOTOR_CALIBRATION_PATH } from "../constants.js";
import { quarantineCorruptFile, readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface MotorCalibrationParameters {
  version: number;
  /** Motor deceleration rate in %/s (firmware step per tick = value × 10ms / 1000). */
  motorDecelPercentPerSecond: number;
  /** Motor acceleration rate in %/s. */
  motorAccelPercentPerSecond: number;
  updatedAt: string;
}

export interface MotorCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyMotorCalibrationParameters {
  version?: unknown;
  /** Legacy ms-based fields from files written before the refactor. */
  motorRampDownTimeMs?: unknown;
  motorRampUpTimeMs?: unknown;
  motorDecelPercentPerSecond?: unknown;
  motorAccelPercentPerSecond?: unknown;
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
        motorDecelPercentPerSecond: this.parameters.motorDecelPercentPerSecond,
        motorAccelPercentPerSecond: this.parameters.motorAccelPercentPerSecond,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("motor.calibration.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        const quarantined = await quarantineCorruptFile(this.parametersPath, new Date().toISOString());
        this.logger.warn("motor.calibration.load_failed", {
          path: this.parametersPath,
          error: error instanceof Error ? error.message : String(error),
          quarantinedTo: quarantined,
          using: "defaults",
        });
      }

      this.parameters = this.createDefaultParameters();
      await this.saveParameters();
    }
  }

  async saveParameters(): Promise<void> {
    const updated: MotorCalibrationParameters = { ...this.parameters, updatedAt: new Date().toISOString() };
    try {
      await writeJsonFile(this.parametersPath, updated);
      this.parameters = updated;
    } catch (error) {
      this.logger.error("motor.calibration.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Deceleration rate in %/s. The firmware subtracts `value × elapsedMs / 1000` per tick. */
  getDecelPercentPerSecond(): number {
    return this.parameters.motorDecelPercentPerSecond;
  }

  /** Acceleration rate in %/s. */
  getAccelPercentPerSecond(): number {
    return this.parameters.motorAccelPercentPerSecond;
  }

  /** Backward-compatible: effective ms to ramp from 100 % to 0 % at the calibrated rate. */
  getRampDownTime(): number {
    return Math.round(100_000 / this.parameters.motorDecelPercentPerSecond);
  }

  /** Backward-compatible: effective ms to ramp from 0 % to 100 % at the calibrated rate. */
  getRampUpTime(): number {
    return Math.round(100_000 / this.parameters.motorAccelPercentPerSecond);
  }

  getParameters(): MotorCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("motor.calibration.reset", {
      motorDecelPercentPerSecond: this.parameters.motorDecelPercentPerSecond,
      motorAccelPercentPerSecond: this.parameters.motorAccelPercentPerSecond,
    });
  }

  private normalizeParameters(raw: unknown): MotorCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyMotorCalibrationParameters;

    // New format: %/s fields present directly.
    if (typeof legacy.motorDecelPercentPerSecond === "number" && Number.isFinite(legacy.motorDecelPercentPerSecond)) {
      return {
        version: this.readNumber(legacy.version, 2),
        motorDecelPercentPerSecond: this.readNumber(legacy.motorDecelPercentPerSecond, MOTOR_DECEL_PERCENT_PER_SECOND),
        motorAccelPercentPerSecond: this.readNumber(legacy.motorAccelPercentPerSecond, MOTOR_ACCEL_PERCENT_PER_SECOND),
        updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
      };
    }

    // Legacy format: ms fields — convert on load.
    if (typeof legacy.motorRampDownTimeMs === "number" && Number.isFinite(legacy.motorRampDownTimeMs) && legacy.motorRampDownTimeMs > 0) {
      const decel = Math.round(100_000 / legacy.motorRampDownTimeMs);
      const accelMs = typeof legacy.motorRampUpTimeMs === "number" && Number.isFinite(legacy.motorRampUpTimeMs) && (legacy.motorRampUpTimeMs as number) > 0
        ? legacy.motorRampUpTimeMs as number
        : Math.round(100_000 / MOTOR_ACCEL_PERCENT_PER_SECOND);
      const accel = Math.round(100_000 / accelMs);
      return {
        version: this.readNumber(legacy.version, 2),
        motorDecelPercentPerSecond: decel,
        motorAccelPercentPerSecond: accel,
        updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
      };
    }

    return this.createDefaultParameters();
  }

  private createDefaultParameters(): MotorCalibrationParameters {
    return {
      version: 2,
      motorDecelPercentPerSecond: MOTOR_DECEL_PERCENT_PER_SECOND,
      motorAccelPercentPerSecond: MOTOR_ACCEL_PERCENT_PER_SECOND,
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
