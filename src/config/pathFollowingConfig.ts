import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { PATH_FOLLOWING_PARAMETERS_PATH } from "../constants.js";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface PathFollowingParameters {
  version: number;
  closedLoopToleranceMeters: number;
  closedLoopDetectionToleranceMeters: number;
  verificationApproachStandoffMeters: number;
  verificationTurnOnlyDistanceMeters: number;
  mowingStandoffMeters: number;
  segmentedDriveSimplificationToleranceMeters: number;
  segmentedDriveMaxVertexTurnDeg: number;
  segmentedDriveMaxSegmentLengthMeters: number;
  segmentedDriveMinSegmentLengthMeters: number;
  segmentedDriveMaxCteMeters: number;
  /**
   * On a high-current obstruction during a perimeter follow, the recovery routine
   * retraces the most recently completed targets in reverse until the cumulative
   * reverse travel reaches this distance, giving the mower clear ground to charge
   * back at the grass jam at full speed.
   */
  pathRetryReverseDistanceMeters: number;
  /**
   * Heading-alignment threshold (degrees) used by the mowing executor when
   * deciding whether to pivot before joining a recorded boundary. If the
   * remaining heading change to face the boundary tangent is below this
   * threshold the executor proceeds without pivoting.
   */
  turnAlignmentThresholdDeg: number;
  updatedAt: string;
}

export const DEFAULT_PATH_FOLLOWING_PARAMETERS: PathFollowingParameters = {
  version: 3,
  closedLoopToleranceMeters: 0.05,
  closedLoopDetectionToleranceMeters: 0.35,
  verificationApproachStandoffMeters: 0.10,
  verificationTurnOnlyDistanceMeters: 0.30,
  mowingStandoffMeters: 0.15,
  segmentedDriveSimplificationToleranceMeters: 0.05,
  segmentedDriveMaxVertexTurnDeg: 10,
  segmentedDriveMaxSegmentLengthMeters: 0.5,
  segmentedDriveMinSegmentLengthMeters: 0.05,
  segmentedDriveMaxCteMeters: 0.05,
  pathRetryReverseDistanceMeters: 0.5,
  turnAlignmentThresholdDeg: 2,
  updatedAt: new Date().toISOString(),
};

export interface PathFollowingConfigOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyPathFollowingParameters {
  version?: unknown;
  closedLoopToleranceMeters?: unknown;
  closedLoopDetectionToleranceMeters?: unknown;
  verificationApproachStandoffMeters?: unknown;
  verificationTurnOnlyDistanceMeters?: unknown;
  mowingStandoffMeters?: unknown;
  segmentedDriveSimplificationToleranceMeters?: unknown;
  segmentedDriveMaxVertexTurnDeg?: unknown;
  segmentedDriveMaxSegmentLengthMeters?: unknown;
  segmentedDriveMinSegmentLengthMeters?: unknown;
  segmentedDriveMaxCteMeters?: unknown;
  pathRetryReverseDistanceMeters?: unknown;
  turnAlignmentThresholdDeg?: unknown;
  updatedAt?: unknown;
}

export class PathFollowingConfig {
  private readonly logger: LoggerScope;
  private readonly parametersPath: string;
  private parameters: PathFollowingParameters;

  constructor(options: PathFollowingConfigOptions) {
    this.logger = options.logger.child({ context: "config", source: "PathFollowingConfig" });
    this.parametersPath = options.parametersPath ?? PATH_FOLLOWING_PARAMETERS_PATH;
    this.parameters = this.createDefaultParameters();
  }

  async loadParameters(): Promise<void> {
    try {
      const raw = await readJsonFile(this.parametersPath);
      this.parameters = this.normalizeParameters(raw);
      this.logger.info("path_following.config.loaded", {
        path: this.parametersPath,
        closedLoopToleranceMeters: this.parameters.closedLoopToleranceMeters,
        closedLoopDetectionToleranceMeters: this.parameters.closedLoopDetectionToleranceMeters,
        verificationApproachStandoffMeters: this.parameters.verificationApproachStandoffMeters,
        verificationTurnOnlyDistanceMeters: this.parameters.verificationTurnOnlyDistanceMeters,
        segmentedDriveSimplificationToleranceMeters: this.parameters.segmentedDriveSimplificationToleranceMeters,
        segmentedDriveMaxVertexTurnDeg: this.parameters.segmentedDriveMaxVertexTurnDeg,
        segmentedDriveMaxSegmentLengthMeters: this.parameters.segmentedDriveMaxSegmentLengthMeters,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.logger.info("path_following.config.no_file", {
          path: this.parametersPath,
          using: "defaults",
        });
      } else {
        this.logger.warn("path_following.config.load_failed", {
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
      this.logger.error("path_following.config.save_failed", {
        path: this.parametersPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getParameters(): PathFollowingParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("path_following.config.reset", {
      closedLoopToleranceMeters: this.parameters.closedLoopToleranceMeters,
      closedLoopDetectionToleranceMeters: this.parameters.closedLoopDetectionToleranceMeters,
      verificationApproachStandoffMeters: this.parameters.verificationApproachStandoffMeters,
      verificationTurnOnlyDistanceMeters: this.parameters.verificationTurnOnlyDistanceMeters,
      segmentedDriveSimplificationToleranceMeters: this.parameters.segmentedDriveSimplificationToleranceMeters,
      segmentedDriveMaxVertexTurnDeg: this.parameters.segmentedDriveMaxVertexTurnDeg,
      segmentedDriveMaxSegmentLengthMeters: this.parameters.segmentedDriveMaxSegmentLengthMeters,
    });
  }

  private normalizeParameters(raw: unknown): PathFollowingParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyPathFollowingParameters;
    return {
      version: this.readNumber(legacy.version, DEFAULT_PATH_FOLLOWING_PARAMETERS.version),
      closedLoopToleranceMeters: this.readPositiveNumber(
        legacy.closedLoopToleranceMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.closedLoopToleranceMeters,
      ),
      closedLoopDetectionToleranceMeters: this.readPositiveNumber(
        legacy.closedLoopDetectionToleranceMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.closedLoopDetectionToleranceMeters,
      ),
      verificationApproachStandoffMeters: this.readPositiveNumber(
        legacy.verificationApproachStandoffMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.verificationApproachStandoffMeters,
      ),
      verificationTurnOnlyDistanceMeters: this.readPositiveNumber(
        legacy.verificationTurnOnlyDistanceMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.verificationTurnOnlyDistanceMeters,
      ),
      mowingStandoffMeters: this.readPositiveNumber(
        legacy.mowingStandoffMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.mowingStandoffMeters,
      ),
      segmentedDriveSimplificationToleranceMeters: this.readPositiveNumber(
        legacy.segmentedDriveSimplificationToleranceMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.segmentedDriveSimplificationToleranceMeters,
      ),
      segmentedDriveMaxVertexTurnDeg: this.readPositiveNumber(
        legacy.segmentedDriveMaxVertexTurnDeg,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.segmentedDriveMaxVertexTurnDeg,
      ),
      segmentedDriveMaxSegmentLengthMeters: this.readPositiveNumber(
        legacy.segmentedDriveMaxSegmentLengthMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.segmentedDriveMaxSegmentLengthMeters,
      ),
      segmentedDriveMinSegmentLengthMeters: this.readPositiveNumber(
        legacy.segmentedDriveMinSegmentLengthMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.segmentedDriveMinSegmentLengthMeters,
      ),
      segmentedDriveMaxCteMeters: this.readPositiveNumber(
        legacy.segmentedDriveMaxCteMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.segmentedDriveMaxCteMeters,
      ),
      pathRetryReverseDistanceMeters: this.readPositiveNumber(
        legacy.pathRetryReverseDistanceMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.pathRetryReverseDistanceMeters,
      ),
      turnAlignmentThresholdDeg: this.readPositiveNumber(
        legacy.turnAlignmentThresholdDeg,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.turnAlignmentThresholdDeg,
      ),
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private createDefaultParameters(): PathFollowingParameters {
    return {
      ...DEFAULT_PATH_FOLLOWING_PARAMETERS,
      updatedAt: new Date().toISOString(),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private readNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private readPositiveNumber(value: unknown, fallback: number): number {
    const parsed = this.readNumber(value, fallback);
    return parsed >= 0 ? parsed : fallback;
  }
}
