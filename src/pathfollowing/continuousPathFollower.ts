import { DRIVE_FULL_SPEED_COMMAND_DEFAULT, MOTOR_RAMP_DOWN_TIME_MS } from "../constants.js";
import { PathFollowingParameters, DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";
import { crossTrackError, angleTo, Pose, Position, unwrapMeters, createPosition } from "../geometry/positionTypes.js";
import { headingDifference, unwrapRelativeAngle } from "../geometry/headingTypes.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { systemStop } from "../control/systemStop.js";
import { defaultSleep } from "../control/sleep.js";
import { PathFollowResult, PathPoint } from "./pathFollowerApi.js";
import { advancePassedTargets } from "./segmentedBoundaryExecutor.js";
import { planConservativeRouteLookahead } from "./conservativeLookahead.js";
import type { DriveLearningModel } from "../control/driveLearningModel.js";
import type { DriveController } from "../control/driveController.js";
import type { TurnController } from "../control/turnController.js";

const CONTINUOUS_CONTROL_INTERVAL_MS = 20;
const CONTINUOUS_TRACE_SPEED = 1.0;
const CONTINUOUS_TRACE_SPEED_MIN = 0.5;
const CONTINUOUS_TRACE_SPEED_CURVE_GAIN = 0.006;
const CONTINUOUS_TRACE_SPEED_HEADING_GAIN = 0.003;
const CONTINUOUS_TRACE_SPEED_CTE_GAIN = 0.9;
const CONTINUOUS_CORNER_LOOKAHEAD_LIMIT_DEG = 20;
const CONTINUOUS_CTE_GAIN = 1.8;
const CONTINUOUS_HEADING_GAIN = 0.02;
const CONTINUOUS_MAX_WHEEL_COMMAND_DELTA_PER_SECOND = 0.8;
const CONTINUOUS_CORNER_CAPTURE_DISTANCE_METERS = 0.4;
const CONTINUOUS_ORDERED_PROJECTION_FORWARD_WINDOW_METERS = 0.5;
const CONTINUOUS_ROUTE_DEVIATION_CONFIRMATION_SAMPLES = 10;
const CONTINUOUS_ROUTE_DEVIATION_IMMEDIATE_ABORT_MULTIPLIER = 2;

export interface ContinuousPathFollowerOptions {
  readonly sensorController: SensorController;
  readonly poseFusion: PoseFusion;
  readonly driveController: DriveController;
  readonly turnController: TurnController;
  readonly logger: LoggerScope;
  readonly baseSpeed?: number;
  readonly learningModel?: DriveLearningModel;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface ContinuousPathExecutionOptions {
  readonly parameters?: PathFollowingParameters;
  readonly preserveFirstTargetAtPose?: boolean;
  readonly loopPath?: boolean;
  /**
   * When true, projection is limited to the current local segment window so a
   * pose that is geometrically near some later non-adjacent segment cannot jump
   * progress far ahead in the ordered path.
   */
  readonly strictOrderedProgress?: boolean;
  readonly pivotAtWaypointTurnDeg?: number;
  readonly pivotAtWaypointDistanceMeters?: number;
  readonly minimumSpeed?: number;
  readonly maximumSpeed?: number;
  /** Pre-analysed complete-route lookahead, persisted across mowing resume. */
  readonly routeLookaheadMeters?: number;
  /**
   * Finish an ordered finite path once its final target is active and the
   * mower is back within this distance of that target. Intended for complete
   * perimeter loops whose final recorded chord may be much shorter than the
   * vehicle can usefully follow.
   */
  readonly completionToleranceMeters?: number;
  /** Resume an interrupted ordered follow from this target index. */
  readonly initialTargetIndex?: number;
}

export interface ContinuousPathFollowResult extends PathFollowResult {
  readonly algorithm: "continuous_path_follow";
  readonly pointCount: number;
  readonly completedWaypoints: number;
}

export class ContinuousPathFollower {
  private readonly sensorController: SensorController;
  private readonly poseFusion: PoseFusion;
  private readonly driveController: DriveController;
  private readonly turnController: TurnController;
  private readonly logger: LoggerScope;
  private readonly baseSpeed: number;
  private readonly learningModel: DriveLearningModel | null;
  private readonly sleep: (delayMs: number) => Promise<void>;
  constructor(options: ContinuousPathFollowerOptions) {
    this.sensorController = options.sensorController;
    this.poseFusion = options.poseFusion;
    this.driveController = options.driveController;
    this.turnController = options.turnController;
    this.logger = options.logger;
    this.baseSpeed = Math.max(0.2, Math.min(DRIVE_FULL_SPEED_COMMAND_DEFAULT, options.baseSpeed ?? CONTINUOUS_TRACE_SPEED));
    this.learningModel = options.learningModel ?? null;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async executePath(
    points: PathPoint[],
    options: ContinuousPathExecutionOptions = {},
  ): Promise<ContinuousPathFollowResult> {
    const parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
    const pathPoints = normalizePathPoints(points, options.loopPath ?? true);
    if (pathPoints.length < 2) {
      return {
        algorithm: "continuous_path_follow",
        completed: false,
        reason: "error",
        error: "continuous_path_too_short",
        pointCount: pathPoints.length,
        completedWaypoints: 0,
      };
    }

    let currentIndex = clampIndex(options.initialTargetIndex ?? 0, pathPoints.length);
    let preserveCurrentTargetAtPose = currentIndex === 0 && (options.preserveFirstTargetAtPose ?? false);
    let appliedLeftCommand = 0;
    let appliedRightCommand = 0;
    let consecutiveRouteDeviationSamples = 0;
    const analysedLookaheadPlan = planConservativeRouteLookahead(pathPoints, {
      minimumLookaheadMeters: parameters.continuousPathMinimumLookaheadMeters,
      maximumLookaheadMeters: parameters.continuousPathMaximumLookaheadMeters,
      maximumPathDeviationMeters: parameters.continuousPathMaximumChordDeviationMeters,
      loopPath: options.loopPath ?? true,
    });
    const lookaheadPlan = Number.isFinite(options.routeLookaheadMeters)
      ? {
        ...analysedLookaheadPlan,
        lookaheadMeters: Math.max(
          parameters.continuousPathMinimumLookaheadMeters,
          Math.min(parameters.continuousPathMaximumLookaheadMeters, options.routeLookaheadMeters ?? 0),
        ),
      }
      : analysedLookaheadPlan;
    this.logger.info("continuous_path.lookahead_planned", lookaheadPlan);

    const cumulativeDistances = buildCumulativeDistances(pathPoints);
    const entryPose = this.poseFusion.getCurrentPose();
    const alreadyWithinCompletionTolerance = Number.isFinite(options.completionToleranceMeters)
      && currentIndex >= pathPoints.length - 1
      && distanceFromPoseToPoint(entryPose, pathPoints[pathPoints.length - 1])
        <= Math.max(0, options.completionToleranceMeters ?? 0);
    if (!alreadyWithinCompletionTolerance) {
      const entryProjection = projectPoseOntoPath(
        pathPoints,
        entryPose,
        currentIndex,
        options.strictOrderedProgress ?? false,
      );
      const entryGuidance = buildContinuousGuidance(
        pathPoints,
        cumulativeDistances,
        entryProjection,
        lookaheadPlan.lookaheadMeters,
      );
      const entryHeading = angleTo(entryPose.position, pointToPosition(entryGuidance.lookaheadTarget));
      const entryHeadingError = headingDifference(entryPose.heading, entryHeading);
      const entryHeadingErrorDeg = unwrapRelativeAngle(entryHeadingError);
      const maximumEntryAlignmentDistanceMeters = Math.max(
        parameters.mowingStandoffMeters,
        parameters.continuousPathMinimumLookaheadMeters,
      );
      if (
        entryProjection.distanceToPathMeters <= maximumEntryAlignmentDistanceMeters
        && Math.abs(entryHeadingErrorDeg) > parameters.turnAlignmentThresholdDeg
      ) {
        this.logger.info("continuous_path.entry_alignment_started", {
          headingErrorDeg: entryHeadingErrorDeg,
          lookaheadX: entryGuidance.lookaheadTarget.xMeters,
          lookaheadY: entryGuidance.lookaheadTarget.yMeters,
        });
        const turnResult = await this.turnController.executeTurn({
          targetAngle: entryHeadingError,
          direction: entryHeadingErrorDeg >= 0 ? "ccw" : "cw",
          learningEnabled: false,
        });
        if (turnResult.status !== "success") {
          return {
            algorithm: "continuous_path_follow",
            completed: false,
            reason: turnResult.status === "stopped" ? "user_stopped" : "error",
            error: turnResult.errorMessage ?? "continuous_path_entry_alignment_failed",
            pointCount: pathPoints.length,
            completedWaypoints: currentIndex,
          };
        }
        this.logger.info("continuous_path.entry_alignment_completed", {
          headingErrorDeg: entryHeadingErrorDeg,
        });
      }
    }

    this.sensorController.beginMotionSession();
    try {
      while (currentIndex < pathPoints.length) {
        if (systemStop.isStopped()) {
          await this.sensorController.requestNeutralMotorOutputs();
          return {
            algorithm: "continuous_path_follow",
            completed: false,
            reason: "user_stopped",
            pointCount: pathPoints.length,
            completedWaypoints: currentIndex,
          };
        }

        const pose = this.poseFusion.getCurrentPose();
        const completionToleranceMeters = options.completionToleranceMeters;
        if (
          Number.isFinite(completionToleranceMeters)
          && currentIndex >= pathPoints.length - 1
          && distanceFromPoseToPoint(pose, pathPoints[pathPoints.length - 1])
            <= Math.max(0, completionToleranceMeters ?? 0)
        ) {
          this.logger.info("continuous_path.completion_proximity_reached", {
            currentIndex,
            finalTargetIndex: pathPoints.length - 1,
            distanceMeters: distanceFromPoseToPoint(pose, pathPoints[pathPoints.length - 1]),
            toleranceMeters: completionToleranceMeters,
          });
          break;
        }
        currentIndex = advancePassedTargets(
          pathPoints,
          pose,
          currentIndex,
          parameters,
          preserveCurrentTargetAtPose,
          options.loopPath ?? true,
        );
        preserveCurrentTargetAtPose = false;
        if (currentIndex >= pathPoints.length) {
          break;
        }

        const projection = projectPoseOntoPath(
          pathPoints,
          pose,
          currentIndex,
          options.strictOrderedProgress ?? false,
        );
        const maximumRouteJoinDistanceMeters = Math.max(
          parameters.mowingStandoffMeters,
          parameters.continuousPathMinimumLookaheadMeters,
        );
        if (projection.distanceToPathMeters > maximumRouteJoinDistanceMeters) {
          consecutiveRouteDeviationSamples += 1;
          if (consecutiveRouteDeviationSamples === 1) {
            this.logger.warn("continuous_path.route_deviation_detected", {
              currentIndex,
              projectionSegmentStartIndex: projection.segmentStartIndex,
              distanceToPathMeters: projection.distanceToPathMeters,
              maximumRouteJoinDistanceMeters,
            });
          }
        } else {
          if (consecutiveRouteDeviationSamples > 0) {
            this.logger.info("continuous_path.route_deviation_cleared", {
              sampleCount: consecutiveRouteDeviationSamples,
              distanceToPathMeters: projection.distanceToPathMeters,
            });
          }
          consecutiveRouteDeviationSamples = 0;
        }
        const immediateDeviationAbortDistanceMeters = maximumRouteJoinDistanceMeters
          * CONTINUOUS_ROUTE_DEVIATION_IMMEDIATE_ABORT_MULTIPLIER;
        if (
          projection.distanceToPathMeters > immediateDeviationAbortDistanceMeters
          || consecutiveRouteDeviationSamples >= CONTINUOUS_ROUTE_DEVIATION_CONFIRMATION_SAMPLES
        ) {
          this.logger.warn("continuous_path.pose_too_far_from_route", {
            currentIndex,
            projectionSegmentStartIndex: projection.segmentStartIndex,
            distanceToPathMeters: projection.distanceToPathMeters,
            maximumRouteJoinDistanceMeters,
            consecutiveRouteDeviationSamples,
            immediateDeviationAbortDistanceMeters,
          });
          return {
            algorithm: "continuous_path_follow",
            completed: false,
            reason: "error",
            error: "continuous_path_pose_too_far_from_route",
            pointCount: pathPoints.length,
            completedWaypoints: currentIndex,
          };
        }
        currentIndex = Math.max(currentIndex, projection.segmentStartIndex + 1);
        const cornerVertexIndex = projection.segmentStartIndex + 1;
        if (
          Number.isFinite(options.pivotAtWaypointTurnDeg)
          && Number.isFinite(options.pivotAtWaypointDistanceMeters)
          && cornerVertexIndex < pathPoints.length - 1
          && isCornerAtLeast(pathPoints, cornerVertexIndex, Math.abs(options.pivotAtWaypointTurnDeg ?? 0))
          && distanceFromPoseToPoint(pose, pathPoints[cornerVertexIndex])
            <= Math.max(0, options.pivotAtWaypointDistanceMeters ?? 0)
        ) {
          await this.sensorController.requestNeutralMotorOutputs();
          appliedLeftCommand = 0;
          appliedRightCommand = 0;
          await this.sleep(MOTOR_RAMP_DOWN_TIME_MS * 2);
          const cornerCaptureTarget = buildCommittedCornerCaptureTarget(
            pathPoints[cornerVertexIndex],
            pathPoints[cornerVertexIndex + 1],
          );
          this.logger.info("continuous_path.corner_align_started", {
            vertexIndex: cornerVertexIndex,
            cornerX: pathPoints[cornerVertexIndex].xMeters,
            cornerY: pathPoints[cornerVertexIndex].yMeters,
            captureTargetX: cornerCaptureTarget.xMeters,
            captureTargetY: cornerCaptureTarget.yMeters,
          });
          const cornerResult = await this.driveController.executeDrive({
            targetPosition: createPosition(cornerCaptureTarget.xMeters, cornerCaptureTarget.yMeters),
            learningEnabled: false,
            maxCrossTrackErrorMeters: parameters.segmentedDriveMaxCteMeters,
            alwaysTurnToFaceTarget: true,
            minimumDriveDistanceMeters: Math.max(
              parameters.mowingStandoffMeters,
              parameters.segmentedDriveMinSegmentLengthMeters,
            ),
            maximumWheelOutputPercent: options.maximumSpeed,
          });
          if (cornerResult.status !== "success") {
            this.logger.warn("continuous_path.corner_drive_failed", {
              vertexIndex: cornerVertexIndex,
              status: cornerResult.status,
              error: cornerResult.errorMessage,
            });
            return {
              algorithm: "continuous_path_follow",
              completed: false,
              reason: cornerResult.status === "stopped" ? "user_stopped" : "error",
              error: cornerResult.errorMessage ?? "continuous_path_corner_drive_failed",
              pointCount: pathPoints.length,
              completedWaypoints: currentIndex,
            };
          }
          currentIndex = cornerVertexIndex + 1;
          this.logger.info("continuous_path.corner_drive_completed", {
            vertexIndex: cornerVertexIndex,
            nextTargetIndex: currentIndex,
          });
          continue;
        }

        const guidance = buildContinuousGuidance(
          pathPoints,
          cumulativeDistances,
          projection,
          lookaheadPlan.lookaheadMeters,
        );
        const executionBaseSpeed = Math.max(
          0.2,
          Math.min(this.baseSpeed, options.maximumSpeed ?? this.baseSpeed),
        );
        const computedCommands = computeContinuousPathWheelCommands(
          pose,
          guidance.segmentStart,
          guidance.segmentEnd,
          guidance.lookaheadTarget,
          executionBaseSpeed,
          {
            minimumSpeed: options.minimumSpeed,
            cteGain: this.learningModel?.getCteGainForDirection(1),
            headingGain: this.learningModel?.getLongHeadingGainForDirection(1),
          },
        );
        const requestedCommands = capContinuousWheelCommands(
          computedCommands,
          options.maximumSpeed,
        );
        appliedLeftCommand = limitContinuousWheelCommandChange(
          appliedLeftCommand,
          requestedCommands.left,
          CONTINUOUS_MAX_WHEEL_COMMAND_DELTA_PER_SECOND,
          CONTINUOUS_CONTROL_INTERVAL_MS / 1000,
        );
        appliedRightCommand = limitContinuousWheelCommandChange(
          appliedRightCommand,
          requestedCommands.right,
          CONTINUOUS_MAX_WHEEL_COMMAND_DELTA_PER_SECOND,
          CONTINUOUS_CONTROL_INTERVAL_MS / 1000,
        );

        this.logger.debug("continuous_path.control", {
          currentIndex,
          projectionSegmentStartIndex: projection.segmentStartIndex,
          distanceAlongPathMeters: projection.distanceAlongPathMeters,
          currentTargetX: guidance.segmentEnd.xMeters,
          currentTargetY: guidance.segmentEnd.yMeters,
          lookaheadX: guidance.lookaheadTarget.xMeters,
          lookaheadY: guidance.lookaheadTarget.yMeters,
          requestedLeft: requestedCommands.left,
          requestedRight: requestedCommands.right,
          left: appliedLeftCommand,
          right: appliedRightCommand,
          pivoting: false,
        });
        await this.sensorController.setMotorWheelOutputs(appliedLeftCommand, appliedRightCommand);
        await this.sleep(CONTINUOUS_CONTROL_INTERVAL_MS);
      }

      return {
        algorithm: "continuous_path_follow",
        completed: true,
        reason: "reached_end",
        pointCount: pathPoints.length,
        completedWaypoints: pathPoints.length,
      };
    } catch (error) {
      return {
        algorithm: "continuous_path_follow",
        completed: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
        pointCount: pathPoints.length,
        completedWaypoints: currentIndex,
      };
    } finally {
      // Motor outputs are stateful in the sensor loop. Every return path,
      // including deliberate guard failures, must explicitly clear the last
      // command before the motion session is released.
      await this.sensorController.requestNeutralMotorOutputs().catch(() => {});
      this.sensorController.endMotionSession();
    }
  }
}

export function selectContinuousLookaheadTargetIndex(
  points: PathPoint[],
  startIndex: number,
  parameters: PathFollowingParameters = DEFAULT_PATH_FOLLOWING_PARAMETERS,
): number {
  if (points.length === 0) {
    return -1;
  }
  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 1));
  if (clampedStartIndex >= points.length - 1) {
    return clampedStartIndex;
  }

  const cumulativeDistances = buildCumulativeDistances(points);
  const lookaheadMeters = planConservativeRouteLookahead(points, {
    minimumLookaheadMeters: parameters.continuousPathMinimumLookaheadMeters,
    maximumLookaheadMeters: parameters.continuousPathMaximumLookaheadMeters,
    maximumPathDeviationMeters: parameters.continuousPathMaximumChordDeviationMeters,
    loopPath: false,
  }).lookaheadMeters;
  const targetDistance = cumulativeDistances[clampedStartIndex] + lookaheadMeters;
  for (let index = clampedStartIndex; index < points.length; index += 1) {
    if (index > clampedStartIndex && isProtectedContinuousCorner(points, index)) {
      return index;
    }
    if (cumulativeDistances[index] >= targetDistance) {
      return index;
    }
  }
  return points.length - 1;
}

export function computeContinuousPathWheelCommands(
  pose: Pose,
  previousPoint: PathPoint,
  currentTarget: PathPoint,
  lookaheadTarget: PathPoint,
  baseSpeed: number,
  options: {
    readonly minimumSpeed?: number;
    readonly cteGain?: number;
    readonly headingGain?: number;
  } = {},
): { left: number; right: number; pivoting: boolean } {
  const localStart = pointToPosition(previousPoint);
  const localEnd = pointToPosition(currentTarget);
  const lookaheadHeading = angleTo(pose.position, pointToPosition(lookaheadTarget));
  const headingErrorDeg = unwrapRelativeAngle(headingDifference(pose.heading, lookaheadHeading));
  const hasOutgoingLookahead = distance(currentTarget, lookaheadTarget) > 1e-9;
  const incomingHeading = angleTo(pointToPosition(previousPoint), pointToPosition(currentTarget));
  const cteMeters = unwrapMeters(crossTrackError(pose.position, localStart, localEnd));
  const localPathHeading = hasOutgoingLookahead
    ? unwrapRelativeAngle(headingDifference(
      incomingHeading,
      angleTo(pointToPosition(currentTarget), pointToPosition(lookaheadTarget)),
    ))
    : 0;
  const adaptiveBaseSpeed = computeContinuousPathBaseSpeed(
    baseSpeed,
    localPathHeading,
    headingErrorDeg,
    cteMeters,
    options.minimumSpeed,
  );
  const trim = clamp(
    (cteMeters * (options.cteGain ?? CONTINUOUS_CTE_GAIN))
      + (headingErrorDeg * (options.headingGain ?? CONTINUOUS_HEADING_GAIN)),
    -adaptiveBaseSpeed,
    adaptiveBaseSpeed,
  );

  return preserveForwardPeakOutput({
    left: clamp(adaptiveBaseSpeed - trim, 0, 1),
    right: clamp(adaptiveBaseSpeed + trim, 0, 1),
    pivoting: false,
  }, baseSpeed);
}

export function preserveForwardPeakOutput(
  commands: { readonly left: number; readonly right: number; readonly pivoting: boolean },
  requestedPeakOutput: number,
): { readonly left: number; readonly right: number; readonly pivoting: boolean } {
  if (commands.pivoting || commands.left < 0 || commands.right < 0) {
    return commands;
  }
  const peak = Math.max(commands.left, commands.right);
  const targetPeak = Math.max(0, Math.min(1, requestedPeakOutput));
  if (peak <= 1e-9 || peak >= targetPeak) {
    return commands;
  }
  const scale = targetPeak / peak;
  return {
    left: clamp(commands.left * scale, 0, 1),
    right: clamp(commands.right * scale, 0, 1),
    pivoting: false,
  };
}

export function limitContinuousWheelCommandChange(
  previousCommand: number,
  requestedCommand: number,
  maxDeltaPerSecond = CONTINUOUS_MAX_WHEEL_COMMAND_DELTA_PER_SECOND,
  elapsedSeconds = CONTINUOUS_CONTROL_INTERVAL_MS / 1000,
): number {
  const boundedDelta = Math.max(0, maxDeltaPerSecond) * Math.max(0, elapsedSeconds);
  return clamp(requestedCommand, previousCommand - boundedDelta, previousCommand + boundedDelta);
}

export function capContinuousWheelCommands(
  commands: { readonly left: number; readonly right: number; readonly pivoting: boolean },
  maximumOutput?: number,
): { readonly left: number; readonly right: number; readonly pivoting: boolean } {
  if (!Number.isFinite(maximumOutput)) {
    return commands;
  }
  const cap = Math.max(0.2, Math.min(1, Math.abs(maximumOutput ?? 1)));
  const peak = Math.max(Math.abs(commands.left), Math.abs(commands.right));
  if (peak <= cap) {
    return commands;
  }
  const scale = cap / peak;
  return {
    left: commands.left * scale,
    right: commands.right * scale,
    pivoting: commands.pivoting,
  };
}

export function computeContinuousPathBaseSpeed(
  requestedBaseSpeed: number,
  localPathTurnDeg: number,
  headingErrorDeg: number,
  cteMeters: number,
  minimumSpeed = CONTINUOUS_TRACE_SPEED_MIN,
): number {
  const curvePenalty = Math.abs(localPathTurnDeg) * CONTINUOUS_TRACE_SPEED_CURVE_GAIN;
  const headingPenalty = Math.abs(headingErrorDeg) * CONTINUOUS_TRACE_SPEED_HEADING_GAIN;
  const ctePenalty = Math.abs(cteMeters) * CONTINUOUS_TRACE_SPEED_CTE_GAIN;
  return clamp(
    requestedBaseSpeed - curvePenalty - headingPenalty - ctePenalty,
    Math.max(0.2, Math.min(requestedBaseSpeed, minimumSpeed)),
    requestedBaseSpeed,
  );
}

function normalizePathPoints(points: PathPoint[], _loopPath: boolean): PathPoint[] {
  return points.slice();
}

function buildCumulativeDistances(points: PathPoint[]): number[] {
  const cumulative = new Array<number>(points.length).fill(0);
  for (let index = 1; index < points.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + distance(points[index - 1], points[index]);
  }
  return cumulative;
}

interface ContinuousPathProjection {
  readonly segmentStartIndex: number;
  readonly distanceAlongPathMeters: number;
  readonly distanceToPathMeters: number;
}

interface ContinuousGuidance {
  readonly segmentStart: PathPoint;
  readonly segmentEnd: PathPoint;
  readonly lookaheadTarget: PathPoint;
}

export function projectPoseOntoPath(
  points: PathPoint[],
  pose: Pose,
  startIndex: number,
  strictOrderedProgress: boolean,
): ContinuousPathProjection {
  const cumulativeDistances = buildCumulativeDistances(points);
  const clampedStartIndex = Math.max(0, Math.min(startIndex, points.length - 2));
  const minSegmentStartIndex = strictOrderedProgress
    ? Math.max(0, clampedStartIndex - 1)
    : clampedStartIndex;
  let maxSegmentStartIndex = points.length - 2;
  if (strictOrderedProgress) {
    maxSegmentStartIndex = Math.min(points.length - 2, clampedStartIndex + 1);
    while (
      maxSegmentStartIndex < points.length - 2
      && cumulativeDistances[maxSegmentStartIndex + 1] - cumulativeDistances[clampedStartIndex]
        <= CONTINUOUS_ORDERED_PROJECTION_FORWARD_WINDOW_METERS
    ) {
      maxSegmentStartIndex += 1;
    }
  }
  let bestSegmentStartIndex = clampedStartIndex;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestDistanceAlongPathMeters = cumulativeDistances[bestSegmentStartIndex];

  for (let index = minSegmentStartIndex; index <= maxSegmentStartIndex; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end.xMeters - start.xMeters;
    const dy = end.yMeters - start.yMeters;
    const lenSq = (dx * dx) + (dy * dy);
    if (lenSq <= 1e-9) {
      continue;
    }
    const px = unwrapMeters(pose.position.xMeters) - start.xMeters;
    const py = unwrapMeters(pose.position.yMeters) - start.yMeters;
    const t = clamp(((px * dx) + (py * dy)) / lenSq, 0, 1);
    const projX = start.xMeters + (dx * t);
    const projY = start.yMeters + (dy * t);
    const distSq = ((unwrapMeters(pose.position.xMeters) - projX) ** 2) + ((unwrapMeters(pose.position.yMeters) - projY) ** 2);
    if (distSq < bestDistanceSq) {
      bestDistanceSq = distSq;
      bestSegmentStartIndex = index;
      bestDistanceAlongPathMeters = cumulativeDistances[index] + (Math.sqrt(lenSq) * t);
    }
  }

  return {
    segmentStartIndex: bestSegmentStartIndex,
    distanceAlongPathMeters: bestDistanceAlongPathMeters,
    distanceToPathMeters: Math.sqrt(bestDistanceSq),
  };
}

function buildContinuousGuidance(
  points: PathPoint[],
  cumulativeDistances: number[],
  projection: ContinuousPathProjection,
  lookaheadMeters: number,
): ContinuousGuidance {
  const segmentStartIndex = Math.max(0, Math.min(projection.segmentStartIndex, points.length - 2));
  const segmentStart = points[segmentStartIndex];
  const segmentEnd = points[segmentStartIndex + 1];
  const unrestrictedTargetDistance = projection.distanceAlongPathMeters + lookaheadMeters;
  const protectedCornerDistance = findNextProtectedContinuousCornerDistance(
    points,
    cumulativeDistances,
    segmentStartIndex + 1,
    unrestrictedTargetDistance,
  );
  const targetDistance = protectedCornerDistance ?? unrestrictedTargetDistance;
  const lookaheadTarget = interpolatePathPointAtDistance(points, cumulativeDistances, targetDistance);
  return {
    segmentStart,
    segmentEnd,
    lookaheadTarget,
  };
}

function findNextProtectedContinuousCornerDistance(
  points: PathPoint[],
  cumulativeDistances: number[],
  firstVertexIndex: number,
  targetDistanceMeters: number,
): number | null {
  for (let index = Math.max(1, firstVertexIndex); index < points.length - 1; index += 1) {
    if (cumulativeDistances[index] > targetDistanceMeters) {
      break;
    }
    if (isProtectedContinuousCorner(points, index)) {
      return cumulativeDistances[index];
    }
  }
  return null;
}

function isProtectedContinuousCorner(points: PathPoint[], vertexIndex: number): boolean {
  if (vertexIndex <= 0 || vertexIndex >= points.length - 1) {
    return false;
  }
  const incomingHeading = angleTo(
    pointToPosition(points[vertexIndex - 1]),
    pointToPosition(points[vertexIndex]),
  );
  const outgoingHeading = angleTo(
    pointToPosition(points[vertexIndex]),
    pointToPosition(points[vertexIndex + 1]),
  );
  return Math.abs(unwrapRelativeAngle(headingDifference(incomingHeading, outgoingHeading)))
    >= CONTINUOUS_CORNER_LOOKAHEAD_LIMIT_DEG;
}

function isCornerAtLeast(points: PathPoint[], vertexIndex: number, thresholdDeg: number): boolean {
  if (vertexIndex <= 0 || vertexIndex >= points.length - 1) {
    return false;
  }
  const incomingHeading = angleTo(
    pointToPosition(points[vertexIndex - 1]),
    pointToPosition(points[vertexIndex]),
  );
  const outgoingHeading = angleTo(
    pointToPosition(points[vertexIndex]),
    pointToPosition(points[vertexIndex + 1]),
  );
  return Math.abs(unwrapRelativeAngle(headingDifference(incomingHeading, outgoingHeading))) >= thresholdDeg;
}

export function buildCommittedCornerCaptureTarget(
  vertex: PathPoint,
  outgoing: PathPoint,
  maximumCaptureDistanceMeters = CONTINUOUS_CORNER_CAPTURE_DISTANCE_METERS,
): PathPoint {
  const segmentLength = distance(vertex, outgoing);
  const captureDistanceMeters = Math.min(Math.max(0, maximumCaptureDistanceMeters), segmentLength);
  const fraction = segmentLength <= 1e-9 ? 1 : captureDistanceMeters / segmentLength;
  return {
    xMeters: vertex.xMeters + ((outgoing.xMeters - vertex.xMeters) * fraction),
    yMeters: vertex.yMeters + ((outgoing.yMeters - vertex.yMeters) * fraction),
    capturedAt: vertex.capturedAt,
  };
}

function distanceFromPoseToPoint(pose: Pose, point: PathPoint): number {
  return Math.hypot(
    unwrapMeters(pose.position.xMeters) - point.xMeters,
    unwrapMeters(pose.position.yMeters) - point.yMeters,
  );
}

function interpolatePathPointAtDistance(
  points: PathPoint[],
  cumulativeDistances: number[],
  targetDistanceMeters: number,
): PathPoint {
  if (points.length === 0) {
    return { xMeters: 0, yMeters: 0, capturedAt: Date.now() };
  }
  if (targetDistanceMeters <= 0) {
    return points[0];
  }
  const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];
  if (targetDistanceMeters >= totalDistance) {
    return points[points.length - 1];
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const startDistance = cumulativeDistances[index];
    const endDistance = cumulativeDistances[index + 1];
    if (targetDistanceMeters <= endDistance) {
      const span = Math.max(endDistance - startDistance, 1e-9);
      const t = clamp((targetDistanceMeters - startDistance) / span, 0, 1);
      const start = points[index];
      const end = points[index + 1];
      return {
        xMeters: start.xMeters + ((end.xMeters - start.xMeters) * t),
        yMeters: start.yMeters + ((end.yMeters - start.yMeters) * t),
        capturedAt: start.capturedAt,
      };
    }
  }
  return points[points.length - 1];
}

function pointToPosition(point: PathPoint): Position {
  return createPosition(point.xMeters, point.yMeters);
}

function distance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);
}

function clampIndex(index: number, pointCount: number): number {
  if (pointCount <= 0) {
    return 0;
  }
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.trunc(index), pointCount - 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
