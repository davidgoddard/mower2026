import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import {
  ENCODER_METERS_PER_TICK_DEFAULT,
  ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE,
  ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE,
  POSE_CALIBRATION_PATH,
  WHEEL_BASE_METERS_DEFAULT,
  WHEEL_BASE_METERS_MAX_PLAUSIBLE,
  WHEEL_BASE_METERS_MIN_PLAUSIBLE,
} from "../constants.js";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface PoseCalibrationParameters {
  version: number;
  /** Shared fallback used when per-wheel values are absent */
  encoderMetersPerTick: number;
  leftEncoderMetersPerTick: number;
  rightEncoderMetersPerTick: number;
  wheelbaseMeters: number;
  /**
   * Optional per-direction overrides (Phase-4).  When present, pose fusion
   * picks the appropriate set based on the sign of the encoder deltas.
   * When absent (v1 file or freshly defaulted), the symmetric values
   * above are used for both directions.
   */
  forwardLeftEncoderMetersPerTick?: number;
  forwardRightEncoderMetersPerTick?: number;
  reverseLeftEncoderMetersPerTick?: number;
  reverseRightEncoderMetersPerTick?: number;
  updatedAt: string;
}

export interface PoseCalibrationOptions {
  logger: SessionLogger;
  parametersPath?: string;
}

interface LegacyPoseCalibrationParameters {
  version?: unknown;
  encoderMetersPerTick?: unknown;
  leftEncoderMetersPerTick?: unknown;
  rightEncoderMetersPerTick?: unknown;
  wheelbaseMeters?: unknown;
  forwardLeftEncoderMetersPerTick?: unknown;
  forwardRightEncoderMetersPerTick?: unknown;
  reverseLeftEncoderMetersPerTick?: unknown;
  reverseRightEncoderMetersPerTick?: unknown;
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
        leftEncoderMetersPerTick: this.parameters.leftEncoderMetersPerTick,
        rightEncoderMetersPerTick: this.parameters.rightEncoderMetersPerTick,
        wheelbaseMeters: this.parameters.wheelbaseMeters,
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

  /** Shared scalar — used by callers that don't distinguish left/right */
  getEncoderCalibration(): number {
    return this.parameters.encoderMetersPerTick;
  }

  getLeftEncoderMetersPerTick(): number {
    return this.parameters.leftEncoderMetersPerTick;
  }

  getRightEncoderMetersPerTick(): number {
    return this.parameters.rightEncoderMetersPerTick;
  }

  getWheelbaseMeters(): number {
    return this.parameters.wheelbaseMeters;
  }

  /**
   * True when the persisted calibration values are all within plausible
   * physical ranges. Defaults are plausible by construction, so this returns
   * true even for an uncalibrated mower running on defaults — the meaning is
   * "the values won't break the controller", not "the values were measured".
   */
  isCalibrationPlausible(): boolean {
    return (
      this.parameters.wheelbaseMeters >= WHEEL_BASE_METERS_MIN_PLAUSIBLE &&
      this.parameters.wheelbaseMeters <= WHEEL_BASE_METERS_MAX_PLAUSIBLE &&
      this.parameters.leftEncoderMetersPerTick  >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE &&
      this.parameters.leftEncoderMetersPerTick  <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE &&
      this.parameters.rightEncoderMetersPerTick >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE &&
      this.parameters.rightEncoderMetersPerTick <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE
    );
  }

  setEncoderCalibration(metersPerTick: number): void {
    // Shared setter intentionally overwrites per-wheel values.
    // If per-wheel asymmetric calibration matters, use setPerWheelCalibration instead.
    this.parameters.encoderMetersPerTick = metersPerTick;
    this.parameters.leftEncoderMetersPerTick = metersPerTick;
    this.parameters.rightEncoderMetersPerTick = metersPerTick;
  }

  setPerWheelCalibration(leftMetersPerTick: number, rightMetersPerTick: number, wheelbaseMeters: number): void {
    this.parameters.leftEncoderMetersPerTick = leftMetersPerTick;
    this.parameters.rightEncoderMetersPerTick = rightMetersPerTick;
    this.parameters.wheelbaseMeters = wheelbaseMeters;
    // shared scalar = average
    this.parameters.encoderMetersPerTick = (leftMetersPerTick + rightMetersPerTick) / 2;
  }

  /** Phase-4: store calibration measured during the forward straight phase. */
  setForwardWheelCalibration(leftMetersPerTick: number, rightMetersPerTick: number): void {
    this.parameters.forwardLeftEncoderMetersPerTick = leftMetersPerTick;
    this.parameters.forwardRightEncoderMetersPerTick = rightMetersPerTick;
    // Mirror into the symmetric fields so callers that don't yet know
    // about per-direction values see the most recent forward calibration.
    this.parameters.leftEncoderMetersPerTick = leftMetersPerTick;
    this.parameters.rightEncoderMetersPerTick = rightMetersPerTick;
    this.parameters.encoderMetersPerTick = (leftMetersPerTick + rightMetersPerTick) / 2;
  }

  /** Phase-4: store calibration measured during the reverse straight phase. */
  setReverseWheelCalibration(leftMetersPerTick: number, rightMetersPerTick: number): void {
    this.parameters.reverseLeftEncoderMetersPerTick = leftMetersPerTick;
    this.parameters.reverseRightEncoderMetersPerTick = rightMetersPerTick;
  }

  getForwardLeftEncoderMetersPerTick(): number {
    return this.parameters.forwardLeftEncoderMetersPerTick ?? this.parameters.leftEncoderMetersPerTick;
  }

  getForwardRightEncoderMetersPerTick(): number {
    return this.parameters.forwardRightEncoderMetersPerTick ?? this.parameters.rightEncoderMetersPerTick;
  }

  getReverseLeftEncoderMetersPerTick(): number {
    return this.parameters.reverseLeftEncoderMetersPerTick ?? this.parameters.leftEncoderMetersPerTick;
  }

  getReverseRightEncoderMetersPerTick(): number {
    return this.parameters.reverseRightEncoderMetersPerTick ?? this.parameters.rightEncoderMetersPerTick;
  }

  getParameters(): PoseCalibrationParameters {
    return { ...this.parameters };
  }

  async resetToDefaults(): Promise<void> {
    this.parameters = this.createDefaultParameters();
    await this.saveParameters();
    this.logger.info("pose.calibration.reset", {
      encoderMetersPerTick: this.parameters.encoderMetersPerTick,
      wheelbaseMeters: this.parameters.wheelbaseMeters,
    });
  }

  private normalizeParameters(raw: unknown): PoseCalibrationParameters {
    if (!this.isRecord(raw)) {
      return this.createDefaultParameters();
    }

    const legacy = raw as LegacyPoseCalibrationParameters;
    const sharedRaw = this.readNumber(legacy.encoderMetersPerTick, ENCODER_METERS_PER_TICK_DEFAULT);
    const shared = this.clampPerTick(sharedRaw, ENCODER_METERS_PER_TICK_DEFAULT, "encoderMetersPerTick");
    const left = this.clampPerTick(
      this.readNumber(legacy.leftEncoderMetersPerTick, shared),
      shared,
      "leftEncoderMetersPerTick",
    );
    const right = this.clampPerTick(
      this.readNumber(legacy.rightEncoderMetersPerTick, shared),
      shared,
      "rightEncoderMetersPerTick",
    );
    const wheelbase = this.clampWheelbase(
      this.readNumber(legacy.wheelbaseMeters, WHEEL_BASE_METERS_DEFAULT),
    );
    const fwdL = this.optionalPerTick(legacy.forwardLeftEncoderMetersPerTick, "forwardLeftEncoderMetersPerTick");
    const fwdR = this.optionalPerTick(legacy.forwardRightEncoderMetersPerTick, "forwardRightEncoderMetersPerTick");
    const revL = this.optionalPerTick(legacy.reverseLeftEncoderMetersPerTick, "reverseLeftEncoderMetersPerTick");
    const revR = this.optionalPerTick(legacy.reverseRightEncoderMetersPerTick, "reverseRightEncoderMetersPerTick");

    return {
      version: this.readNumber(legacy.version, 1),
      encoderMetersPerTick: shared,
      leftEncoderMetersPerTick: left,
      rightEncoderMetersPerTick: right,
      wheelbaseMeters: wheelbase,
      forwardLeftEncoderMetersPerTick: fwdL,
      forwardRightEncoderMetersPerTick: fwdR,
      reverseLeftEncoderMetersPerTick: revL,
      reverseRightEncoderMetersPerTick: revR,
      updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
    };
  }

  private optionalPerTick(raw: unknown, fieldName: string): number | undefined {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
    if (raw >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE && raw <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE) {
      return raw;
    }
    this.logger.warn("pose.calibration.implausible_value", {
      field: fieldName,
      value: raw,
      min: ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE,
      max: ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE,
      using: "fallback (per-direction omitted)",
    });
    return undefined;
  }

  private clampPerTick(value: number, fallback: number, fieldName: string): number {
    if (value >= ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE && value <= ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE) {
      return value;
    }
    this.logger.warn("pose.calibration.implausible_value", {
      field: fieldName,
      value,
      min: ENCODER_METERS_PER_TICK_MIN_PLAUSIBLE,
      max: ENCODER_METERS_PER_TICK_MAX_PLAUSIBLE,
      using: fallback,
    });
    return fallback;
  }

  private clampWheelbase(value: number): number {
    if (value >= WHEEL_BASE_METERS_MIN_PLAUSIBLE && value <= WHEEL_BASE_METERS_MAX_PLAUSIBLE) {
      return value;
    }
    this.logger.warn("pose.calibration.implausible_value", {
      field: "wheelbaseMeters",
      value,
      min: WHEEL_BASE_METERS_MIN_PLAUSIBLE,
      max: WHEEL_BASE_METERS_MAX_PLAUSIBLE,
      using: WHEEL_BASE_METERS_DEFAULT,
    });
    return WHEEL_BASE_METERS_DEFAULT;
  }

  private createDefaultParameters(): PoseCalibrationParameters {
    return {
      version: 1,
      encoderMetersPerTick: ENCODER_METERS_PER_TICK_DEFAULT,
      leftEncoderMetersPerTick: ENCODER_METERS_PER_TICK_DEFAULT,
      rightEncoderMetersPerTick: ENCODER_METERS_PER_TICK_DEFAULT,
      wheelbaseMeters: WHEEL_BASE_METERS_DEFAULT,
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
