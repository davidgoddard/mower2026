import type { Pose2D, PoseEstimate } from "../estimation/estimatorTypes.js";
import type { WheelTargets } from "../control/controlTypes.js";
import { normalizeAngleDegrees } from "../util/angles.js";
import { clamp } from "../util/math.js";
import {
  evaluateLineTrackingError,
  projectPointOntoSegment,
  targetHeadingDegrees,
} from "../guidance/lineGeometry.js";
import type { CalibrationTrialDefinition } from "./calibrationTypes.js";

export interface AutomaticCalibrationControllerOptions {
  readonly maxWheelSpeedMetersPerSecond: number;
  readonly headingToleranceDegrees: number;
  readonly positionToleranceMeters: number;
  readonly settleDurationMillis: number;
}

export interface CalibrationControlSnapshot {
  readonly phase: string;
  readonly targetPose?: Pose2D;
  readonly targetHeadingDegrees?: number;
  readonly headingErrorDegrees?: number;
  readonly crossTrackErrorMeters?: number;
  readonly remainingDistanceMeters?: number;
  readonly completed: boolean;
  readonly wheelTargets: WheelTargets;
}

type ArrivalPhase = "pivot_to_path" | "drive_to_target" | "align_final_heading" | "settle";

const ZERO_WHEELS: WheelTargets = {
  leftMetersPerSecond: 0,
  rightMetersPerSecond: 0,
};

export function resolveRelativeTargetPose(initialPose: Pose2D, targetPose: Pose2D): Pose2D {
  const headingRadians = (initialPose.headingDegrees * Math.PI) / 180;
  const cosHeading = Math.cos(headingRadians);
  const sinHeading = Math.sin(headingRadians);

  return {
    xMeters: initialPose.xMeters + (targetPose.xMeters * cosHeading) - (targetPose.yMeters * sinHeading),
    yMeters: initialPose.yMeters + (targetPose.xMeters * sinHeading) + (targetPose.yMeters * cosHeading),
    headingDegrees: normalizeAngleDegrees(initialPose.headingDegrees + targetPose.headingDegrees),
  };
}

export class AutomaticCalibrationController {
  private readonly initialPose: Pose2D;
  private readonly initialTimestampMillis: number;
  private readonly absoluteTargetPose: Pose2D | undefined;
  private arrivalPhase: ArrivalPhase = "pivot_to_path";
  private settledSinceMillis: number | undefined;

  public constructor(
    private readonly definition: CalibrationTrialDefinition,
    initialEstimate: PoseEstimate,
    private readonly options: AutomaticCalibrationControllerOptions,
  ) {
    this.initialTimestampMillis = initialEstimate.timestampMillis;
    this.initialPose = {
      xMeters: initialEstimate.xMeters,
      yMeters: initialEstimate.yMeters,
      headingDegrees: initialEstimate.headingDegrees,
    };
    this.absoluteTargetPose = definition.targetPose === undefined
      ? undefined
      : resolveRelativeTargetPose(this.initialPose, definition.targetPose);
  }

  public targetPose(): Pose2D | undefined {
    return this.absoluteTargetPose;
  }

  public step(currentEstimate: PoseEstimate, nowMillis: number): CalibrationControlSnapshot {
    switch (this.definition.motion) {
      case "hold":
        return this.stepHold(currentEstimate, nowMillis);
      case "spin":
        return this.stepSpin(currentEstimate, nowMillis);
      case "drive_line":
        return this.stepDriveLine(currentEstimate, nowMillis);
      case "arrive_target":
        return this.stepArriveTarget(currentEstimate, nowMillis);
      default:
        return {
          phase: "unsupported",
          completed: true,
          wheelTargets: ZERO_WHEELS,
        };
    }
  }

  private stepHold(_currentEstimate: PoseEstimate, nowMillis: number): CalibrationControlSnapshot {
    const holdDurationMillis = this.definition.holdDurationMillis ?? 0;
    const elapsedMillis = nowMillis - this.initialPoseTimeMillis();
    return {
      phase: "hold",
      completed: elapsedMillis >= holdDurationMillis,
      remainingDistanceMeters: Math.max(0, (holdDurationMillis - elapsedMillis) / 1000),
      wheelTargets: ZERO_WHEELS,
    };
  }

  private stepSpin(currentEstimate: PoseEstimate, nowMillis: number): CalibrationControlSnapshot {
    const targetHeadingDegrees = normalizeAngleDegrees(
      this.initialPose.headingDegrees + (this.definition.targetHeadingChangeDegrees ?? 0),
    );
    const turn = this.headingTurnCommand(currentEstimate, targetHeadingDegrees, nowMillis, "spin_settle");
    return {
      phase: turn.phase,
      targetHeadingDegrees,
      ...(turn.headingErrorDegrees === undefined ? {} : { headingErrorDegrees: turn.headingErrorDegrees }),
      completed: turn.completed,
      wheelTargets: turn.wheelTargets,
    };
  }

  private stepDriveLine(currentEstimate: PoseEstimate, nowMillis: number): CalibrationControlSnapshot {
    const distanceMeters = this.definition.distanceMeters ?? 0;
    const directionSign = this.definition.direction === "reverse" ? -1 : 1;
    const headingDegrees = normalizeAngleDegrees(this.initialPose.headingDegrees + (directionSign < 0 ? 180 : 0));
    const headingRadians = (headingDegrees * Math.PI) / 180;
    const segment = {
      start: this.initialPose,
      end: {
        xMeters: this.initialPose.xMeters + Math.cos(headingRadians) * distanceMeters,
        yMeters: this.initialPose.yMeters + Math.sin(headingRadians) * distanceMeters,
        headingDegrees,
      },
    };
    const tracking = evaluateLineTrackingError(currentEstimate, segment);
    const projection = projectPointOntoSegment(currentEstimate, segment);
    const remainingDistanceMeters = Math.max(0, distanceMeters - projection.clampedAlongTrackMeters);

    if (
      remainingDistanceMeters <= this.options.positionToleranceMeters
      && Math.abs(tracking.crossTrackErrorMeters) <= 0.08
      && Math.abs(currentEstimate.speedMetersPerSecond) <= 0.05
    ) {
      if (this.markSettled(nowMillis)) {
        return {
          phase: "line_settle",
          targetHeadingDegrees: headingDegrees,
          headingErrorDegrees: tracking.headingErrorDegrees,
          crossTrackErrorMeters: tracking.crossTrackErrorMeters,
          remainingDistanceMeters,
          completed: true,
          wheelTargets: ZERO_WHEELS,
        };
      }
      return {
        phase: "line_settle",
        targetHeadingDegrees: headingDegrees,
        headingErrorDegrees: tracking.headingErrorDegrees,
        crossTrackErrorMeters: tracking.crossTrackErrorMeters,
        remainingDistanceMeters,
        completed: false,
        wheelTargets: ZERO_WHEELS,
      };
    }

    this.clearSettled();

    const speedLimit = this.options.maxWheelSpeedMetersPerSecond * this.definition.profile.speedScale;
    let baseSpeedMagnitude = clamp(remainingDistanceMeters * 0.9, 0.12, speedLimit);
    if (remainingDistanceMeters < 0.25) {
      baseSpeedMagnitude = clamp(remainingDistanceMeters * 1.5, 0.08, speedLimit);
    }
    if (Math.abs(tracking.headingErrorDegrees) > 25) {
      baseSpeedMagnitude *= 0.6;
    }

    const steeringCorrection = clamp(
      (tracking.crossTrackErrorMeters * 1.8) + (tracking.headingErrorDegrees / 24),
      -1.2,
      1.2,
    ) * this.options.maxWheelSpeedMetersPerSecond * 0.22 * this.definition.profile.lineGainScale;

    const baseSpeed = directionSign * baseSpeedMagnitude;
    return {
      phase: "drive_line",
      targetHeadingDegrees: headingDegrees,
      headingErrorDegrees: tracking.headingErrorDegrees,
      crossTrackErrorMeters: tracking.crossTrackErrorMeters,
      remainingDistanceMeters,
      completed: false,
      wheelTargets: {
        leftMetersPerSecond: clamp(baseSpeed - steeringCorrection, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        rightMetersPerSecond: clamp(baseSpeed + steeringCorrection, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
      },
    };
  }

  private stepArriveTarget(currentEstimate: PoseEstimate, nowMillis: number): CalibrationControlSnapshot {
    const targetPose = this.absoluteTargetPose ?? this.initialPose;
    const distanceToTargetMeters = Math.hypot(
      targetPose.xMeters - currentEstimate.xMeters,
      targetPose.yMeters - currentEstimate.yMeters,
    );

    if (this.arrivalPhase === "pivot_to_path") {
      const targetPathHeading = targetHeadingDegrees({
        start: currentEstimate,
        end: targetPose,
      });
      const turn = this.headingTurnCommand(currentEstimate, targetPathHeading, nowMillis, "arrival_pivot_settle");
      if (turn.completed || distanceToTargetMeters < 0.35) {
        this.arrivalPhase = "drive_to_target";
        this.clearSettled();
      }
      return {
        phase: this.arrivalPhase === "pivot_to_path" ? turn.phase : "drive_to_target",
        targetPose,
        targetHeadingDegrees: targetPathHeading,
        ...(turn.headingErrorDegrees === undefined ? {} : { headingErrorDegrees: turn.headingErrorDegrees }),
        remainingDistanceMeters: distanceToTargetMeters,
        completed: false,
        wheelTargets: this.arrivalPhase === "pivot_to_path" ? turn.wheelTargets : ZERO_WHEELS,
      };
    }

    if (this.arrivalPhase === "drive_to_target") {
      const segment = {
        start: this.initialPose,
        end: targetPose,
      };
      const tracking = evaluateLineTrackingError(currentEstimate, segment);
      const distanceHeadingDegrees = targetHeadingDegrees({
        start: currentEstimate,
        end: targetPose,
      });

      if (distanceToTargetMeters <= Math.max(0.12, this.options.positionToleranceMeters * 1.5)) {
        this.arrivalPhase = "align_final_heading";
        this.clearSettled();
        return {
          phase: "align_final_heading",
          targetPose,
          targetHeadingDegrees: targetPose.headingDegrees,
          headingErrorDegrees: normalizeAngleDegrees(targetPose.headingDegrees - currentEstimate.headingDegrees),
          crossTrackErrorMeters: tracking.crossTrackErrorMeters,
          remainingDistanceMeters: distanceToTargetMeters,
          completed: false,
          wheelTargets: ZERO_WHEELS,
        };
      }

      let baseSpeedMagnitude = clamp(distanceToTargetMeters * 0.8, 0.1, this.options.maxWheelSpeedMetersPerSecond * this.definition.profile.speedScale);
      if (Math.abs(tracking.headingErrorDegrees) > 20) {
        baseSpeedMagnitude *= 0.65;
      }
      const steeringCorrection = clamp(
        (tracking.crossTrackErrorMeters * 1.8) + (normalizeAngleDegrees(distanceHeadingDegrees - currentEstimate.headingDegrees) / 24),
        -1.2,
        1.2,
      ) * this.options.maxWheelSpeedMetersPerSecond * 0.22 * this.definition.profile.lineGainScale;

      return {
        phase: "drive_to_target",
        targetPose,
        targetHeadingDegrees: distanceHeadingDegrees,
        headingErrorDegrees: normalizeAngleDegrees(distanceHeadingDegrees - currentEstimate.headingDegrees),
        crossTrackErrorMeters: tracking.crossTrackErrorMeters,
        remainingDistanceMeters: distanceToTargetMeters,
        completed: false,
        wheelTargets: {
          leftMetersPerSecond: clamp(baseSpeedMagnitude - steeringCorrection, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
          rightMetersPerSecond: clamp(baseSpeedMagnitude + steeringCorrection, -this.options.maxWheelSpeedMetersPerSecond, this.options.maxWheelSpeedMetersPerSecond),
        },
      };
    }

    const finalTurn = this.headingTurnCommand(currentEstimate, targetPose.headingDegrees, nowMillis, "arrival_final_settle");
    const finalHeadingErrorDegrees = normalizeAngleDegrees(targetPose.headingDegrees - currentEstimate.headingDegrees);
    if (
      this.arrivalPhase === "align_final_heading"
      && distanceToTargetMeters <= this.options.positionToleranceMeters
      && Math.abs(finalHeadingErrorDegrees) <= this.options.headingToleranceDegrees
      && Math.abs(currentEstimate.speedMetersPerSecond) <= 0.05
      && Math.abs(currentEstimate.yawRateDegreesPerSecond) <= 4
    ) {
      if (this.markSettled(nowMillis)) {
        this.arrivalPhase = "settle";
        return {
          phase: "arrival_complete",
          targetPose,
          targetHeadingDegrees: targetPose.headingDegrees,
          headingErrorDegrees: finalHeadingErrorDegrees,
          remainingDistanceMeters: distanceToTargetMeters,
          completed: true,
          wheelTargets: ZERO_WHEELS,
        };
      }
      return {
        phase: "arrival_final_settle",
        targetPose,
        targetHeadingDegrees: targetPose.headingDegrees,
        headingErrorDegrees: finalHeadingErrorDegrees,
        remainingDistanceMeters: distanceToTargetMeters,
        completed: false,
        wheelTargets: ZERO_WHEELS,
      };
    }

    return {
      phase: finalTurn.phase,
      targetPose,
      targetHeadingDegrees: targetPose.headingDegrees,
      headingErrorDegrees: finalHeadingErrorDegrees,
      remainingDistanceMeters: distanceToTargetMeters,
      completed: false,
      wheelTargets: finalTurn.wheelTargets,
    };
  }

  private headingTurnCommand(
    currentEstimate: PoseEstimate,
    targetHeadingDegrees: number,
    nowMillis: number,
    settlePhase: string,
  ): CalibrationControlSnapshot {
    const headingErrorDegrees = normalizeAngleDegrees(targetHeadingDegrees - currentEstimate.headingDegrees);
    const absHeadingErrorDegrees = Math.abs(headingErrorDegrees);

    if (absHeadingErrorDegrees <= this.options.headingToleranceDegrees && Math.abs(currentEstimate.yawRateDegreesPerSecond) <= 4) {
      if (this.markSettled(nowMillis)) {
        return {
          phase: settlePhase,
          targetHeadingDegrees,
          headingErrorDegrees,
          completed: true,
          wheelTargets: ZERO_WHEELS,
        };
      }
      return {
        phase: settlePhase,
        targetHeadingDegrees,
        headingErrorDegrees,
        completed: false,
        wheelTargets: ZERO_WHEELS,
      };
    }

    this.clearSettled();

    const turnDirection = Math.sign(headingErrorDegrees) || 1;
    const maxSpinWheelSpeed = this.options.maxWheelSpeedMetersPerSecond * this.definition.profile.turnScale * 0.55;
    let spinWheelSpeed = clamp((absHeadingErrorDegrees / 45) * maxSpinWheelSpeed, 0.07, maxSpinWheelSpeed);
    if (absHeadingErrorDegrees < 10) {
      spinWheelSpeed = clamp((absHeadingErrorDegrees / 10) * maxSpinWheelSpeed, 0.05, maxSpinWheelSpeed * 0.4);
    }

    return {
      phase: "turning",
      targetHeadingDegrees,
      headingErrorDegrees,
      completed: false,
      wheelTargets: {
        leftMetersPerSecond: -turnDirection * spinWheelSpeed,
        rightMetersPerSecond: turnDirection * spinWheelSpeed,
      },
    };
  }

  private initialPoseTimeMillis(): number {
    return this.initialTimestampMillis;
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
