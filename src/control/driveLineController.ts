/**
 * Drive line controller - executes straight-line drives at full power.
 *
 * This component assumes the mower is already aligned with the line of travel.
 * It runs the wheels at full forward (or full reverse) power and applies a
 * proportional left/right wheel-trim to keep cross-track error small; the
 * trim is the only deviation from full power. The drive ends at the brake
 * trigger learned by the drive learning model. There are no curved paths,
 * no pure pursuit, and no concept of m/s in this controller — keeping motor
 * load high is required because the cutting blade and drive are mechanically
 * coupled and slow speeds can stall the mower.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { DriveLearningModel } from "./driveLearningModel.js";
import { MotorCalibration } from "../config/motorCalibration.js";
import {
  RunRecord,
  RunRecordHeartbeatSample,
  RunRecordPose,
  RunRecordWriter,
} from "./runRecord.js";
import {
  SENSOR_EVENTS,
  ImuHeadingUpdateEvent,
  MotorFeedbackUpdateEvent,
  ObstructionDetectedEvent,
} from "../sensing/sensorEvents.js";
import {
  Position,
  Pose,
  Meters,
  createPosition,
  createMeters,
  unwrapMeters,
  distanceBetween,
  crossTrackError,
  calculateXError,
} from "../geometry/positionTypes.js";
import {
  InternalHeading,
  createInternalHeading,
  headingDifference,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  DriveRequest,
  DriveResult,
  DriveTrainingProgress,
  DriveTrainingProgressReporter,
  DriveControllerState,
  DriveStatus,
} from "./driveControllerTypes.js";
import {
  DRIVE_SETTLE_TIME_MS,
  DRIVE_HISTORY_MAX_SIZE,
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MOTOR_RAMP_DOWN_TIME_MS,
  DRIVE_SHORT_BUCKET_STEP_METERS,
  DRIVE_SHORT_BUCKET_MAX_METERS,
  DRIVE_SHORT_BUCKET_DISTANCES_METERS,
  DRIVE_LONG_SAMPLE_DISTANCES_METERS,
  DRIVE_SHORT_TARGET_X_ERROR_METERS,
  DRIVE_ARRIVAL_TOLERANCE_METERS,
  DRIVE_STEERING_ROTATE_TO_HEADING_MIN_ANGLE_DEG,
  DRIVE_STEERING_PIVOT_OUTPUT_PERCENT,
  DRIVE_STEERING_TARGET_INFLUENCE_DISTANCE_METERS,
  DRIVE_STEERING_MAX_TRIM_PERCENT,
  MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
} from "../constants.js";
import { systemStop } from "./systemStop.js";
import { defaultSleep } from "./sleep.js";

export interface DriveLineRequest extends DriveRequest {
  readonly driveDirectionSign?: 1 | -1;
  readonly maxCrossTrackErrorMeters?: number;
}

export interface DriveLineControllerOptions {
  sensorController: SensorController;
  poseFusion: PoseFusion;
  logger: SessionLogger;
  learningModel: DriveLearningModel;
  motorCalibration?: MotorCalibration;
  fullSpeedCommand?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * Optional Phase-1 instrumentation sink.  When supplied, the controller
   * writes a RunRecord per drive to `<logDir>/run-records/<date>.jsonl`.
   * Drives never fail if the writer fails — instrumentation is best-effort.
   */
  runRecordWriter?: RunRecordWriter;
}

interface RunInstrumentation {
  readonly runId: string;
  readonly anchor: RunRecordPose | null;
  brakeTrigger: (RunRecordPose & {
    remainingAlongTrackMeters: number;
    reason: "arrival_tolerance" | "brake_distance" | "none";
  }) | null;
  peakTickRate: number;
  pitchAtAnchorDeg: number | null;
  obstructionSeen: boolean;
  wheelSlipSeen: boolean;
  gnssDemotedDuringRun: boolean;
  lastHeartbeatTickMs: number;
  heartbeat: RunRecordHeartbeatSample[];
  paramsSnapshot: { coastDistanceUsedMeters: number; cteGainUsed: number; shortBucketUsed: boolean };
}

const RUN_RECORD_HEARTBEAT_INTERVAL_MS = 500; // 2 Hz
const RUN_RECORD_HEARTBEAT_MAX_SAMPLES = 200;

export class DriveLineController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly learningModel: DriveLearningModel;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly fullSpeedCommand: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly runRecordWriter: RunRecordWriter | null;

  private status: DriveStatus = "idle";
  private currentDrive: DriveLineRequest | null = null;
  private stopRequested = false;
  private driveHistory: DriveResult[] = [];
  private shortTrainingResults: DriveResult[] = [];
  private drivesCompleted = 0;
  private totalErrorXMeters = 0;
  private totalErrorYMeters = 0;

  private poseUpdateInFlight = false;
  private driveStartPosition: Position | null = null;
  private driveStartHeading: InternalHeading | null = null;
  private driveStartPoseQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private brakeDecisionPoseQuality: "gnss" | "dead-reckoning" | "unknown" = "unknown";
  private driveTargetPosition: Position | null = null;
  private driveLineStart: Position | null = null;
  private driveLineEnd: Position | null = null;
  private driveStartTime = 0;
  private driveResolve: ((result: DriveResult) => void) | null = null;
  private cteSamples: Meters[] = [];
  private totalEncoderTicks = 0;
  private driveDirectionSign: 1 | -1 = 1;
  // Drive heartbeat — the per-drive diagnostic record.  Captures every
  // contributor to fused pose at ~5 Hz so the next failure can be diagnosed
  // from the log alone.
  private lastHeartbeatMs = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 200;

  // Phase-1 instrumentation: per-run state populated when a drive starts
  // and consumed when the drive completes/aborts.  Null between drives.
  private runInstrumentation: RunInstrumentation | null = null;
  private boundOnMotorFeedback: ((event: MotorFeedbackUpdateEvent) => void) | null = null;
  private boundOnObstructionDetected: ((event: ObstructionDetectedEvent) => void) | null = null;
  private boundOnImuHeading: ((event: ImuHeadingUpdateEvent) => void) | null = null;

  constructor(options: DriveLineControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "DriveLineController" });
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.learningModel = options.learningModel;
    this.motorCalibration = options.motorCalibration ?? null;
    this.fullSpeedCommand = options.fullSpeedCommand ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.settleTimeMs = options.settleTimeMs ?? DRIVE_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.runRecordWriter = options.runRecordWriter ?? null;

    this.onPoseUpdate = this.onPoseUpdate.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Phase-1 instrumentation helpers (no behaviour change).
  // ---------------------------------------------------------------------------

  private generateRunId(nowMs: number): string {
    return `run-${nowMs.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  private safeGetPrimitiveState(): { usingGnssHeading: boolean; gnssPositionAgeMs: number | null; wheelSlipSuspected: boolean } {
    const pf = this.poseFusion as unknown as {
      getPrimitiveState?: () => { usingGnssHeading?: boolean; gnssPositionAgeMs?: number | null; wheelSlipSuspected?: boolean };
    };
    if (typeof pf.getPrimitiveState !== "function") {
      return { usingGnssHeading: false, gnssPositionAgeMs: null, wheelSlipSuspected: false };
    }
    const p = pf.getPrimitiveState() ?? {};
    return {
      usingGnssHeading: p.usingGnssHeading ?? false,
      gnssPositionAgeMs: p.gnssPositionAgeMs ?? null,
      wheelSlipSuspected: p.wheelSlipSuspected ?? false,
    };
  }

  private capturePoseSnapshot(): RunRecordPose {
    const pose = this.poseFusion.getCurrentPose();
    const primitive = this.safeGetPrimitiveState();
    const nowMs = this.nowMillis();
    return {
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
      headingDeg: unwrapInternalHeading(pose.heading),
      quality: pose.quality,
      usingGnssHeading: primitive.usingGnssHeading,
      gnssAgeMs: primitive.gnssPositionAgeMs,
      tMs: nowMs,
    };
  }

  private beginRunInstrumentation(): void {
    const params = this.learningModel.getParameters();
    const cteGainUsed = this.learningModel.getCteGainForDirection(this.driveDirectionSign);
    const brakeDistanceMeters = unwrapMeters(this.getBrakeDistanceForCurrentDrive());
    const isShort =
      this.driveStartPosition !== null &&
      this.driveTargetPosition !== null &&
      unwrapMeters(distanceBetween(this.driveStartPosition, this.driveTargetPosition)) <=
        params.longDriveMinDistanceMeters;

    const anchor = this.capturePoseSnapshot();

    this.runInstrumentation = {
      runId: this.generateRunId(this.nowMillis()),
      anchor,
      brakeTrigger: null,
      peakTickRate: 0,
      pitchAtAnchorDeg: null,
      obstructionSeen: false,
      wheelSlipSeen: false,
      gnssDemotedDuringRun: false,
      lastHeartbeatTickMs: 0,
      heartbeat: [],
      paramsSnapshot: {
        coastDistanceUsedMeters: brakeDistanceMeters,
        cteGainUsed,
        shortBucketUsed: isShort,
      },
    };

    this.boundOnMotorFeedback = (event: MotorFeedbackUpdateEvent) => {
      if (this.runInstrumentation === null) return;
      const tickRate = Math.abs(event.leftEncoderDelta) + Math.abs(event.rightEncoderDelta);
      if (tickRate > this.runInstrumentation.peakTickRate) {
        this.runInstrumentation.peakTickRate = tickRate;
      }
      if (this.runInstrumentation.heartbeat.length > 0) {
        this.applyEncoderDeltasToLatestHeartbeat(event.leftEncoderDelta, event.rightEncoderDelta);
      }
    };
    this.boundOnObstructionDetected = (event: ObstructionDetectedEvent) => {
      if (this.runInstrumentation === null) return;
      this.runInstrumentation.obstructionSeen = true;
      this.logger.warn("drive.line.run_obstruction", { type: event.type });
    };
    this.boundOnImuHeading = (event: ImuHeadingUpdateEvent) => {
      if (this.runInstrumentation === null) return;
      // Latest pitch wins; we keep updating until the run ends so settled
      // pitch could also be sampled from this if needed.
      if (this.runInstrumentation.pitchAtAnchorDeg === null) {
        this.runInstrumentation.pitchAtAnchorDeg = event.pitchDeg;
      }
    };
    // Defensive: real `SensorController` extends EventEmitter, but lightweight
    // test doubles in driveController.test.js do not. Skip subscription rather
    // than crash if `on` is missing.
    const sc = this.sensorController as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    if (typeof sc.on === "function") {
      this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.boundOnMotorFeedback);
      this.sensorController.on(SENSOR_EVENTS.OBSTRUCTION_DETECTED, this.boundOnObstructionDetected);
      this.sensorController.on(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.boundOnImuHeading);
    } else {
      this.boundOnMotorFeedback = null;
      this.boundOnObstructionDetected = null;
      this.boundOnImuHeading = null;
    }
  }

  private applyEncoderDeltasToLatestHeartbeat(left: number, right: number): void {
    if (this.runInstrumentation === null) return;
    const samples = this.runInstrumentation.heartbeat;
    if (samples.length === 0) return;
    const last = samples[samples.length - 1];
    if (last.leftEncoderDelta !== null && last.rightEncoderDelta !== null) return;
    samples[samples.length - 1] = {
      ...last,
      leftEncoderDelta: last.leftEncoderDelta ?? left,
      rightEncoderDelta: last.rightEncoderDelta ?? right,
    };
  }

  private endRunInstrumentationListeners(): void {
    const sc = this.sensorController as unknown as {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const hasOff = typeof sc.off === "function";
    if (this.boundOnMotorFeedback !== null) {
      if (hasOff) this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.boundOnMotorFeedback);
      this.boundOnMotorFeedback = null;
    }
    if (this.boundOnObstructionDetected !== null) {
      if (hasOff) this.sensorController.off(SENSOR_EVENTS.OBSTRUCTION_DETECTED, this.boundOnObstructionDetected);
      this.boundOnObstructionDetected = null;
    }
    if (this.boundOnImuHeading !== null) {
      if (hasOff) this.sensorController.off(SENSOR_EVENTS.IMU_HEADING_UPDATE, this.boundOnImuHeading);
      this.boundOnImuHeading = null;
    }
  }

  private recordRunHeartbeatIfDue(
    pose: Pose,
    cteMeters: number,
    remainingAlongTrackMeters: number,
  ): void {
    if (this.runInstrumentation === null) return;
    const nowMs = this.nowMillis();
    if (
      this.runInstrumentation.lastHeartbeatTickMs !== 0 &&
      nowMs - this.runInstrumentation.lastHeartbeatTickMs < RUN_RECORD_HEARTBEAT_INTERVAL_MS
    ) {
      return;
    }
    this.runInstrumentation.lastHeartbeatTickMs = nowMs;

    if (pose.quality !== "gnss" && this.runInstrumentation.anchor?.quality === "gnss") {
      this.runInstrumentation.gnssDemotedDuringRun = true;
    }

    const primitive = this.safeGetPrimitiveState();
    if (primitive.wheelSlipSuspected) {
      this.runInstrumentation.wheelSlipSeen = true;
    }

    if (this.runInstrumentation.heartbeat.length >= RUN_RECORD_HEARTBEAT_MAX_SAMPLES) return;

    this.runInstrumentation.heartbeat.push({
      tMs: nowMs,
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
      headingDeg: unwrapInternalHeading(pose.heading),
      quality: pose.quality,
      leftEncoderDelta: null,
      rightEncoderDelta: null,
      remainingAlongTrackMeters,
      cteMeters,
    });
  }

  private captureBrakeTriggerSnapshot(
    pose: Pose,
    remainingAlongTrackMeters: number,
    reason: "arrival_tolerance" | "brake_distance",
  ): void {
    if (this.runInstrumentation === null) return;
    const primitive = this.safeGetPrimitiveState();
    this.runInstrumentation.brakeTrigger = {
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
      headingDeg: unwrapInternalHeading(pose.heading),
      quality: pose.quality,
      usingGnssHeading: primitive.usingGnssHeading,
      gnssAgeMs: primitive.gnssPositionAgeMs,
      tMs: this.nowMillis(),
      remainingAlongTrackMeters,
      reason,
    };
  }

  private async emitRunRecord(args: {
    settledPose: RunRecordPose | null;
    finalPosition: Position;
    errorXMeters: number;
    errorYMeters: number;
    avgCteMeters: number;
    maxCteMeters: number;
    durationMs: number;
    status: "success" | "error" | "stopped";
    statusMessage?: string | null;
    learnApplied: boolean;
    learnSkipReason?: string | null;
  }): Promise<void> {
    if (this.runInstrumentation === null) return;
    const inst = this.runInstrumentation;
    if (inst.anchor === null || this.driveTargetPosition === null) return;

    let coastDistanceMeasuredMeters = 0;
    if (inst.brakeTrigger !== null && this.driveLineStart !== null && this.driveLineEnd !== null) {
      const brakePos = createPosition(inst.brakeTrigger.xMeters, inst.brakeTrigger.yMeters);
      const brakeAlong = this.projectAlongTrackDistance(brakePos);
      const finalAlong = this.projectAlongTrackDistance(args.finalPosition);
      coastDistanceMeasuredMeters = finalAlong - brakeAlong;
    }

    const direction = this.driveDirectionSign > 0 ? "forward" : "reverse";
    const settled: RunRecordPose = args.settledPose ?? {
      xMeters: unwrapMeters(args.finalPosition.xMeters),
      yMeters: unwrapMeters(args.finalPosition.yMeters),
      headingDeg: 0,
      quality: "unknown",
      usingGnssHeading: false,
      gnssAgeMs: null,
      tMs: this.nowMillis(),
    };

    const record: RunRecord = {
      runId: inst.runId,
      startedAt: new Date(inst.anchor.tMs).toISOString(),
      directionSign: this.driveDirectionSign,
      direction,
      plannedDistanceMeters: this.driveLineStart !== null && this.driveLineEnd !== null
        ? unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd))
        : 0,
      fullPowerCommand: this.fullSpeedCommand,
      calibrationFingerprintAtRun: null,
      params: inst.paramsSnapshot,
      anchor: inst.anchor,
      lineEnd: {
        xMeters: unwrapMeters(this.driveTargetPosition.xMeters),
        yMeters: unwrapMeters(this.driveTargetPosition.yMeters),
      },
      brakeTrigger: inst.brakeTrigger ?? {
        xMeters: 0,
        yMeters: 0,
        headingDeg: 0,
        quality: "unknown",
        usingGnssHeading: false,
        gnssAgeMs: null,
        tMs: 0,
        remainingAlongTrackMeters: 0,
        reason: "none",
      },
      settled,
      errorXMeters: args.errorXMeters,
      errorYMeters: args.errorYMeters,
      avgCteMeters: args.avgCteMeters,
      maxCteMeters: args.maxCteMeters,
      coastDistanceMeasuredMeters,
      peakTickRate: inst.peakTickRate,
      pitchAtAnchorDeg: inst.pitchAtAnchorDeg,
      durationMs: args.durationMs,
      status: args.status,
      statusMessage: args.statusMessage ?? null,
      events: {
        obstruction: inst.obstructionSeen,
        wheelSlip: inst.wheelSlipSeen,
        gnssDemoted: inst.gnssDemotedDuringRun,
      },
      heartbeat: inst.heartbeat,
      learning: {
        applied: args.learnApplied,
        skipReason: args.learnSkipReason ?? null,
        outlier: false,
      },
    };

    if (inst.gnssDemotedDuringRun) {
      this.logger.warn("drive.line.gnss_quality_lost_during_run", {
        runId: inst.runId,
        anchorQuality: inst.anchor.quality,
        settledQuality: settled.quality,
      });
    }

    this.logger.info("drive.line.run_record", {
      runId: record.runId,
      direction: record.direction,
      plannedDistanceMeters: record.plannedDistanceMeters,
      coastDistanceUsedMeters: record.params.coastDistanceUsedMeters,
      coastDistanceMeasuredMeters: record.coastDistanceMeasuredMeters,
      peakTickRate: record.peakTickRate,
      brakeTriggerPoseAgeMs: record.brakeTrigger.gnssAgeMs,
      anchorQuality: record.anchor.quality,
      brakeQuality: record.brakeTrigger.quality,
      settledQuality: record.settled.quality,
      events: record.events,
      status: record.status,
      learning: record.learning,
    });

    if (this.runRecordWriter !== null) {
      await this.runRecordWriter.append(record);
    }
  }

  executeLineDrive(request: DriveLineRequest): Promise<DriveResult> {
    return new Promise<DriveResult>((resolve) => {
      this.driveResolve = resolve;
      this.startDriveAsync(request).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error("drive.line.error", { error: errorMessage });
        const r = this.driveResolve;
        this.driveResolve = null;
        r?.({
          startPosition: this.driveStartPosition ?? createPosition(0, 0),
          targetPosition: request.targetPosition,
          finalPosition: this.driveStartPosition ?? createPosition(0, 0),
          errorX: createMeters(0),
          errorY: createMeters(0),
          maxCteMeters: createMeters(0),
          avgCteMeters: createMeters(0),
          durationMs: this.nowMillis() - this.driveStartTime,
          brakeDistanceUsed: createMeters(0),
          status: "error",
          errorMessage,
          timestamp: new Date().toISOString(),
          learnApplied: false,
          learnSkipReason: "drive_error",
        });
      });
    });
  }

  private async startDriveAsync(request: DriveLineRequest): Promise<void> {
    let subscribed = false;
    try {
      this.stopRequested = false;
      systemStop.clearStop("drive-line-execute");
      this.currentDrive = request;
      this.driveDirectionSign = request.driveDirectionSign ?? 1;
      this.driveStartTime = this.nowMillis();
      this.cteSamples = [];
      this.totalEncoderTicks = 0;
      this.brakeDecisionPoseQuality = "unknown";

      const startPose = this.poseFusion.getCurrentPose();
      this.driveStartPosition = startPose.position;
      this.driveStartHeading = startPose.heading;
      this.driveStartPoseQuality = startPose.quality;
      this.driveTargetPosition = request.targetPosition;

      // Calibration banner — captures the encoder/wheelbase values that this
      // drive will run with so a corrupted calibration is visible at a glance
      // alongside the failure event.  Plausibility flags pre-empt the
      // post-mortem question "was the wheelbase even sensible?"
      const calibrationDiag = this.poseFusion.getDiagnosticSnapshot().calibration;
      const wheelbasePlausible = calibrationDiag.wheelbaseMeters >= 0.20 && calibrationDiag.wheelbaseMeters <= 1.5;
      const leftMtPlausible = calibrationDiag.leftMetersPerTick >= 1e-5 && calibrationDiag.leftMetersPerTick <= 1e-2;
      const rightMtPlausible = calibrationDiag.rightMetersPerTick >= 1e-5 && calibrationDiag.rightMetersPerTick <= 1e-2;
      this.logger.info("drive.line.calibration_state", {
        leftMetersPerTick: calibrationDiag.leftMetersPerTick,
        rightMetersPerTick: calibrationDiag.rightMetersPerTick,
        wheelbaseMeters: calibrationDiag.wheelbaseMeters,
        plausible: wheelbasePlausible && leftMtPlausible && rightMtPlausible,
        wheelbasePlausible,
        leftMtPlausible,
        rightMtPlausible,
      });

      this.logger.info("drive.line.started", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        targetPosition: {
          x: unwrapMeters(request.targetPosition.xMeters),
          y: unwrapMeters(request.targetPosition.yMeters),
        },
        startHeading: unwrapInternalHeading(this.driveStartHeading),
        driveDirectionSign: this.driveDirectionSign,
      });
      this.lastHeartbeatMs = 0;

      this.driveLineStart = this.driveStartPosition;
      this.driveLineEnd = request.targetPosition;

      this.poseFusion.on("poseUpdate", this.onPoseUpdate);
      subscribed = true;

      this.beginRunInstrumentation();

      this.status = "driving";
      const initialRemainingAlongTrackDistance = unwrapMeters(
        distanceBetween(this.driveLineStart, this.driveLineEnd),
      );
      await this.applyStraightLineControl(startPose, initialRemainingAlongTrackDistance);

      this.logger.info("drive.line.driving", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        heading: unwrapInternalHeading(this.driveStartHeading),
        driveDirectionSign: this.driveDirectionSign,
      });
    } catch (error) {
      if (subscribed) {
        this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      }
      this.endRunInstrumentationListeners();
      this.runInstrumentation = null;
      try {
        await this.sensorController.stopMotors();
      } catch (stopError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        this.logger.warn("drive.line.stop_failed", { error: stopMessage });
      }
      this.status = "idle";
      this.currentDrive = null;
      throw error;
    }
  }

  async runShortDistanceTraining(options?: {
    targetXErrorMeters?: number;
    targetYErrorMeters?: number;
    includeReverseLegs?: boolean;
    startDistanceMeters?: number;
    maxDistanceMeters?: number;
    progressReporter?: DriveTrainingProgressReporter;
    pauseBeforeDriveMs?: number;
  }): Promise<DriveResult[]> {
    const targetXErrorMeters = options?.targetXErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const targetYErrorMeters = options?.targetYErrorMeters ?? DRIVE_SHORT_TARGET_X_ERROR_METERS;
    const includeReverseLegs = options?.includeReverseLegs ?? true;
    const maxDistanceMeters = this.normalizeShortTrainingMaxDistanceMeters(options?.maxDistanceMeters ?? DRIVE_SHORT_BUCKET_MAX_METERS);
    const startDistanceMeters = this.normalizeShortTrainingStartDistanceMeters(options?.startDistanceMeters, maxDistanceMeters);
    const requestedPauseBeforeDriveMs = options?.pauseBeforeDriveMs;
    const pauseBeforeDriveMs = Number.isFinite(requestedPauseBeforeDriveMs)
      ? Math.max(0, requestedPauseBeforeDriveMs ?? 0)
      : 2000;
    const progressReporter = options?.progressReporter;
    const distancePlan = this.buildStraightLineTrainingDistances(startDistanceMeters, maxDistanceMeters);
    const results: DriveResult[] = [];
    const totalPlannedDrives = distancePlan.length * (includeReverseLegs ? 2 : 1);
    this.stopRequested = false;
    systemStop.clearStop("drive-short-training-start");
    this.shortTrainingResults = [];

    const reportProgress = (
      phase: DriveTrainingProgress["phase"],
      message: string,
      details: Partial<DriveTrainingProgress> = {},
    ): void => {
      progressReporter?.({
        mode: "short-distance",
        phase,
        distanceMeters: details.distanceMeters ?? 0,
        pairAttempt: details.pairAttempt ?? 0,
        legAttempt: details.legAttempt ?? 0,
        directionSign: details.directionSign ?? null,
        targetXErrorMeters,
        completedDrives: details.completedDrives ?? results.length,
        totalPlannedDrives,
        message,
        timestamp: new Date().toISOString(),
        resultStatus: details.resultStatus ?? null,
        errorXMeters: details.errorXMeters ?? null,
        absErrorXMeters: details.absErrorXMeters ?? null,
      });
    };

    this.logger.info("drive.line.short_training.started", {
      stepMeters: DRIVE_SHORT_BUCKET_STEP_METERS,
      defaultMaxDistanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
      startDistanceMeters,
      requestedMaxDistanceMeters: maxDistanceMeters,
      targetXErrorMeters,
      includeReverseLegs,
    });
    reportProgress(
      "started",
      `Starting straight-line training from ${Math.round(startDistanceMeters * 100)} cm to ${Math.round(maxDistanceMeters * 100)} cm.`,
      {
        distanceMeters: startDistanceMeters,
      },
    );
    this.sensorController.beginMotionSession();
    try {
      for (const distanceMeters of distancePlan) {
        const directionSigns = includeReverseLegs ? ([1, -1] as const) : ([1] as const);
        let pairAttempt = 0;
        const MAX_PAIR_ATTEMPTS = 10;

        while (pairAttempt < MAX_PAIR_ATTEMPTS) {
          if (systemStop.isStopped()) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              reason: "system_stop",
              distanceMeters,
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              completedDrives: results.length,
            });
            return results;
          }
          if (this.stopRequested) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
            });
            this.stopRequested = false;
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              completedDrives: results.length,
            });
            return results;
          }

          pairAttempt += 1;
          this.logger.info("drive.line.short_training.pair_attempt", {
            distanceMeters,
            pairAttempt,
            includeReverseLegs,
          });
          reportProgress(
            "pair_attempt",
            `Distance ${Math.round(distanceMeters * 100)} cm, pair attempt ${pairAttempt}.`,
            {
              distanceMeters,
              pairAttempt,
              completedDrives: results.length,
            },
          );

        let pairSucceeded = true;
        let legAttempt = 0;

        for (const directionSign of directionSigns) {
          legAttempt += 1;
          if (systemStop.isStopped()) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: "system_stop",
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }
          if (this.stopRequested) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
            });
            this.stopRequested = false;
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }

          reportProgress(
            "waiting",
            `Pausing ${Math.round(pauseBeforeDriveMs / 1000)} seconds before the ${directionSign > 0 ? "forward" : "reverse"} leg starts.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
            },
          );
          const pauseCompleted = await this.sleepWithStopChecks(pauseBeforeDriveMs);
          if (!pauseCompleted || this.stopRequested || systemStop.isStopped()) {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: "pause_interrupted",
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
            });
            return results;
          }

          const anchorPose = this.poseFusion.getCurrentPose();
          const anchorPosition = anchorPose.position;
          const anchorHeadingDegrees = unwrapInternalHeading(anchorPose.heading);
          const anchorHeadingRadians = (anchorHeadingDegrees * Math.PI) / 180;

          const targetPosition = createPosition(
            unwrapMeters(anchorPosition.xMeters) + (directionSign * distanceMeters * Math.cos(anchorHeadingRadians)),
            unwrapMeters(anchorPosition.yMeters) + (directionSign * distanceMeters * Math.sin(anchorHeadingRadians)),
          );

          this.logger.info("drive.line.short_training.attempt", {
            distanceMeters,
            directionSign,
            pairAttempt,
            anchorPosition: {
              x: unwrapMeters(anchorPosition.xMeters),
              y: unwrapMeters(anchorPosition.yMeters),
              heading: anchorHeadingDegrees,
            },
            targetPosition: {
              x: unwrapMeters(targetPosition.xMeters),
              y: unwrapMeters(targetPosition.yMeters),
            },
          });
          reportProgress(
            "leg_attempt",
            `Distance ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} leg running.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
            },
          );

          const result = await this.executeLineDrive({
            targetPosition,
            learningEnabled: true,
            driveDirectionSign: directionSign,
            maxCrossTrackErrorMeters: distanceMeters,
          });
          results.push(result);
          this.shortTrainingResults = [...results];

          const absErrorX = Math.abs(unwrapMeters(result.errorX));
          const absErrorY = Math.abs(unwrapMeters(result.errorY));
          // Pass criterion: both axes within bound. Acceptance is the same
          // for short and long drives — long drives have more time to
          // correct, so the same bound applies.  See feedback memory
          // [[feedback-drive-acceptance]] / [[feedback-tuner-retry]].
          const legSucceeded = absErrorX <= targetXErrorMeters && absErrorY <= targetYErrorMeters;
          pairSucceeded = pairSucceeded && legSucceeded;
          this.logger.info("drive.line.short_training.result", {
            distanceMeters,
            directionSign,
            pairAttempt,
            errorX: unwrapMeters(result.errorX),
            errorY: unwrapMeters(result.errorY),
            absErrorX,
            absErrorY,
            targetXErrorMeters,
            targetYErrorMeters,
            status: result.status,
            legSucceeded,
            pairSucceeded,
          });
          reportProgress(
            "leg_result",
            `Distance ${Math.round(distanceMeters * 100)} cm, pair ${pairAttempt}, ${directionSign > 0 ? "forward" : "reverse"} leg ${result.status}${Number.isFinite(absErrorX) && Number.isFinite(absErrorY) ? `, X ${Math.round(absErrorX * 100)} cm Y ${Math.round(absErrorY * 100)} cm` : ""}.`,
            {
              distanceMeters,
              pairAttempt,
              legAttempt,
              directionSign,
              completedDrives: results.length,
              resultStatus: result.status,
              errorXMeters: unwrapMeters(result.errorX),
              absErrorXMeters: absErrorX,
            },
          );

          if (result.status !== "success") {
            this.logger.warn("drive.line.short_training.stopped", {
              completed: results.length,
              distanceMeters,
              pairAttempt,
              directionSign,
              reason: result.status,
            });
            reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"} (${result.status}).`, {
              distanceMeters,
              pairAttempt,
              directionSign,
              completedDrives: results.length,
              resultStatus: result.status,
            });
            return results;
          }
        }

        if (pairSucceeded) {
          reportProgress(
            "completed",
            `Distance ${Math.round(distanceMeters * 100)} cm completed after pair attempt ${pairAttempt}.`,
            {
              distanceMeters,
              pairAttempt,
              completedDrives: results.length,
            },
          );
          break;
        }

        if (pairAttempt >= MAX_PAIR_ATTEMPTS) {
          this.logger.warn("drive.line.short_training.max_attempts_reached", {
            distanceMeters, pairAttempt,
          });
          reportProgress(
            "completed",
            `Distance ${Math.round(distanceMeters * 100)} cm reached max ${MAX_PAIR_ATTEMPTS} attempts, moving on.`,
            { distanceMeters, pairAttempt, completedDrives: results.length },
          );
          break;
        }

        reportProgress(
          "pair_retry",
          `Distance ${Math.round(distanceMeters * 100)} cm pair attempt ${pairAttempt} missed target, retrying the forward/reverse pair.`,
          {
            distanceMeters,
            pairAttempt,
            completedDrives: results.length,
          },
        );
        const pauseCompleted = await this.sleepWithStopChecks(500);
        if (!pauseCompleted || this.stopRequested || systemStop.isStopped()) {
          this.logger.warn("drive.line.short_training.stopped", {
            completed: results.length,
            distanceMeters,
            pairAttempt,
          });
          reportProgress("stopped", `Short-distance training stopped after ${results.length} drive${results.length === 1 ? "" : "s"}.`, {
            distanceMeters,
            pairAttempt,
            completedDrives: results.length,
          });
          return results;
        }
      }
      }

      this.logger.info("drive.line.short_training.completed", { totalDrives: results.length });
      reportProgress(
        "completed",
        `Straight-line training complete. Ran ${results.length} learning drive${results.length === 1 ? "" : "s"}.`,
        {
          distanceMeters: DRIVE_SHORT_BUCKET_MAX_METERS,
          completedDrives: results.length,
        },
      );
      return results;
    } finally {
      this.sensorController.endMotionSession();
    }
  }

  async stopCurrentDrive(): Promise<void> {
    this.stopRequested = true;
    this.poseFusion.off("poseUpdate", this.onPoseUpdate);
    if (this.currentDrive !== null && this.driveResolve !== null) {
      await this.finishStoppedDrive("Drive stopped by user request");
      return;
    }
    // No drive in flight — just bring the wheels to rest under the ramp
    // profile. The genuine emergency-stop path (operator stop button,
    // stall detection) raises systemStop separately and disables drive
    // there.
    await this.sensorController.stopMotors();
  }

  getState(): DriveControllerState {
    return {
      status: this.status,
      currentDrive: this.currentDrive,
      drivesCompleted: this.drivesCompleted,
      averageErrorXMeters: this.drivesCompleted > 0 ? this.totalErrorXMeters / this.drivesCompleted : 0,
      averageErrorYMeters: this.drivesCompleted > 0 ? this.totalErrorYMeters / this.drivesCompleted : 0,
      shortTrainingProgress: null,
      shortTrainingProgressFeed: [],
      shortTrainingResults: [...this.shortTrainingResults],
      segmentTrainingProgress: null,
      segmentTrainingProgressFeed: [],
      segmentTrainingResults: [],
    };
  }

  getDriveHistory(): DriveResult[] {
    return [...this.driveHistory];
  }

  clearHistory(): void {
    this.driveHistory = [];
    this.drivesCompleted = 0;
    this.totalErrorXMeters = 0;
    this.totalErrorYMeters = 0;
  }

  private async onPoseUpdate(pose: Pose): Promise<void> {
    if (this.poseUpdateInFlight) return;
    if (
      this.status !== "driving" ||
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }
    this.poseUpdateInFlight = true;
    try {
      await this.onPoseUpdateInner(pose);
    } finally {
      this.poseUpdateInFlight = false;
    }
  }

  private async onPoseUpdateInner(pose: Pose): Promise<void> {
    if (
      this.status !== "driving" ||
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }

    if (this.stopRequested) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      try {
        // User-initiated mid-drive stop: bring the wheels to rest under
        // the deceleration profile. Only the emergency-stop path disables
        // drive.
        await this.sensorController.stopMotors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("drive.line.stop_failed", { error: message });
      }
      this.status = "stopped";
      const stoppedDrive = this.currentDrive;
      this.currentDrive = null;
      this.stopRequested = false;
      this.logger.warn("drive.line.stopped", { durationMs: this.nowMillis() - this.driveStartTime });
      const durationMs = this.nowMillis() - this.driveStartTime;
      await this.emitRunRecord({
        settledPose: null,
        finalPosition: pose.position,
        errorXMeters: 0,
        errorYMeters: 0,
        avgCteMeters: 0,
        maxCteMeters: 0,
        durationMs,
        status: "stopped",
        statusMessage: "Drive stopped by user request",
        learnApplied: false,
        learnSkipReason: "drive_stopped",
      });
      this.endRunInstrumentationListeners();
      this.runInstrumentation = null;
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "stopped",
        errorMessage: "Drive stopped by user request",
        timestamp: new Date().toISOString(),
        learnApplied: false,
        learnSkipReason: "drive_stopped",
      });
      this.driveResolve = null;
      return;
    }

    if (systemStop.isStopped()) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      // systemStop is latched: the sensor loop is already re-asserting
      // the H-bridge disable on every tick. We just need to terminate the
      // in-flight drive promise. No motor command needed here.
      this.status = "stopped";
      this.currentDrive = null;
      this.logger.warn("drive.line.stopped", { durationMs: this.nowMillis() - this.driveStartTime, reason: "system_stop" });
      const durationMs = this.nowMillis() - this.driveStartTime;
      await this.emitRunRecord({
        settledPose: null,
        finalPosition: pose.position,
        errorXMeters: 0,
        errorYMeters: 0,
        avgCteMeters: 0,
        maxCteMeters: 0,
        durationMs,
        status: "stopped",
        statusMessage: "Drive stopped by system stop",
        learnApplied: false,
        learnSkipReason: "drive_stopped",
      });
      this.endRunInstrumentationListeners();
      this.runInstrumentation = null;
      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: pose.position,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "stopped",
        errorMessage: "Drive stopped by system stop",
        timestamp: new Date().toISOString(),
        learnApplied: false,
        learnSkipReason: "drive_stopped",
      });
      this.stopRequested = false;
      this.driveResolve = null;
      return;
    }

    const currentPosition = pose.position;
    const cte = crossTrackError(currentPosition, this.driveLineStart, this.driveLineEnd);
    this.cteSamples.push(cte);

    this.emitHeartbeatIfDue(pose, cte);
    {
      const targetDistanceForHb = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
      const projectedAlongTrackForHb = this.projectAlongTrackDistance(currentPosition);
      const remainingForHb = Math.max(0, targetDistanceForHb - projectedAlongTrackForHb);
      this.recordRunHeartbeatIfDue(pose, unwrapMeters(cte), remainingForHb);
    }

    const maxCrossTrackErrorMeters = this.currentDrive?.maxCrossTrackErrorMeters;
    if (
      maxCrossTrackErrorMeters !== undefined &&
      Math.abs(unwrapMeters(cte)) > maxCrossTrackErrorMeters
    ) {
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.finishStoppedDrive("Cross-track error exceeded limit");
      return;
    }

    const targetDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    const projectedAlongTrackDistance = this.projectAlongTrackDistance(currentPosition);
    const remainingAlongTrackDistance = Math.max(0, targetDistance - projectedAlongTrackDistance);
    await this.applyStraightLineControl(pose, remainingAlongTrackDistance);

    // Arrival is the hard stop condition. Braking only helps if there is still
    // enough distance left before the target to make it worthwhile.
    if (remainingAlongTrackDistance <= DRIVE_ARRIVAL_TOLERANCE_METERS) {
      this.brakeDecisionPoseQuality = pose.quality;
      this.captureBrakeTriggerSnapshot(pose, remainingAlongTrackDistance, "arrival_tolerance");
      this.logger.info("drive.line.brake_trigger", {
        reason: "arrival_tolerance",
        elapsedMs: this.nowMillis() - this.driveStartTime,
        remainingAlongTrackMeters: remainingAlongTrackDistance,
        targetDistanceMeters: targetDistance,
        arrivalToleranceMeters: DRIVE_ARRIVAL_TOLERANCE_METERS,
        fusedX: unwrapMeters(pose.position.xMeters),
        fusedY: unwrapMeters(pose.position.yMeters),
        fusedHeadingDeg: unwrapInternalHeading(pose.heading),
      });
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

    const brakeDistance = this.getBrakeDistanceForCurrentDrive();
    if (
      targetDistance > 0 &&
      unwrapMeters(brakeDistance) > 0 &&
      unwrapMeters(brakeDistance) < targetDistance &&
      remainingAlongTrackDistance <= unwrapMeters(brakeDistance)
    ) {
      this.brakeDecisionPoseQuality = pose.quality;
      this.captureBrakeTriggerSnapshot(pose, remainingAlongTrackDistance, "brake_distance");
      this.logger.info("drive.line.brake_trigger", {
        reason: "brake_distance",
        elapsedMs: this.nowMillis() - this.driveStartTime,
        remainingAlongTrackMeters: remainingAlongTrackDistance,
        targetDistanceMeters: targetDistance,
        brakeDistanceMeters: unwrapMeters(brakeDistance),
        fusedX: unwrapMeters(pose.position.xMeters),
        fusedY: unwrapMeters(pose.position.yMeters),
        fusedHeadingDeg: unwrapInternalHeading(pose.heading),
      });
      this.poseFusion.off("poseUpdate", this.onPoseUpdate);
      await this.completeDrive();
      return;
    }

  }

  private normalizeShortTrainingStartDistanceMeters(startDistanceMeters?: number, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number {
    const availableDistances = this.getStraightLineTrainingDistances();
    const requestedDistance = Number.isFinite(startDistanceMeters)
      ? (startDistanceMeters as number)
      : availableDistances[0];
    const boundedMaxDistance = Math.max(availableDistances[0], Math.min(availableDistances.at(-1) ?? DRIVE_SHORT_BUCKET_MAX_METERS, maxDistanceMeters));
    const firstIncludedDistance = availableDistances.find((distance) => distance >= requestedDistance - 1e-9 && distance <= boundedMaxDistance + 1e-9);
    return firstIncludedDistance ?? availableDistances[0];
  }

  private normalizeShortTrainingMaxDistanceMeters(maxDistanceMeters?: number, startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS): number {
    const availableDistances = this.getStraightLineTrainingDistances();
    const requestedDistance = Number.isFinite(maxDistanceMeters)
      ? (maxDistanceMeters as number)
      : (availableDistances.at(-1) ?? DRIVE_SHORT_BUCKET_MAX_METERS);
    const minimumDistance = Math.max(startDistanceMeters, availableDistances[0]);
    const eligibleDistances = availableDistances.filter((distance) => distance >= minimumDistance - 1e-9 && distance <= requestedDistance + 1e-9);
    return eligibleDistances.at(-1) ?? Math.max(minimumDistance, availableDistances[0]);
  }

  private buildStraightLineTrainingDistances(startDistanceMeters = DRIVE_SHORT_BUCKET_STEP_METERS, maxDistanceMeters = DRIVE_SHORT_BUCKET_MAX_METERS): number[] {
    const start = Math.max(DRIVE_SHORT_BUCKET_STEP_METERS, startDistanceMeters);
    const max = Math.max(start, maxDistanceMeters);
    return this.getStraightLineTrainingDistances()
      .filter((distance) => distance >= start - 1e-9 && distance <= max + 1e-9);
  }

  private getStraightLineTrainingDistances(): readonly number[] {
    return [
      ...DRIVE_SHORT_BUCKET_DISTANCES_METERS,
      ...DRIVE_LONG_SAMPLE_DISTANCES_METERS,
    ];
  }

  private async applyStraightLineControl(
    pose: Pose,
    remainingAlongTrackDistance: number,
  ): Promise<void> {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      await this.sensorController.setMotorWheelOutputs(0, 0);
      return;
    }

    const totalDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    if (totalDistance <= 1e-6) {
      await this.sensorController.setMotorWheelOutputs(0, 0);
      return;
    }

    // The "control heading" is the body heading projected forward along the
    // commanded travel direction — the rear of the mower for reverse drives.
    // Steering decisions compare it to the line heading.
    const lineHeading = this.getDriveLineHeading();
    const controlHeading = this.driveDirectionSign > 0
      ? pose.heading
      : createInternalHeading(unwrapInternalHeading(pose.heading) + 180);
    const headingDiff = unwrapRelativeAngle(headingDifference(controlHeading, lineHeading));
    const headingErrorDeg = Math.abs(headingDiff);

    // Large heading errors are recovered by an in-place pivot rather than by
    // trying to steer through them under power.  Skipped in the final
    // approach window so we never pivot right next to the target.
    if (
      headingErrorDeg >= DRIVE_STEERING_ROTATE_TO_HEADING_MIN_ANGLE_DEG &&
      remainingAlongTrackDistance > DRIVE_STEERING_TARGET_INFLUENCE_DISTANCE_METERS
    ) {
      const turnSign = headingDiff >= 0 ? 1 : -1;
      const { leftCommand, rightCommand } = this.calculatePivotCommands(turnSign, false);
      await this.sensorController.setMotorWheelOutputs(leftCommand, rightCommand);
      return;
    }

    // Cross-track error is positive when the mower is to the right of the
    // line (looking from start to end).  We bias the right wheel "forward"
    // and the left wheel "back" by the same amount to rotate the body
    // counterclockwise, pulling it back onto the line.  The same asymmetry
    // applies in reverse — the base command flips sign, the trim direction
    // does not.
    const cte = unwrapMeters(crossTrackError(pose.position, this.driveLineStart, this.driveLineEnd));
    const cteGain = this.learningModel.getCteGainForDirection(this.driveDirectionSign);
    const trim = this.clamp(
      cte * cteGain,
      -DRIVE_STEERING_MAX_TRIM_PERCENT,
      DRIVE_STEERING_MAX_TRIM_PERCENT,
    );

    const baseCommand = this.driveDirectionSign * this.fullSpeedCommand;
    const leftCommand = this.clampNormalizedSpeed(baseCommand - trim);
    const rightCommand = this.clampNormalizedSpeed(baseCommand + trim);
    const normalizedCommands = this.enforceMinimumActiveArcCommands(
      leftCommand,
      rightCommand,
      trim,
    );

    await this.sensorController.setMotorWheelOutputs(
      normalizedCommands.leftCommand,
      normalizedCommands.rightCommand,
    );
  }

  private getDriveLineHeading(): InternalHeading {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      return createInternalHeading(0);
    }

    const dx = unwrapMeters(this.driveLineEnd.xMeters) - unwrapMeters(this.driveLineStart.xMeters);
    const dy = unwrapMeters(this.driveLineEnd.yMeters) - unwrapMeters(this.driveLineStart.yMeters);

    return createInternalHeading((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  /**
   * Heartbeat hook left in place for future diagnostic re-enable.  The
   * 5 Hz log volume previously emitted here was enough to make ssh
   * unresponsive on the Pi, so the body is now empty.
   */
  private emitHeartbeatIfDue(pose: Pose, cte: Meters): void {
    void pose;
    void cte;
  }

  private projectAlongTrackDistance(position: Position): number {
    if (this.driveLineStart === null || this.driveLineEnd === null) {
      return 0;
    }

    const totalDistance = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
    if (totalDistance <= 1e-6) {
      return 0;
    }

    const lineDx = (unwrapMeters(this.driveLineEnd.xMeters) - unwrapMeters(this.driveLineStart.xMeters)) / totalDistance;
    const lineDy = (unwrapMeters(this.driveLineEnd.yMeters) - unwrapMeters(this.driveLineStart.yMeters)) / totalDistance;
    const dx = unwrapMeters(position.xMeters) - unwrapMeters(this.driveLineStart.xMeters);
    const dy = unwrapMeters(position.yMeters) - unwrapMeters(this.driveLineStart.yMeters);
    return dx * lineDx + dy * lineDy;
  }

  private clampNormalizedSpeed(speed: number): number {
    return this.clamp(speed, -this.fullSpeedCommand, this.fullSpeedCommand);
  }

  /**
   * Wheel-command sanity pass. If the trim has flipped one wheel's sign or
   * zeroed it (which would otherwise issue a one-wheel scrub) the controller
   * pivots in place toward the requested rotation direction instead. Otherwise
   * each command is floored at the minimum active output so the motors do not
   * stall on grass.
   */
  private enforceMinimumActiveArcCommands(
    leftCommand: number,
    rightCommand: number,
    trim: number,
  ): { leftCommand: number; rightCommand: number } {
    if (leftCommand === 0 && rightCommand === 0) {
      return { leftCommand: 0, rightCommand: 0 };
    }

    const leftSign = Math.sign(leftCommand);
    const rightSign = Math.sign(rightCommand);
    if (leftSign === 0 || rightSign === 0 || leftSign !== rightSign) {
      const turnSign = trim >= 0 ? 1 : -1;
      return this.calculatePivotCommands(turnSign, true);
    }

    return {
      leftCommand: this.applyMinimumActiveCommand(leftCommand),
      rightCommand: this.applyMinimumActiveCommand(rightCommand),
    };
  }

  private calculatePivotCommands(
    turnSign: 1 | -1,
    followTravelDirection: boolean,
  ): { leftCommand: number; rightCommand: number } {
    const pivotSpeed = Math.max(
      MOTOR_MIN_ACTIVE_OUTPUT_PERCENT,
      DRIVE_STEERING_PIVOT_OUTPUT_PERCENT,
    );
    const directionSign = followTravelDirection ? this.driveDirectionSign : 1;

    return {
      leftCommand: this.clampNormalizedSpeed(-turnSign * pivotSpeed * directionSign),
      rightCommand: this.clampNormalizedSpeed(turnSign * pivotSpeed * directionSign),
    };
  }

  private applyMinimumActiveCommand(command: number): number {
    if (command === 0 || Math.abs(command) >= MOTOR_MIN_ACTIVE_OUTPUT_PERCENT) {
      return command;
    }

    return Math.sign(command) * MOTOR_MIN_ACTIVE_OUTPUT_PERCENT;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private async completeDrive(): Promise<void> {
    if (
      this.driveStartPosition === null ||
      this.driveTargetPosition === null ||
      this.driveLineStart === null ||
      this.driveLineEnd === null
    ) {
      return;
    }

    try {
      this.status = "braking";
      await this.sensorController.requestNeutralMotorOutputs();

      this.logger.info("drive.line.braking", {
        driveDirectionSign: this.driveDirectionSign,
      });

      const rampDownTime = this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
      const rampDownCompleted = await this.sleepWithStopChecks(2 * rampDownTime);
      if (!rampDownCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during ramp-down");
        return;
      }

      this.status = "settling";
      const settleCompleted = await this.sleepWithStopChecks(this.settleTimeMs);
      if (!settleCompleted || this.stopRequested || systemStop.isStopped()) {
        await this.finishStoppedDrive("Drive stopped during settle");
        return;
      }

      this.status = "measuring";
      const finalPose = this.poseFusion.getCurrentPose();
      const finalPosition = finalPose.position;

      const errorX = calculateXError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);
      const maxCte = this.calculateMaxCte();
      const avgCte = this.calculateAvgCte();
      const brakeDistance = this.getBrakeDistanceForCurrentDrive();

      this.logger.info("drive.line.completed", {
        startPosition: {
          x: unwrapMeters(this.driveStartPosition.xMeters),
          y: unwrapMeters(this.driveStartPosition.yMeters),
        },
        targetPosition: {
          x: unwrapMeters(this.driveTargetPosition.xMeters),
          y: unwrapMeters(this.driveTargetPosition.yMeters),
        },
        finalPosition: {
          x: unwrapMeters(finalPosition.xMeters),
          y: unwrapMeters(finalPosition.yMeters),
        },
        errorX: unwrapMeters(errorX),
        errorY: unwrapMeters(errorY),
        maxCte: unwrapMeters(maxCte),
        avgCte: unwrapMeters(avgCte),
        durationMs: this.nowMillis() - this.driveStartTime,
        driveDirectionSign: this.driveDirectionSign,
      });

      const settledPrimitive = this.safeGetPrimitiveState();
      const settledPose: RunRecordPose = {
        xMeters: unwrapMeters(finalPosition.xMeters),
        yMeters: unwrapMeters(finalPosition.yMeters),
        headingDeg: unwrapInternalHeading(finalPose.heading),
        quality: finalPose.quality,
        usingGnssHeading: settledPrimitive.usingGnssHeading,
        gnssAgeMs: settledPrimitive.gnssPositionAgeMs,
        tMs: this.nowMillis(),
      };
      const inst = this.runInstrumentation;
      const coastDistanceMeasuredMeters = inst?.brakeTrigger !== null && inst?.brakeTrigger !== undefined
        ? this.projectAlongTrackDistance(finalPosition) -
          this.projectAlongTrackDistance(createPosition(inst.brakeTrigger.xMeters, inst.brakeTrigger.yMeters))
        : 0;
      const peakTickRate = inst?.peakTickRate ?? 0;
      const brakeTriggerPoseAgeMs = inst?.brakeTrigger?.gnssAgeMs ?? null;

      let learnApplied = false;
      let learnSkipReason: string | undefined;
      if (this.currentDrive?.learningEnabled === false) {
        learnSkipReason = "learning_disabled";
      } else {
        // Pose-quality gate covers anchor / brake-decision / settled.  All
        // three must be GNSS-quality, otherwise the brake timing taught to
        // the learner would compensate for encoder drift rather than the
        // physical coast distance.
        const learningPoseQualityOk =
          this.driveStartPoseQuality === "gnss" &&
          this.brakeDecisionPoseQuality === "gnss" &&
          finalPose.quality === "gnss";
        if (learningPoseQualityOk) {
          this.status = "learning";
          await this.learningModel.updateFromDrive({
            startPosition: this.driveStartPosition,
            targetPosition: this.driveTargetPosition,
            finalPosition,
            driveDirectionSign: this.driveDirectionSign,
            errorX,
            errorY,
            maxCte,
            avgCte,
            brakeDistanceUsed: brakeDistance,
            coastDistanceMeasuredMeters,
            peakTickRate,
            brakeTriggerPoseAgeMs,
            events: inst === null ? undefined : {
              obstruction: inst.obstructionSeen,
              wheelSlip: inst.wheelSlipSeen,
              gnssDemoted: inst.gnssDemotedDuringRun,
            },
          });
          learnApplied = true;
        } else {
          learnSkipReason = "non_gnss_pose_sample";
          this.logger.warn("drive.line.learning_skipped", {
            reason: learnSkipReason,
            startPoseQuality: this.driveStartPoseQuality,
            brakeDecisionPoseQuality: this.brakeDecisionPoseQuality,
            finalPoseQuality: finalPose.quality,
          });
        }

        // Encoder calibration intentionally not updated from line drives.
        // Per the Phase-3 design, encoder calibration is owned by the
        // dead-reckoning workflow only — the prior opportunistic update
        // here could quietly overwrite a clean per-wheel calibration with
        // a worse shared scalar.  Phase 4 introduces the proper
        // arc-aware, per-direction calibration path.
      }
      const durationMs = this.nowMillis() - this.driveStartTime;

      this.status = "idle";
      this.currentDrive = null;
      const result: DriveResult = {
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition,
        errorX,
        errorY,
        maxCteMeters: maxCte,
        avgCteMeters: avgCte,
        durationMs,
        brakeDistanceUsed: brakeDistance,
        status: "success",
        timestamp: new Date().toISOString(),
        learnApplied,
        learnSkipReason,
        startPoseQuality: this.driveStartPoseQuality,
        brakeDecisionPoseQuality: this.brakeDecisionPoseQuality,
        finalPoseQuality: finalPose.quality,
        coastDistanceMeasuredMeters: createMeters(coastDistanceMeasuredMeters),
        peakTickRate,
        brakeTriggerPoseAgeMs,
      };

      await this.emitRunRecord({
        settledPose,
        finalPosition,
        errorXMeters: unwrapMeters(errorX),
        errorYMeters: unwrapMeters(errorY),
        avgCteMeters: unwrapMeters(avgCte),
        maxCteMeters: unwrapMeters(maxCte),
        durationMs,
        status: "success",
        learnApplied,
        learnSkipReason,
      });
      this.endRunInstrumentationListeners();
      this.runInstrumentation = null;

      this.addToHistory(result);
      this.driveResolve?.(result);
      this.driveResolve = null;
    } catch (error) {
      this.status = "idle";
      this.currentDrive = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("drive.line.completion_error", { error: errorMessage });
      try {
        await this.sensorController.stopMotors();
      } catch {
        // Best-effort ramp during a completion error.
      }

      const durationMs = this.nowMillis() - this.driveStartTime;
      await this.emitRunRecord({
        settledPose: null,
        finalPosition: this.driveStartPosition ?? createPosition(0, 0),
        errorXMeters: 0,
        errorYMeters: 0,
        avgCteMeters: 0,
        maxCteMeters: 0,
        durationMs,
        status: "error",
        statusMessage: errorMessage,
        learnApplied: false,
        learnSkipReason: "drive_error",
      });
      this.endRunInstrumentationListeners();
      this.runInstrumentation = null;

      this.driveResolve?.({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition: this.driveStartPosition,
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs,
        brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
        status: "error",
        errorMessage,
        timestamp: new Date().toISOString(),
        learnApplied: false,
        learnSkipReason: "drive_error",
      });
      this.driveResolve = null;
    }
  }

  private async finishStoppedDrive(errorMessage: string): Promise<void> {
    const stoppedDrive = this.currentDrive ?? {
      targetPosition: this.driveTargetPosition ?? createPosition(0, 0),
      learningEnabled: true,
      driveDirectionSign: this.driveDirectionSign,
    };
    const finalPose = this.poseFusion.getCurrentPose();
    const finalPosition = finalPose.position;
    this.status = "stopped";
    this.currentDrive = null;
    this.stopRequested = false;
    // Mid-drive bail-out (CTE limit, user stop, etc.): bring the wheels
    // to rest under the deceleration profile. The emergency-stop path
    // owns the H-bridge disable separately.
    await this.sensorController.stopMotors();
    this.logger.warn("drive.line.stopped", {
      durationMs: this.nowMillis() - this.driveStartTime,
      reason: errorMessage,
      currentDrive: stoppedDrive,
    });
    const durationMs = this.nowMillis() - this.driveStartTime;
    await this.emitRunRecord({
      settledPose: null,
      finalPosition,
      errorXMeters: 0,
      errorYMeters: 0,
      avgCteMeters: 0,
      maxCteMeters: 0,
      durationMs,
      status: "stopped",
      statusMessage: errorMessage,
      learnApplied: false,
      learnSkipReason: "drive_stopped",
    });
    this.endRunInstrumentationListeners();
    this.runInstrumentation = null;

    this.driveResolve?.({
      startPosition: this.driveStartPosition ?? createPosition(0, 0),
      targetPosition: stoppedDrive.targetPosition,
      finalPosition,
      errorX: createMeters(0),
      errorY: createMeters(0),
      maxCteMeters: createMeters(0),
      avgCteMeters: createMeters(0),
      durationMs,
      brakeDistanceUsed: this.getBrakeDistanceForCurrentDrive(),
      status: "stopped",
      errorMessage,
      timestamp: new Date().toISOString(),
      learnApplied: false,
      learnSkipReason: "drive_stopped",
    });
    this.driveResolve = null;
  }

  private calculateMaxCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    let maxAbs = 0;
    for (const cte of this.cteSamples) {
      const mag = Math.abs(unwrapMeters(cte));
      if (mag > maxAbs) {
        maxAbs = mag;
      }
    }
    return createMeters(maxAbs);
  }

  private calculateAvgCte(): Meters {
    if (this.cteSamples.length === 0) {
      return createMeters(0);
    }
    const sum = this.cteSamples.reduce((sum, cte) => sum + Math.abs(unwrapMeters(cte)), 0);
    return createMeters(sum / this.cteSamples.length);
  }

  private addToHistory(result: DriveResult): void {
    this.driveHistory.push(result);
    if (this.driveHistory.length > DRIVE_HISTORY_MAX_SIZE) {
      this.driveHistory.shift();
    }
    this.drivesCompleted++;
    this.totalErrorXMeters += Math.abs(unwrapMeters(result.errorX));
    this.totalErrorYMeters += Math.abs(unwrapMeters(result.errorY));
  }

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    let remainingMs = delayMs;

    while (remainingMs > 0) {
      if (this.stopRequested || systemStop.isStopped()) {
        return false;
      }

      const chunkMs = Math.min(50, remainingMs);
      await this.sleep(chunkMs);
      remainingMs -= chunkMs;
    }

    return true;
  }

  private getBrakeDistanceForCurrentDrive(): Meters {
    if (this.driveStartPosition === null || this.driveTargetPosition === null) {
      return createMeters(this.learningModel.getParameters().longDriveBrakeDistanceMeters ?? 0);
    }

    return this.learningModel.getBrakeDistanceForDrive(
      this.driveStartPosition,
      this.driveTargetPosition,
      this.driveDirectionSign,
    );
  }

}
