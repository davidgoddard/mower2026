import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { IMU_YAW_CALIBRATION_PATH } from "../constants.js";
import { quarantineCorruptFile, readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface ImuCalibrationParameters {
  version: number;
  yawScaleFactor: number;
  sampleCount: number;
  updatedAt: string;
}

export interface ImuCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyImuCalibrationParameters {
  version?: unknown;
  yawScaleFactor?: unknown;
  sampleCount?: unknown;
  updatedAt?: unknown;
}

export class ImuCalibration {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: ImuCalibrationParameters;

  constructor(options: ImuCalibrationOptions) {
    this.logger = options.logger.child({ context: "config", source: "ImuCalibration" });
    this.parametersPath = options.parametersPath ?? IMU_YAW_CALIBRATION_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("imu.calibration.loaded", {
        path: this.parametersPath,
        yawScaleFactor: this.parameters.yawScaleFactor,
        sampleCount: this.parameters.sampleCount,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("imu.calibration.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        const quarantined = await quarantineCorruptFile(this.parametersPath, new Date().toISOString());
        this.logger.warn("imu.calibration.load_failed", {
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
    const updated: ImuCalibrationParameters = { ...this.parameters, updatedAt: new Date().toISOString() };
    try {
      await writeJsonFile(this.parametersPath, updated);
      this.parameters = updated;
    } catch (error) {
      this.logger.error("imu.calibration.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getYawScaleFactor(): number {
    return this.parameters.yawScaleFactor;
  }

  setYawScaleFactor(yawScaleFactor: number, sampleCount = this.parameters.sampleCount): void {
    this.parameters.yawScaleFactor = yawScaleFactor;
    this.parameters.sampleCount = sampleCount;
  }

  getParameters(): ImuCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("imu.calibration.reset", {
      yawScaleFactor: this.parameters.yawScaleFactor,
      sampleCount: this.parameters.sampleCount,
    });
  }

  private normalizeParameters(raw: unknown): ImuCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyImuCalibrationParameters;
    return {
      version: this.readNumber(legacy.version, 1),
      yawScaleFactor: this.readNumber(legacy.yawScaleFactor, 1),
      sampleCount: this.readNumber(legacy.sampleCount, 0),
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private createDefaultParameters(): ImuCalibrationParameters {
    return {
      version: 1,
      yawScaleFactor: 1,
      sampleCount: 0,
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
