import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { GEOMETRY_CALIBRATION_PATH } from "../constants.js";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface GeometryCalibrationParameters {
  version: number;
  positionOffsetForwardMeters: number;
  positionOffsetRightMeters: number;
  updatedAt: string;
}

export interface GeometryCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyGeometryCalibrationParameters {
  version?: unknown;
  positionOffsetForwardMeters?: unknown;
  positionOffsetRightMeters?: unknown;
  updatedAt?: unknown;
}

export class GeometryCalibration {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: GeometryCalibrationParameters;

  constructor(options: GeometryCalibrationOptions) {
    this.logger = options.logger.child({ context: "config", source: "GeometryCalibration" });
    this.parametersPath = options.parametersPath ?? GEOMETRY_CALIBRATION_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("geometry.calibration.loaded", {
        path: this.parametersPath,
        positionOffsetForwardMeters: this.parameters.positionOffsetForwardMeters,
        positionOffsetRightMeters: this.parameters.positionOffsetRightMeters,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("geometry.calibration.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        this.logger.warn("geometry.calibration.load_failed", {
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
      this.logger.error("geometry.calibration.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getPositionOffsetForwardMeters(): number {
    return this.parameters.positionOffsetForwardMeters;
  }

  getPositionOffsetRightMeters(): number {
    return this.parameters.positionOffsetRightMeters;
  }

  setPositionOffset(forwardMeters: number, rightMeters: number): void {
    this.parameters.positionOffsetForwardMeters = forwardMeters;
    this.parameters.positionOffsetRightMeters = rightMeters;
  }

  getParameters(): GeometryCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("geometry.calibration.reset", {
      positionOffsetForwardMeters: this.parameters.positionOffsetForwardMeters,
      positionOffsetRightMeters: this.parameters.positionOffsetRightMeters,
    });
  }

  private normalizeParameters(raw: unknown): GeometryCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyGeometryCalibrationParameters;
    return {
      version: this.readNumber(legacy.version, 1),
      positionOffsetForwardMeters: this.readNumber(legacy.positionOffsetForwardMeters, 0),
      positionOffsetRightMeters: this.readNumber(legacy.positionOffsetRightMeters, 0),
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private createDefaultParameters(): GeometryCalibrationParameters {
    return {
      version: 1,
      positionOffsetForwardMeters: 0,
      positionOffsetRightMeters: 0,
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
