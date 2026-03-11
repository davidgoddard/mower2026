import type { BusAdapter } from "../bus/busAdapter.js";
import type { GnssNodeClient } from "../nodes/gnssNodeClient.js";
import type { MotorNodeClient } from "../nodes/motorNodeClient.js";
import type { ParameterStore } from "../config/parameterStore.js";
import type { GnssAdapter } from "../sensing/gnssAdapter.js";
import type { MotorFeedbackAdapter } from "../sensing/motorFeedbackAdapter.js";
import type { PoseEstimator } from "../estimation/poseEstimator.js";
import type { LineTracker } from "../guidance/lineTracker.js";
import type { LineSegment } from "../guidance/guidanceTypes.js";
import type { WheelCommandPlanner } from "../control/wheelCommandPlanner.js";
import type { CommandLimiter } from "../control/commandLimiter.js";
import type { WheelTargets } from "../control/controlTypes.js";
import { mapPhysicalWheelTargetsToRaw } from "../control/motorMapping.js";
import type { EventLogger } from "../logging/eventLogger.js";
import type { TelemetryLogger } from "../logging/telemetryLogger.js";
import type { SafetyManager } from "../safety/safetyManager.js";
import type { PoseEstimate } from "../estimation/estimatorTypes.js";
import type { ImuSensor, RawImuSample } from "../sensing/imuSensor.js";
import type { MeasurementBundle } from "../sensing/measurementTypes.js";

export interface RuntimeAppDependencies {
  readonly bus: BusAdapter;
  readonly gnssNodeClient: GnssNodeClient;
  readonly motorNodeClient: MotorNodeClient;
  readonly gnssAdapter: GnssAdapter;
  readonly motorFeedbackAdapter: MotorFeedbackAdapter;
  readonly poseEstimator: PoseEstimator;
  readonly lineTracker: LineTracker;
  readonly wheelCommandPlanner: WheelCommandPlanner;
  readonly commandLimiter: CommandLimiter;
  readonly parameterStore: ParameterStore;
  readonly telemetryLogger: TelemetryLogger;
  readonly eventLogger: EventLogger;
  readonly safetyManager: SafetyManager;
  readonly imuSensor?: ImuSensor;
  readonly imuAdapter?: {
    adapt(sample: RawImuSample): MeasurementBundle;
  };
}

export class RuntimeApp {
  private activeSegment: LineSegment | undefined;
  private lastWheelTargets: WheelTargets = {
    leftMetersPerSecond: 0,
    rightMetersPerSecond: 0,
  };

  public constructor(private readonly deps: RuntimeAppDependencies) {}

  public async initialise(): Promise<void> {
    await this.deps.parameterStore.load();
    this.deps.eventLogger.log("runtime.initialised", {
      parameterRevision: this.deps.parameterStore.currentRevision(),
    });
  }

  public setActiveSegment(segment: LineSegment): void {
    this.activeSegment = segment;
  }

  public async runCycle(): Promise<PoseEstimate> {
    const gnssBundle = this.deps.gnssAdapter.adapt(await this.deps.gnssNodeClient.refresh());
    const motorBundle = this.deps.motorFeedbackAdapter.adapt(await this.deps.motorNodeClient.refreshFeedback());
    const imuBundle = this.deps.imuSensor !== undefined && this.deps.imuAdapter !== undefined
      ? this.deps.imuAdapter.adapt(await this.deps.imuSensor.read())
      : undefined;

    this.deps.poseEstimator.ingest(motorBundle);
    if (imuBundle !== undefined) {
      this.deps.poseEstimator.ingest(imuBundle);
    }
    const estimate = this.deps.poseEstimator.ingest(gnssBundle);

    this.deps.telemetryLogger.append("pose.estimate", estimate as unknown as Record<string, unknown>);

    const safetyDecision = this.deps.safetyManager.evaluate({
      gnss: gnssBundle,
      motor: motorBundle,
    });
    if (!safetyDecision.allowMotion || this.activeSegment === undefined) {
      this.deps.eventLogger.log("runtime.motion_inhibited", {
        reason: safetyDecision.reason ?? "no_active_segment",
      });
      await this.deps.motorNodeClient.sendWheelSpeedCommand({
        timestampMillis: estimate.timestampMillis,
        leftWheelTargetMetersPerSecond: 0,
        rightWheelTargetMetersPerSecond: 0,
        enableDrive: false,
        commandTimeoutMillis: 250,
      });
      return estimate;
    }

    const motionIntent = this.deps.lineTracker.track(this.activeSegment, estimate);
    const plannedTargets = this.deps.wheelCommandPlanner.plan(motionIntent);
    const rawTargets = mapPhysicalWheelTargetsToRaw(this.deps.parameterStore.get(), plannedTargets);
    const wheelTargets = this.deps.commandLimiter.limit(this.lastWheelTargets, rawTargets);
    this.lastWheelTargets = wheelTargets;

    await this.deps.motorNodeClient.sendWheelSpeedCommand({
      timestampMillis: estimate.timestampMillis,
      leftWheelTargetMetersPerSecond: wheelTargets.leftMetersPerSecond,
      rightWheelTargetMetersPerSecond: wheelTargets.rightMetersPerSecond,
      enableDrive: true,
      commandTimeoutMillis: 250,
      maxAccelerationMetersPerSecondSquared: this.deps.parameterStore.get().maxWheelAccelerationMetersPerSecondSquared,
      maxDecelerationMetersPerSecondSquared: this.deps.parameterStore.get().maxWheelDecelerationMetersPerSecondSquared,
    });

    return estimate;
  }
}
