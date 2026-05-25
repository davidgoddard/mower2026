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
  obstacleOutwardOffsetMeters: number;
  purePursuitMinLookaheadMeters: number;
  purePursuitBaseLookaheadMeters: number;
  purePursuitMaxLookaheadMeters: number;
  updatedAt: string;
}

export const DEFAULT_PATH_FOLLOWING_PARAMETERS: PathFollowingParameters = {
  version: 1,
  closedLoopToleranceMeters: 0.05,
  closedLoopDetectionToleranceMeters: 0.35,
  verificationApproachStandoffMeters: 0.10,
  verificationTurnOnlyDistanceMeters: 0.30,
  obstacleOutwardOffsetMeters: 0.5,
  purePursuitMinLookaheadMeters: 0.5,
  purePursuitBaseLookaheadMeters: 1.0,
  purePursuitMaxLookaheadMeters: 2.0,
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
  obstacleOutwardOffsetMeters?: unknown;
  purePursuitMinLookaheadMeters?: unknown;
  purePursuitBaseLookaheadMeters?: unknown;
  purePursuitMaxLookaheadMeters?: unknown;
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
        obstacleOutwardOffsetMeters: this.parameters.obstacleOutwardOffsetMeters,
        purePursuitMinLookaheadMeters: this.parameters.purePursuitMinLookaheadMeters,
        purePursuitBaseLookaheadMeters: this.parameters.purePursuitBaseLookaheadMeters,
        purePursuitMaxLookaheadMeters: this.parameters.purePursuitMaxLookaheadMeters,
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
      obstacleOutwardOffsetMeters: this.parameters.obstacleOutwardOffsetMeters,
      purePursuitMinLookaheadMeters: this.parameters.purePursuitMinLookaheadMeters,
      purePursuitBaseLookaheadMeters: this.parameters.purePursuitBaseLookaheadMeters,
      purePursuitMaxLookaheadMeters: this.parameters.purePursuitMaxLookaheadMeters,
    });
  }

  private normalizeParameters(raw: unknown): PathFollowingParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyPathFollowingParameters;
    return {
      version: this.readNumber(legacy.version, 1),
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
      obstacleOutwardOffsetMeters: this.readPositiveNumber(
        legacy.obstacleOutwardOffsetMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.obstacleOutwardOffsetMeters,
      ),
      purePursuitMinLookaheadMeters: this.readPositiveNumber(
        legacy.purePursuitMinLookaheadMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.purePursuitMinLookaheadMeters,
      ),
      purePursuitBaseLookaheadMeters: this.readPositiveNumber(
        legacy.purePursuitBaseLookaheadMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.purePursuitBaseLookaheadMeters,
      ),
      purePursuitMaxLookaheadMeters: this.readPositiveNumber(
        legacy.purePursuitMaxLookaheadMeters,
        DEFAULT_PATH_FOLLOWING_PARAMETERS.purePursuitMaxLookaheadMeters,
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
