import { LineTracker } from "../guidance/lineTracker.js";
import { WheelCommandPlanner } from "../control/wheelCommandPlanner.js";
import { normalizeAngleDegrees } from "../util/angles.js";
import { clamp } from "../util/math.js";
import type { PoseEstimate } from "../estimation/estimatorTypes.js";
import type { WheelTargets } from "../control/controlTypes.js";
import type { LaneExecutionSnapshot, LaneExecutorOptions, LaneMissionSegment, LaneMissionSequence } from "./missionTypes.js";

const ZERO_WHEELS: WheelTargets = {
  leftMetersPerSecond: 0,
  rightMetersPerSecond: 0,
};

export class LaneExecutor {
  private readonly lineTracker: LineTracker;
  private readonly wheelCommandPlanner: WheelCommandPlanner;
  private segmentIndex = 0;
  private settledSinceMillis: number | undefined;

  public constructor(
    private readonly mission: LaneMissionSequence,
    private readonly options: LaneExecutorOptions,
  ) {
    this.lineTracker = new LineTracker({
      nominalSpeedMetersPerSecond: options.lineNominalSpeedMetersPerSecond,
      maxSpeedMetersPerSecond: options.lineMaxSpeedMetersPerSecond,
      crossTrackGain: options.lineCrossTrackGain,
      headingGain: options.lineHeadingGain,
      maxYawRateDegreesPerSecond: options.lineMaxYawRateDegreesPerSecond,
    });
    this.wheelCommandPlanner = new WheelCommandPlanner({
      wheelBaseMeters: options.wheelBaseMeters,
      maxWheelSpeedMetersPerSecond: options.maxWheelSpeedMetersPerSecond,
    });
  }

  public step(currentPose: PoseEstimate, nowMillis: number): LaneExecutionSnapshot {
    const segment = this.mission.segments[this.segmentIndex];
    if (segment === undefined) {
      return {
        activeSegmentId: undefined,
        phase: "complete",
        segmentIndex: this.segmentIndex,
        completed: true,
        wheelTargets: ZERO_WHEELS,
        currentPose,
      };
    }

    const snapshot = this.stepSegment(segment, currentPose, nowMillis);
    if (snapshot.completed) {
      this.segmentIndex += 1;
      this.clearSettled();
      return this.step(currentPose, nowMillis);
    }
    return snapshot;
  }

  private stepSegment(
    segment: LaneMissionSegment,
    currentPose: PoseEstimate,
    nowMillis: number,
  ): LaneExecutionSnapshot {
    switch (segment.kind) {
      case "turn":
        return this.stepTurn(segment, currentPose, nowMillis);
      case "drive":
        return this.stepDrive(segment, currentPose, nowMillis);
      case "arrive":
        return this.stepArrive(segment, currentPose, nowMillis);
    }
  }

  private stepTurn(segment: Extract<LaneMissionSegment, { kind: "turn" }>, currentPose: PoseEstimate, nowMillis: number): LaneExecutionSnapshot {
    const headingErrorDegrees = normalizeAngleDegrees(segment.targetHeadingDegrees - currentPose.headingDegrees);
    const absError = Math.abs(headingErrorDegrees);

    if (absError <= this.options.headingToleranceDegrees) {
      if (this.markSettled(nowMillis)) {
        return {
          activeSegmentId: segment.id,
          phase: "turn_complete",
          segmentIndex: this.segmentIndex,
          completed: true,
          wheelTargets: ZERO_WHEELS,
          targetHeadingDegrees: segment.targetHeadingDegrees,
          currentPose,
        };
      }
      return {
        activeSegmentId: segment.id,
        phase: "turn_settle",
        segmentIndex: this.segmentIndex,
        completed: false,
        wheelTargets: ZERO_WHEELS,
        targetHeadingDegrees: segment.targetHeadingDegrees,
        currentPose,
      };
    }

    this.clearSettled();
    const turnDirection = Math.sign(headingErrorDegrees) || 1;
    const maxSpinWheelSpeed = this.options.maxWheelSpeedMetersPerSecond * this.options.turnGain * 0.55;
    const spinSpeed = clamp(
      absError < 10
        ? (absError / 10) * maxSpinWheelSpeed
        : (absError / 45) * maxSpinWheelSpeed,
      0.05,
      absError < 10 ? maxSpinWheelSpeed * 0.4 : maxSpinWheelSpeed,
    );

    return {
      activeSegmentId: segment.id,
      phase: "turning",
      segmentIndex: this.segmentIndex,
      completed: false,
      wheelTargets: {
        leftMetersPerSecond: -spinSpeed * turnDirection,
        rightMetersPerSecond: spinSpeed * turnDirection,
      },
      targetHeadingDegrees: segment.targetHeadingDegrees,
      currentPose,
    };
  }

  private stepDrive(segment: Extract<LaneMissionSegment, { kind: "drive" }>, currentPose: PoseEstimate, nowMillis: number): LaneExecutionSnapshot {
    const remainingDistanceMeters = Math.hypot(
      segment.targetPose.xMeters - currentPose.xMeters,
      segment.targetPose.yMeters - currentPose.yMeters,
    );

    if (remainingDistanceMeters <= this.options.arrivalToleranceMeters) {
      if (this.markSettled(nowMillis)) {
        return {
          activeSegmentId: segment.id,
          phase: "drive_complete",
          segmentIndex: this.segmentIndex,
          completed: true,
          wheelTargets: ZERO_WHEELS,
          targetPose: segment.targetPose,
          currentPose,
        };
      }
      return {
        activeSegmentId: segment.id,
        phase: "drive_settle",
        segmentIndex: this.segmentIndex,
        completed: false,
        wheelTargets: ZERO_WHEELS,
        targetPose: segment.targetPose,
        currentPose,
      };
    }

    this.clearSettled();
    const intent = this.lineTracker.track(segment.line, currentPose);
    const limitedForwardSpeed = clamp(
      remainingDistanceMeters * 0.9,
      0.08,
      this.options.lineMaxSpeedMetersPerSecond,
    );
    const plannedTargets = this.wheelCommandPlanner.plan({
      ...intent,
      forwardSpeedMetersPerSecond: Math.min(intent.forwardSpeedMetersPerSecond, limitedForwardSpeed),
    });
    return {
      activeSegmentId: segment.id,
      phase: "driving",
      segmentIndex: this.segmentIndex,
      completed: false,
      wheelTargets: plannedTargets,
      targetPose: segment.targetPose,
      currentPose,
    };
  }

  private stepArrive(segment: Extract<LaneMissionSegment, { kind: "arrive" }>, currentPose: PoseEstimate, nowMillis: number): LaneExecutionSnapshot {
    const remainingDistanceMeters = Math.hypot(
      segment.targetPose.xMeters - currentPose.xMeters,
      segment.targetPose.yMeters - currentPose.yMeters,
    );

    if (
      remainingDistanceMeters <= this.options.arrivalToleranceMeters
      && Math.abs(currentPose.speedMetersPerSecond) <= 0.05
    ) {
      if (this.markSettled(nowMillis)) {
        return {
          activeSegmentId: segment.id,
          phase: "arrival_complete",
          segmentIndex: this.segmentIndex,
          completed: true,
          wheelTargets: ZERO_WHEELS,
          targetPose: segment.targetPose,
          currentPose,
        };
      }
    }

    return {
      activeSegmentId: segment.id,
      phase: "arrival_settle",
      segmentIndex: this.segmentIndex,
      completed: false,
      wheelTargets: ZERO_WHEELS,
      targetPose: segment.targetPose,
      currentPose,
    };
  }

  private markSettled(nowMillis: number): boolean {
    if (this.settledSinceMillis === undefined) {
      this.settledSinceMillis = nowMillis;
      return false;
    }
    return (nowMillis - this.settledSinceMillis) >= this.options.settleDurationMillis;
  }

  private clearSettled(): void {
    this.settledSinceMillis = undefined;
  }
}
