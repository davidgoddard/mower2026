import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { ENCODER_METERS_PER_TICK_DEFAULT, POSE_CALIBRATION_PATH } from "../constants.js";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface PoseCalibrationParameters {
  version: number;
  encoderMetersPerTick: number;
  updatedAt: string;
}

export interface PoseCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyPoseCalibrationParameters {
  version?: unknown;
  encoderMetersPerTick?: unknown;
  updatedAt?: unknown;
}

export class PoseCalibration {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: PoseCalibrationParameters;

  constructor(options: PoseCalibrationOptions) {
    this.logger = options.logger.child({ context: "config", source: "PoseCalibration" });
    this.parametersPath = options.parametersPath ?? POSE_CALIBRATION_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("pose.calibration.loaded", {
        path: this.parametersPath,
        encoderMetersPerTick: this.parameters.encoderMetersPerTick,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("pose.calibration.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        this.logger.warn("pose.calibration.load_failed", {
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
      this.logger.error("pose.calibration.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getEncoderCalibration(): number {
    return this.parameters.encoderMetersPerTick;
  }

  setEncoderCalibration(metersPerTick: number): void {
    this.parameters.encoderMetersPerTick = metersPerTick;
  }

  getParameters(): PoseCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("pose.calibration.reset", {
      encoderMetersPerTick: this.parameters.encoderMetersPerTick,
    });
  }

  private normalizeParameters(raw: unknown): PoseCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyPoseCalibrationParameters;
    return {
      version: this.readNumber(legacy.version, 1),
      encoderMetersPerTick: this.readNumber(legacy.encoderMetersPerTick, ENCODER_METERS_PER_TICK_DEFAULT),
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private createDefaultParameters(): PoseCalibrationParameters {
    return {
      version: 1,
      encoderMetersPerTick: ENCODER_METERS_PER_TICK_DEFAULT,
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
