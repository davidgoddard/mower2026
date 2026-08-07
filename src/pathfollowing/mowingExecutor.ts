import { PathPoint } from "./pathFollowerApi.js";
import { ContinuousPathFollower } from "./continuousPathFollower.js";
import { buildMowingPlan, type MowingBoundaryReference, type MowingInitialEntryPlan, type MowingPlan } from "./mowingPlanner.js";
import type { MowingResumeContinuation, MowingResumeOperation, MowingResumeState, MowingResumeStage } from "./mowingResumeStore.js";
import { buildPerimeterJoinPlan, buildPerimeterPathPointsFromPlan, buildPerimeterPathPointsFromPlanAndPose, buildPerimeterPathPointsFromPose, buildPerimeterFollowPlan } from "./pathVerification.js";
import { RecentTargetSink } from "./segmentedBoundaryExecutor.js";
import { DriveController } from "../control/driveController.js";
import { TurnController } from "../control/turnController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { LoggerScope } from "../logging/types.js";
import { systemStop } from "../control/systemStop.js";
import { createPosition } from "../geometry/positionTypes.js";
import { headingDifference, unwrapRelativeAngle, createInternalHeading } from "../geometry/headingTypes.js";
import type { PathFollowingParameters } from "../config/pathFollowingConfig.js";
import { DEFAULT_PATH_FOLLOWING_PARAMETERS } from "../config/pathFollowingConfig.js";
import { planConservativeRouteLookahead } from "./conservativeLookahead.js";

export type MowingPhase =
  | "idle"
  | "approaching_area_perimeter"
  | "approaching_strip"
  | "tracing_boundary"
  | "mowing_strip"
  | "following_connector"
  | "returning_to_start"
  | "complete"
  | "stopped"
  | "error";

export interface MowingStatus {
  readonly phase: MowingPhase;
  readonly currentStripIndex: number;
  readonly totalStrips: number;
  readonly tracedBoundaryCount: number;
  readonly error?: string;
}

export interface MowingExecutorOptions {
  readonly areaName?: string;
  readonly plan: MowingPlan;
  readonly initialEntryPlan?: MowingInitialEntryPlan;
  readonly skipInitialBoundaryTrace?: boolean;
  readonly areaPoints: ReadonlyArray<PathPoint>;
  readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  readonly driveController: DriveController;
  readonly turnController: TurnController;
  readonly poseFusion: PoseFusion;
  readonly continuousPathFollower: ContinuousPathFollower;
  readonly logger: LoggerScope;
  readonly parameters?: PathFollowingParameters;
  /**
   * Optional sink for recording boundary targets the segmented executor has
   * just completed. Wired through to perimeter traces and inter-strip
   * connectors so the retry manager can reverse-retrace recent targets when
   * a high-current obstruction interrupts a mowing run.
   */
  readonly recentTargetSink?: RecentTargetSink;
  readonly updateRecoveryCheckpoint?: (waypoints: PathPoint[]) => void;
  readonly updateResumeState?: (state: MowingResumeState | null) => void;
  readonly resumeState?: MowingResumeState | null;
  /** Test override; production allows brief validator state transitions. */
  readonly gnssLossGraceMs?: number;
  readonly returnToStartAfterMowing?: boolean;
  readonly mowingStartPoint?: { readonly xMeters: number; readonly yMeters: number };
}

interface AreaStartAnchorPlan {
  readonly entryPlan: MowingInitialEntryPlan;
  readonly preferredStartPoint: { xMeters: number; yMeters: number };
}

const AREA_ESCAPE_STOP_DISTANCE_METERS = 0.25;
const RESUME_RECOVERY_MAX_OUTSIDE_DISTANCE_METERS = 0.75;
const RESUME_RECOVERY_INSET_METERS = 0.25;
const AREA_ESCAPE_CHECK_INTERVAL_MS = 100;
const MOWING_GNSS_CHECK_INTERVAL_MS = 100;
const MOWING_GNSS_LOSS_GRACE_MS = 2_000;
const MOWING_TARGET_REACHED_TOLERANCE_METERS = 0.1;
const MOWING_MINIMUM_TRANSLATION_METERS = 0.1;
const SHORT_DIRECT_CONNECTOR_MAX_DISTANCE_METERS = 1.0;
const SHORT_DIRECT_CONNECTOR_MAX_OUTSIDE_AREA_METERS = 0.25;
const SHORT_DIRECT_CONNECTOR_SAFETY_SAMPLE_METERS = 0.05;
const PERIMETER_FOLLOW_SPEED = 1.0;
const PERIMETER_CORNER_PIVOT_DEG = 20;
const PERIMETER_CORNER_PIVOT_DISTANCE_METERS = 0.15;
const PERIMETER_MINIMUM_INNER_WHEEL_OUTPUT = 0.4;
const CONNECTOR_MINIMUM_INNER_WHEEL_OUTPUT = 0.2;
const PERIMETER_JOIN_START_DISTANCE_METERS = 0.5;
const PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS = 0.05;

export class MowingExecutor {
  private plan: MowingPlan;
  private readonly areaName: string;
  private readonly initialEntryPlan: MowingInitialEntryPlan | null;
  private readonly areaPoints: ReadonlyArray<PathPoint>;
  private readonly obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>;
  private readonly driveController: DriveController;
  private readonly turnController: TurnController;
  private readonly poseFusion: PoseFusion;
  private readonly continuousPathFollower: ContinuousPathFollower;
  private readonly logger: LoggerScope;
  private readonly parameters: PathFollowingParameters;
  private readonly skipInitialBoundaryTrace: boolean;
  private readonly standoff: number;
  private readonly recentTargetSink: RecentTargetSink | undefined;
  private readonly updateRecoveryCheckpoint: ((waypoints: PathPoint[]) => void) | undefined;
  private readonly updateResumeState: ((state: MowingResumeState | null) => void) | undefined;
  private readonly resumeState: MowingResumeState | null;
  private readonly gnssLossGraceMs: number;
  private readonly returnToStartAfterMowing: boolean;
  private readonly mowingStartPoint: { readonly xMeters: number; readonly yMeters: number } | null;

  private phase: MowingPhase = "idle";
  private currentStripIndex: number = 0;
  private tracedBoundaries: Set<string> = new Set();
  private stopRequested: boolean = false;
  private areaEscapeMonitor: NodeJS.Timeout | null = null;
  private gnssSafetyMonitor: NodeJS.Timeout | null = null;
  private outsideAreaViolationMessage: string | null = null;
  private poorGnssViolation = false;
  private selectedAreaStartAnchor: AreaStartAnchorPlan | null = null;

  constructor(options: MowingExecutorOptions) {
    this.areaName = options.areaName ?? "Unknown area";
    this.plan = options.plan;
    this.initialEntryPlan = options.initialEntryPlan ?? null;
    this.areaPoints = options.areaPoints;
    this.obstaclePointsArray = options.obstaclePointsArray;
    this.driveController = options.driveController;
    this.turnController = options.turnController;
    this.poseFusion = options.poseFusion;
    this.continuousPathFollower = options.continuousPathFollower;
    this.logger = options.logger;
    this.parameters = options.parameters ?? DEFAULT_PATH_FOLLOWING_PARAMETERS;
    this.skipInitialBoundaryTrace = options.skipInitialBoundaryTrace ?? false;
    this.standoff = this.parameters.mowingStandoffMeters;
    this.recentTargetSink = options.recentTargetSink;
    this.updateRecoveryCheckpoint = options.updateRecoveryCheckpoint;
    this.updateResumeState = options.updateResumeState;
    this.resumeState = options.resumeState ?? null;
    this.gnssLossGraceMs = Math.max(0, options.gnssLossGraceMs ?? MOWING_GNSS_LOSS_GRACE_MS);
    this.returnToStartAfterMowing = options.returnToStartAfterMowing ?? false;
    this.mowingStartPoint = options.resumeState?.mowingStartPoint
      ?? options.mowingStartPoint
      ?? null;
  }

  getStatus(): MowingStatus {
    return {
      phase: this.phase,
      currentStripIndex: this.currentStripIndex,
      totalStrips: this.plan.strips.length,
      tracedBoundaryCount: this.tracedBoundaries.size,
      ...(this.poorGnssViolation ? { error: "poor_gnss" } : {}),
    };
  }

  stop(): void {
    this.stopRequested = true;
  }

  async execute(): Promise<MowingStatus> {
    this.stopRequested = false;
    this.tracedBoundaries = this.resumeState
      ? new Set(this.resumeState.tracedBoundaryKeys)
      : new Set();
    this.outsideAreaViolationMessage = null;
    this.poorGnssViolation = false;
    this.selectedAreaStartAnchor = null;
    this.stopAreaEscapeMonitor();
    this.stopGnssSafetyMonitor();
    this.logger.info("mowing.execute.start", { stripCount: this.plan.strips.length });

    if (this.poseFusion.getCurrentPose().quality !== "gnss") {
      this.requestPoorGnssStop("start");
      this.phase = "stopped";
      return this.getStatus();
    }
    this.startGnssSafetyMonitor();

    try {
      if (this.resumeState) {
        const recoveryStatus = await this.recoverResumePoseInsideArea();
        if (recoveryStatus) {
          return recoveryStatus;
        }
        return await this.executeResumeFlow();
      }

      this.prepareAreaStartAnchorPlan();
      const initialEntryStatus = await this.executeInitialEntry();
      if (initialEntryStatus) {
        return initialEntryStatus;
      }

      if (!this.selectedAreaStartAnchor) {
        this.reanchorPlanToCurrentPose();
      } else {
        this.currentStripIndex = 0;
      }
      if (this.skipInitialBoundaryTrace) {
        this.tracedBoundaries.add("area");
      }
      this.startAreaEscapeMonitor();
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }

      return await this.runStripSequence(0, "strip_approach");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("mowing.execute.error", { error: message });
      this.phase = "error";
      return { ...this.getStatus(), error: message };
    } finally {
      this.stopAreaEscapeMonitor();
      this.stopGnssSafetyMonitor();
    }
  }

  private async executeInitialEntry(): Promise<MowingStatus | null> {
    const entryPlan = this.selectedAreaStartAnchor?.entryPlan ?? this.initialEntryPlan;
    if (!entryPlan) {
      return null;
    }
    if (this.isStopped()) {
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }
      this.phase = "stopped";
      return this.getStatus();
    }

    if (!pointInPolygon(
      entryPlan.approachTarget.xMeters,
      entryPlan.approachTarget.yMeters,
      this.areaPoints,
    )) {
      const insideApproachTarget = movePointInsideArea(
        entryPlan.entryPoint,
        entryPlan.approachTarget,
        this.areaPoints,
        this.standoff,
      );
      this.logger.info("mowing.initial_entry.adjusted_inside_area", {
        originalApproachX: entryPlan.approachTarget.xMeters,
        originalApproachY: entryPlan.approachTarget.yMeters,
        adjustedApproachX: insideApproachTarget.x,
        adjustedApproachY: insideApproachTarget.y,
      });
      return this.executeInitialEntryDriveAndTrace(entryPlan, insideApproachTarget);
    }

    return this.executeInitialEntryDriveAndTrace(entryPlan, entryPlan.approachTarget);
  }

  private async executeInitialEntryDriveAndTrace(
    entryPlan: MowingInitialEntryPlan,
    approachTarget: { xMeters: number; yMeters: number } | { x: number; y: number },
  ): Promise<MowingStatus | null> {
    this.phase = "approaching_area_perimeter";
    this.currentStripIndex = 0;
    this.logger.info("mowing.initial_entry.start", {
      segmentIndex: entryPlan.segmentIndex,
      entryX: entryPlan.entryPoint.xMeters,
      entryY: entryPlan.entryPoint.yMeters,
      approachX: "xMeters" in approachTarget ? approachTarget.xMeters : approachTarget.x,
      approachY: "yMeters" in approachTarget ? approachTarget.yMeters : approachTarget.y,
      distanceMeters: entryPlan.distanceMeters,
    });

    const approachX = "xMeters" in approachTarget ? approachTarget.xMeters : approachTarget.x;
    const approachY = "yMeters" in approachTarget ? approachTarget.yMeters : approachTarget.y;
    this.persistResumeOperation({
      kind: "drive",
      phase: "approaching_area_perimeter",
      stripIndex: 0,
      targetX: approachX,
      targetY: approachY,
      errorCode: "initial_entry_failed",
      continuation: this.skipInitialBoundaryTrace
        ? { stage: "strip_approach", stripIndex: 0 }
        : { stage: "initial_boundary_trace", stripIndex: 0 },
    });
    if (!this.isNearCurrentPose(approachX, approachY)) {
      const approachResult = await this.driveController.executeDrive({
        targetPosition: createPosition(approachX, approachY),
        learningEnabled: true,
        minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
      });
      if (approachResult.status !== "success") {
        if (approachResult.status === "stopped") {
          const outsideAreaStatus = this.buildOutsideAreaStatus();
          if (outsideAreaStatus) {
            return outsideAreaStatus;
          }
          this.phase = "stopped";
          return this.getStatus();
        }
        this.phase = "error";
        return { ...this.getStatus(), error: `initial_entry_failed:${approachResult.status}` };
      }
    }

    if (this.isStopped()) {
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }
      this.phase = "stopped";
      return this.getStatus();
    }

    if (!this.skipInitialBoundaryTrace) {
      const traceResult = await this.traceBoundary("area", entryPlan.entryPoint, {
        stripIndex: 0,
        continuation: { stage: "strip_approach", stripIndex: 0 },
        markBoundaryTraced: "area",
      });
      if (!traceResult) {
        return this.getStatus();
      }
      this.tracedBoundaries.add("area");
      this.logger.info("mowing.initial_entry.done", {
        tracedBoundary: "area",
        segmentIndex: entryPlan.segmentIndex,
      });
      return null;
    }

    this.logger.info("mowing.initial_entry.done", {
      tracedBoundary: "area",
      segmentIndex: entryPlan.segmentIndex,
      skippedBoundaryTrace: true,
    });
    return null;
  }

  private async executeResumeFlow(): Promise<MowingStatus> {
    const resumeState = this.resumeState;
    if (!resumeState) {
      return this.getStatus();
    }

    this.currentStripIndex = resumeState.currentStripIndex;
    let continuation = await this.executeResumeOperation(resumeState.activeOperation);
    if (!continuation) {
      return this.getStatus();
    }
    if (continuation.stage === "initial_boundary_trace") {
      const entryPlan = resumeState.initialEntryPlan;
      if (!entryPlan) {
        this.phase = "error";
        return { ...this.getStatus(), error: "resume_initial_entry_plan_missing" };
      }
      const traceResult = await this.traceBoundary("area", entryPlan.entryPoint, {
        stripIndex: 0,
        continuation: { stage: "strip_approach", stripIndex: 0 },
        markBoundaryTraced: "area",
      });
      if (!traceResult) {
        return this.getStatus();
      }
      this.tracedBoundaries.add("area");
      continuation = { stage: "strip_approach", stripIndex: 0 };
    }
    if (continuation.stage === "complete") {
      return resumeState.activeOperation.phase === "returning_to_start"
        ? this.completeMowing()
        : this.returnToStartOrComplete();
    }

    if (continuation.stage !== "initial_entry_approach" && continuation.stage !== "initial_boundary_trace") {
      this.startAreaEscapeMonitor();
      const outsideAreaStatus = this.buildOutsideAreaStatus();
      if (outsideAreaStatus) {
        return outsideAreaStatus;
      }
    }

    return this.runStripSequence(continuation.stripIndex, continuation.stage);
  }

  private async recoverResumePoseInsideArea(): Promise<MowingStatus | null> {
    const pose = this.poseFusion.getCurrentPose();
    const current = {
      xMeters: pose.position.xMeters,
      yMeters: pose.position.yMeters,
    };
    const outsideDistanceMeters = outsideDistanceFromAreaMeters(
      current.xMeters,
      current.yMeters,
      this.areaPoints,
    );
    if (outsideDistanceMeters <= 0) {
      return null;
    }
    if (outsideDistanceMeters > RESUME_RECOVERY_MAX_OUTSIDE_DISTANCE_METERS) {
      this.phase = "error";
      return { ...this.getStatus(), error: `resume_outside_area_too_far:${outsideDistanceMeters.toFixed(2)}m` };
    }

    const nearestBoundaryPoint = nearestPointOnAreaBoundary(current, this.areaPoints);
    if (!nearestBoundaryPoint) {
      this.phase = "error";
      return { ...this.getStatus(), error: "resume_recovery_target_unavailable" };
    }
    const target = movePointInsideArea(
      {
        xMeters: nearestBoundaryPoint.x,
        yMeters: nearestBoundaryPoint.y,
        capturedAt: Date.now(),
      },
      current,
      this.areaPoints,
      Math.max(RESUME_RECOVERY_INSET_METERS, this.standoff),
    );
    if (!pointInPolygon(target.x, target.y, this.areaPoints)) {
      this.phase = "error";
      return { ...this.getStatus(), error: "resume_recovery_target_not_inside_area" };
    }
    const recoverySegment = {
      start: { x: current.xMeters, y: current.yMeters },
      end: target,
    };
    if (this.obstaclePointsArray.some((obstacle) => segmentIntersectsPolygon(
      recoverySegment.start,
      recoverySegment.end,
      normalizePolygon(obstacle),
    ))) {
      this.phase = "error";
      return { ...this.getStatus(), error: "resume_recovery_path_blocked" };
    }

    this.phase = "approaching_area_perimeter";
    this.logger.info("mowing.resume.outside_recovery_start", {
      outsideDistanceMeters,
      targetX: target.x,
      targetY: target.y,
    });
    const result = await this.driveController.executeDrive({
      targetPosition: createPosition(target.x, target.y),
      learningEnabled: true,
      minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
    });
    if (result.status !== "success") {
      this.phase = result.status === "stopped" ? "stopped" : "error";
      return {
        ...this.getStatus(),
        ...(result.status === "stopped" ? {} : { error: `resume_recovery_failed:${result.status}` }),
      };
    }
    const recoveredPose = this.poseFusion.getCurrentPose();
    if (outsideDistanceFromAreaMeters(
      recoveredPose.position.xMeters,
      recoveredPose.position.yMeters,
      this.areaPoints,
    ) > 0) {
      this.phase = "error";
      return { ...this.getStatus(), error: "resume_recovery_did_not_enter_area" };
    }
    this.logger.info("mowing.resume.outside_recovery_done", {
      xMeters: recoveredPose.position.xMeters,
      yMeters: recoveredPose.position.yMeters,
    });
    return null;
  }

  private async runStripSequence(startIndex: number, startStage: MowingResumeStage): Promise<MowingStatus> {
    let stage = startStage;

    for (let index = startIndex; index < this.plan.strips.length; index += 1) {
      if (this.isStopped()) {
        const stoppedOutsideAreaStatus = this.buildOutsideAreaStatus();
        if (stoppedOutsideAreaStatus) {
          return stoppedOutsideAreaStatus;
        }
        this.phase = "stopped";
        return this.getStatus();
      }

      this.currentStripIndex = index;
      const strip = this.plan.strips[index];
      const stripStart = strip.traversalReversed ? strip.end : strip.start;
      const stripEnd = strip.traversalReversed ? strip.start : strip.end;
      const dir = normalise({
        x: stripEnd.xMeters - stripStart.xMeters,
        y: stripEnd.yMeters - stripStart.yMeters,
      });

      const entryStandoff = offsetPoint(stripStart, dir, this.standoff);
      const exitStandoff = offsetPoint(stripEnd, dir, -this.standoff);
      const startBoundaryKey = this.boundaryKeyFromReference(
        strip.traversalReversed ? strip.endBoundary : strip.startBoundary,
      );
      const endBoundaryKey = this.boundaryKeyFromReference(
        strip.traversalReversed ? strip.startBoundary : strip.endBoundary,
      );
      const isLastStrip = index === this.plan.strips.length - 1;

      if (stage === "strip_approach") {
        this.phase = "approaching_strip";
        this.persistResumeOperation({
          kind: "drive",
          phase: "approaching_strip",
          stripIndex: index,
          targetX: entryStandoff.x,
          targetY: entryStandoff.y,
          errorCode: "approach_failed",
          continuation: {
            stage: this.tracedBoundaries.has(startBoundaryKey) ? "strip_turn" : "start_boundary_trace",
            stripIndex: index,
          },
        });
        if (!this.isNearCurrentPose(entryStandoff.x, entryStandoff.y)) {
          const approachResult = await this.driveController.executeDrive({
            targetPosition: createPosition(entryStandoff.x, entryStandoff.y),
            learningEnabled: true,
            minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
          });
          if (approachResult.status !== "success") {
            if (approachResult.status === "stopped") {
              this.phase = "stopped";
              return this.getStatus();
            }
            this.phase = "error";
            return { ...this.getStatus(), error: `approach_failed:${approachResult.status}` };
          }
        }
        stage = this.tracedBoundaries.has(startBoundaryKey) ? "strip_turn" : "start_boundary_trace";
      }

      if (stage === "start_boundary_trace") {
        if (!this.tracedBoundaries.has(startBoundaryKey)) {
          const traceResult = await this.traceBoundary(startBoundaryKey, stripStart, {
            stripIndex: index,
            continuation: { stage: "strip_turn", stripIndex: index },
            markBoundaryTraced: startBoundaryKey,
          });
          if (!traceResult) {
            return this.getStatus();
          }
          this.tracedBoundaries.add(startBoundaryKey);
          const approachStatus = await this.approachStripEntryAfterBoundaryTrace(index, entryStandoff);
          if (approachStatus) {
            return approachStatus;
          }
        }
        stage = "strip_turn";
      }

      if (this.isStopped()) {
        this.phase = "stopped";
        return this.getStatus();
      }

      if (stage === "strip_turn") {
        const stripHeading = Math.atan2(dir.y, dir.x) * (180 / Math.PI);
        this.persistResumeOperation({
          kind: "turn",
          phase: "mowing_strip",
          stripIndex: index,
          targetHeadingDeg: stripHeading,
          continuation: { stage: "strip_drive", stripIndex: index },
        });
        await this.turnToHeading(stripHeading);
        stage = "strip_drive";
      }

      if (this.isStopped()) {
        this.phase = "stopped";
        return this.getStatus();
      }

      if (stage === "strip_drive") {
        this.phase = "mowing_strip";
        this.persistResumeOperation({
          kind: "drive",
          phase: "mowing_strip",
          stripIndex: index,
          targetX: exitStandoff.x,
          targetY: exitStandoff.y,
          errorCode: "strip_drive_failed",
          continuation: {
            stage: !this.tracedBoundaries.has(endBoundaryKey)
              ? "end_boundary_trace"
              : (isLastStrip ? "complete" : "connector_follow"),
            stripIndex: index,
          },
        });
        if (!this.isNearCurrentPose(exitStandoff.x, exitStandoff.y)) {
          const stripResult = await this.driveController.executeDrive({
            targetPosition: createPosition(exitStandoff.x, exitStandoff.y),
            learningEnabled: true,
            minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
          });
          if (stripResult.status !== "success") {
            if (stripResult.status === "stopped") {
              this.phase = "stopped";
              return this.getStatus();
            }
            this.phase = "error";
            return { ...this.getStatus(), error: `strip_drive_failed:${stripResult.status}` };
          }
        }
        stage = !this.tracedBoundaries.has(endBoundaryKey)
          ? "end_boundary_trace"
          : (isLastStrip ? "complete" : "connector_follow");
      }

      if (stage === "end_boundary_trace") {
        if (!this.tracedBoundaries.has(endBoundaryKey)) {
          const continuation: MowingResumeContinuation = isLastStrip
            ? { stage: "complete", stripIndex: index }
            : { stage: "connector_follow", stripIndex: index };
          const traceResult = await this.traceBoundary(endBoundaryKey, stripEnd, {
            stripIndex: index,
            continuation,
            markBoundaryTraced: endBoundaryKey,
          });
          if (!traceResult) {
            return this.getStatus();
          }
          this.tracedBoundaries.add(endBoundaryKey);
        }
        stage = isLastStrip ? "complete" : "connector_follow";
      }

      if (this.isStopped()) {
        this.phase = "stopped";
        return this.getStatus();
      }

      if (stage === "complete") {
        return this.returnToStartOrComplete();
      }

      if (stage === "connector_follow" && !isLastStrip) {
        const connector = this.plan.connectors[index];
        const transitionContinuation = { stage: "strip_approach" as const, stripIndex: index + 1 };
        const transitionResult = connector && connector.length >= 2
          ? await this.followConnector(connector, index, transitionContinuation)
          : { completed: true as const, reason: "reached_end" as const };
        if (transitionResult) {
          this.phase = "following_connector";
          if (!transitionResult.completed) {
            if (transitionResult.reason === "user_stopped") {
              this.phase = "stopped";
              return this.getStatus();
            }
            this.phase = "error";
            return { ...this.getStatus(), error: `connector_failed:${transitionResult.reason}` };
          }
        }
      }

      stage = "strip_approach";
    }

    return this.returnToStartOrComplete();
  }

  private async returnToStartOrComplete(): Promise<MowingStatus> {
    if (!this.returnToStartAfterMowing || !this.mowingStartPoint) {
      return this.completeMowing();
    }
    if (this.isNearCurrentPose(this.mowingStartPoint.xMeters, this.mowingStartPoint.yMeters)) {
      return this.completeMowing();
    }

    this.phase = "returning_to_start";
    this.stopAreaEscapeMonitor();
    const currentPose = this.poseFusion.getCurrentPose();
    const returnPath = buildMowingReturnPath(
      this.areaPoints,
      { xMeters: currentPose.position.xMeters, yMeters: currentPose.position.yMeters },
      this.mowingStartPoint,
    );
    if (returnPath.length < 2) {
      this.phase = "error";
      return { ...this.getStatus(), error: "return_to_start_path_unavailable" };
    }

    const executionPoints = returnPath;
    const operation: Extract<MowingResumeOperation, { kind: "follow_path" }> = {
      kind: "follow_path",
      phase: "returning_to_start",
      stripIndex: Math.max(0, this.plan.strips.length - 1),
      pathPoints: [...executionPoints],
      followOptions: {
        loopPath: false,
        strictOrderedProgress: true,
        preserveFirstTargetAtPose: true,
        pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
        pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
        minimumSpeed: PERIMETER_FOLLOW_SPEED,
        maximumSpeed: PERIMETER_FOLLOW_SPEED,
        pivotIfInnerWheelBelow: PERIMETER_MINIMUM_INNER_WHEEL_OUTPUT,
      },
      errorCode: "return_to_start_failed",
      continuation: { stage: "complete", stripIndex: Math.max(0, this.plan.strips.length - 1) },
    };
    this.persistResumeOperation(operation);
    this.updateRecoveryCheckpoint?.([...executionPoints]);
    this.logger.info("mowing.return_to_start.start", {
      pathPointCount: executionPoints.length,
      targetX: this.mowingStartPoint.xMeters,
      targetY: this.mowingStartPoint.yMeters,
    });
    const result = await this.continuousPathFollower.executePath([...executionPoints], {
      parameters: this.parameters,
      ...operation.followOptions,
    });
    if (!result.completed) {
      this.persistInterruptedFollowProgress(operation, result.completedWaypoints);
      if (result.reason === "user_stopped") {
        this.phase = "stopped";
        return this.getStatus();
      }
      this.phase = "error";
      return { ...this.getStatus(), error: result.error ?? "return_to_start_failed" };
    }
    this.logger.info("mowing.return_to_start.done", {
      targetX: this.mowingStartPoint.xMeters,
      targetY: this.mowingStartPoint.yMeters,
    });
    return this.completeMowing();
  }

  private async executeResumeOperation(operation: MowingResumeOperation): Promise<MowingResumeContinuation | null> {
    this.currentStripIndex = operation.stripIndex;

    if (operation.kind === "drive") {
      this.phase = operation.phase;
      if (!this.isNearCurrentPose(operation.targetX, operation.targetY)) {
        const result = await this.driveController.executeDrive({
          targetPosition: createPosition(operation.targetX, operation.targetY),
          learningEnabled: true,
          minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
        });
        if (result.status !== "success") {
          if (result.status === "stopped") {
            this.phase = "stopped";
            return null;
          }
          this.phase = "error";
          return null;
        }
      }
      return operation.continuation;
    }

    if (operation.kind === "turn") {
      this.phase = operation.phase;
      await this.turnToHeading(operation.targetHeadingDeg);
      if (this.isStopped()) {
        this.phase = "stopped";
        return null;
      }
      return operation.continuation;
    }

    this.phase = operation.phase;
    this.updateRecoveryCheckpoint?.(operation.pathPoints);
    const resumedFollowOptions = {
      ...operation.followOptions,
      pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
      pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
      minimumSpeed: PERIMETER_FOLLOW_SPEED,
      maximumSpeed: PERIMETER_FOLLOW_SPEED,
      pivotIfInnerWheelBelow: PERIMETER_MINIMUM_INNER_WHEEL_OUTPUT,
      ...(operation.phase === "tracing_boundary"
        ? { completionToleranceMeters: this.parameters.closedLoopDetectionToleranceMeters }
        : {}),
    };
    if (
      (operation.phase === "following_connector" || operation.markBoundaryTraced === "area")
      && !isMowingExecutionPathSafe(
        operation.pathPoints,
        this.areaPoints,
        this.obstaclePointsArray,
      )
    ) {
      this.logger.warn("mowing.resume.unsafe_path_geometry", {
        phase: operation.phase,
        stripIndex: operation.stripIndex,
      });
      this.phase = "error";
      return null;
    }
    const result = await this.continuousPathFollower.executePath([...operation.pathPoints], {
      parameters: this.parameters,
      ...resumedFollowOptions,
    });
    if (!result.completed) {
      this.persistInterruptedFollowProgress({
        ...operation,
        followOptions: resumedFollowOptions,
      }, result.completedWaypoints);
      if (result.reason === "user_stopped") {
        this.phase = "stopped";
        return null;
      }
      this.phase = "error";
      return null;
    }
    if (operation.markBoundaryTraced) {
      this.tracedBoundaries.add(operation.markBoundaryTraced);
      if (operation.continuation.stage === "strip_turn") {
        const strip = this.plan.strips[operation.continuation.stripIndex];
        if (!strip) {
          this.phase = "error";
          return null;
        }
        const stripStart = strip.traversalReversed ? strip.end : strip.start;
        const stripEnd = strip.traversalReversed ? strip.start : strip.end;
        const direction = normalise({
          x: stripEnd.xMeters - stripStart.xMeters,
          y: stripEnd.yMeters - stripStart.yMeters,
        });
        const entryStandoff = offsetPoint(stripStart, direction, this.standoff);
        const approachStatus = await this.approachStripEntryAfterBoundaryTrace(
          operation.continuation.stripIndex,
          entryStandoff,
        );
        if (approachStatus) {
          return null;
        }
      }
    }
    return operation.continuation;
  }

  private async approachStripEntryAfterBoundaryTrace(
    stripIndex: number,
    entryStandoff: { x: number; y: number },
  ): Promise<MowingStatus | null> {
    this.phase = "approaching_strip";
    this.persistResumeOperation({
      kind: "drive",
      phase: "approaching_strip",
      stripIndex,
      targetX: entryStandoff.x,
      targetY: entryStandoff.y,
      errorCode: "post_boundary_approach_failed",
      continuation: { stage: "strip_turn", stripIndex },
    });
    this.logger.info("mowing.trace_boundary.rejoin_strip", {
      stripIndex,
      targetX: entryStandoff.x,
      targetY: entryStandoff.y,
    });
    if (this.isNearCurrentPose(entryStandoff.x, entryStandoff.y)) {
      return null;
    }

    const result = await this.driveController.executeDrive({
      targetPosition: createPosition(entryStandoff.x, entryStandoff.y),
      learningEnabled: true,
      minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
    });
    if (result.status === "success") {
      return null;
    }
    if (result.status === "stopped") {
      this.phase = "stopped";
      return this.getStatus();
    }
    this.phase = "error";
    return { ...this.getStatus(), error: `post_boundary_approach_failed:${result.status}` };
  }

  private completeMowing(): MowingStatus {
    this.phase = "complete";
    this.clearResumeState();
    this.logger.info("mowing.execute.complete", { strips: this.plan.strips.length, tracedBoundaries: this.tracedBoundaries.size });
    return this.getStatus();
  }

  private persistResumeOperation(operation: MowingResumeOperation): void {
    this.updateResumeState?.({
      version: 1,
      areaName: this.areaName,
      savedAt: Date.now(),
      currentStripIndex: operation.stripIndex,
      totalStrips: this.plan.strips.length,
      tracedBoundaryKeys: [...this.tracedBoundaries],
      plan: this.plan,
      areaPoints: [...this.areaPoints],
      obstaclePointsArray: this.obstaclePointsArray.map((points) => [...points]),
      initialEntryPlan: this.selectedAreaStartAnchor?.entryPlan ?? this.initialEntryPlan,
      ...(this.mowingStartPoint ? { mowingStartPoint: this.mowingStartPoint } : {}),
      activeOperation: operation,
    });
  }

  private persistInterruptedFollowProgress(
    operation: Extract<MowingResumeOperation, { kind: "follow_path" }>,
    completedWaypoints: number,
  ): void {
    const previousIndex = operation.followOptions.initialTargetIndex ?? 0;
    const lastTargetIndex = Math.max(0, operation.pathPoints.length - 1);
    const initialTargetIndex = Math.min(
      lastTargetIndex,
      Math.max(previousIndex, Number.isFinite(completedWaypoints) ? Math.trunc(completedWaypoints) : previousIndex),
    );
    this.persistResumeOperation({
      ...operation,
      followOptions: {
        ...operation.followOptions,
        initialTargetIndex,
      },
    });
  }

  private clearResumeState(): void {
    this.updateResumeState?.(null);
  }

  private async traceBoundary(
    boundaryKey: string,
    nearPoint: PathPoint,
    resumeMeta: {
      stripIndex: number;
      continuation: MowingResumeContinuation;
      markBoundaryTraced?: string;
    },
  ): Promise<boolean> {
    this.phase = "tracing_boundary";
    this.logger.info("mowing.trace_boundary.start", {
      boundary: boundaryKey,
      nearX: nearPoint.xMeters,
      nearY: nearPoint.yMeters,
    });

    const boundaryPoints = this.getBoundaryPoints(boundaryKey);
    if (boundaryPoints.length < 3) {
      this.logger.warn("mowing.trace_boundary.too_short", { boundary: boundaryKey });
      return true;
    }

    const currentPose = this.poseFusion.getCurrentPose();
    const forcedInitialAreaPlan = this.buildForcedInitialAreaTracePlan(boundaryKey, boundaryPoints, currentPose);
    const tracingBoundaryPoints = forcedInitialAreaPlan?.boundaryPoints ?? boundaryPoints;
    const joinPlan = forcedInitialAreaPlan?.plan ?? buildPerimeterJoinPlan(tracingBoundaryPoints, currentPose, this.parameters);
    if (!joinPlan) {
      this.logger.warn("mowing.trace_boundary.no_join_plan", { boundary: boundaryKey });
      return true;
    }

    if (forcedInitialAreaPlan) {
      this.updateRecoveryCheckpoint?.(forcedInitialAreaPlan.orderedLoopPoints);
      this.logger.info("mowing.trace_boundary.forced_anchor", {
        boundary: boundaryKey,
        anchorX: forcedInitialAreaPlan.anchorPoint.xMeters,
        anchorY: forcedInitialAreaPlan.anchorPoint.yMeters,
        pathDirection: joinPlan.pathDirection,
      });
    }

    const preTurnPath = forcedInitialAreaPlan
      ? buildPerimeterPathPointsFromPlanAndPose(
        tracingBoundaryPoints,
        currentPose,
        joinPlan,
        this.parameters,
        PERIMETER_JOIN_START_DISTANCE_METERS,
      )
      : buildPerimeterPathPointsFromPose(
        tracingBoundaryPoints,
        currentPose,
        joinPlan.pathDirection,
        this.parameters,
        PERIMETER_JOIN_START_DISTANCE_METERS,
      );
    if (preTurnPath.length < 2) {
      this.logger.warn("mowing.trace_boundary.no_preturn_path", {
        boundary: boundaryKey,
        pathDirection: joinPlan.pathDirection,
      });
      return true;
    }

    const joinLeadTarget = preTurnPath[1];
    const joinLeadHeading = createInternalHeading(
      Math.atan2(
        joinLeadTarget.yMeters - currentPose.position.yMeters,
        joinLeadTarget.xMeters - currentPose.position.xMeters,
      ) * (180 / Math.PI),
    );
    const turnAngle = headingDifference(currentPose.heading, joinLeadHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) > this.parameters.turnAlignmentThresholdDeg) {
      const turnResult = await this.turnController.executeTurn({
        targetAngle: turnAngle,
        direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
        learningEnabled: true,
      });
      if (turnResult.status !== "success") {
        if (turnResult.status === "stopped") {
          this.phase = "stopped";
          return false;
        }
      }
    }

    if (this.isStopped()) {
      this.phase = "stopped";
      return false;
    }

    const postTurnPose = this.poseFusion.getCurrentPose();
    const followPlan = forcedInitialAreaPlan
      ? joinPlan
      : buildPerimeterFollowPlan(
        tracingBoundaryPoints,
        postTurnPose,
        joinPlan.pathDirection,
        this.parameters,
      );
    if (!followPlan) {
      this.logger.warn("mowing.trace_boundary.no_follow_plan", {
        boundary: boundaryKey,
        pathDirection: joinPlan.pathDirection,
      });
      return true;
    }

    const loopPoints = forcedInitialAreaPlan
      ? buildPerimeterPathPointsFromPlanAndPose(
        tracingBoundaryPoints,
        postTurnPose,
        followPlan,
        this.parameters,
        PERIMETER_JOIN_START_DISTANCE_METERS,
      )
      : buildPerimeterPathPointsFromPose(
        tracingBoundaryPoints,
        postTurnPose,
        followPlan.pathDirection,
        this.parameters,
        PERIMETER_JOIN_START_DISTANCE_METERS,
      );
    if (loopPoints.length < 2) {
      return true;
    }
    const routeLookaheadMeters = planConservativeRouteLookahead(tracingBoundaryPoints, {
      minimumLookaheadMeters: this.parameters.continuousPathMinimumLookaheadMeters,
      maximumLookaheadMeters: this.parameters.continuousPathMaximumLookaheadMeters,
      maximumPathDeviationMeters: this.parameters.continuousPathMaximumChordDeviationMeters,
      loopPath: true,
    }).lookaheadMeters;
    const executionLoopPoints = loopPoints;
    if (
      boundaryKey === "area"
      && !isMowingExecutionPathSafe(
        executionLoopPoints,
        this.areaPoints,
        this.obstaclePointsArray,
      )
    ) {
      this.logger.warn("mowing.trace_boundary.unsafe_path_geometry", {
        boundary: boundaryKey,
        inputPointCount: loopPoints.length,
        executionPointCount: executionLoopPoints.length,
      });
      this.phase = "error";
      return false;
    }
    this.logger.info("mowing.trace_boundary.path_ready", {
      boundary: boundaryKey,
      inputPointCount: loopPoints.length,
      executionPointCount: executionLoopPoints.length,
    });

    const followOperation: Extract<MowingResumeOperation, { kind: "follow_path" }> = {
      kind: "follow_path",
      phase: "tracing_boundary",
      stripIndex: resumeMeta.stripIndex,
      pathPoints: [...executionLoopPoints],
      followOptions: {
        preserveFirstTargetAtPose: true,
        loopPath: false,
        strictOrderedProgress: true,
        pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
        pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
        minimumSpeed: PERIMETER_FOLLOW_SPEED,
        maximumSpeed: PERIMETER_FOLLOW_SPEED,
        pivotIfInnerWheelBelow: PERIMETER_MINIMUM_INNER_WHEEL_OUTPUT,
        routeLookaheadMeters,
        completionToleranceMeters: this.parameters.closedLoopDetectionToleranceMeters,
      },
      errorCode: "boundary_trace_failed",
      continuation: resumeMeta.continuation,
      markBoundaryTraced: resumeMeta.markBoundaryTraced,
    };
    this.persistResumeOperation(followOperation);
    const followResult = await this.continuousPathFollower.executePath([...executionLoopPoints], {
      parameters: this.parameters,
      preserveFirstTargetAtPose: true,
      loopPath: false,
      strictOrderedProgress: true,
      pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
      pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
      minimumSpeed: PERIMETER_FOLLOW_SPEED,
      maximumSpeed: PERIMETER_FOLLOW_SPEED,
      pivotIfInnerWheelBelow: PERIMETER_MINIMUM_INNER_WHEEL_OUTPUT,
      routeLookaheadMeters,
      completionToleranceMeters: this.parameters.closedLoopDetectionToleranceMeters,
    });
    if (!followResult.completed) {
      this.persistInterruptedFollowProgress(followOperation, followResult.completedWaypoints);
      if (followResult.reason === "user_stopped") {
        this.phase = "stopped";
        return false;
      }
      this.phase = "error";
      this.logger.warn("mowing.trace_boundary.failed", {
        boundary: boundaryKey,
        reason: followResult.reason === "obstruction" ? "error" : followResult.reason,
        error: followResult.error ?? (followResult.reason === "obstruction"
          ? "perimeter_follow_obstruction"
          : "perimeter_follow_failed"),
      });
      return false;
    }

    this.logger.info("mowing.trace_boundary.done", { boundary: boundaryKey });
    return true;
  }

  private async followConnector(
    connector: ReadonlyArray<PathPoint>,
    stripIndex: number,
    continuation: MowingResumeContinuation,
  ): Promise<{
    readonly completed: boolean;
    readonly reason: "reached_end" | "user_stopped" | "error";
    readonly error?: string;
  }> {
    if (connector.length < 2) {
      return { completed: true, reason: "reached_end" };
    }

    const target = connector[connector.length - 1];
    if (this.isNearCurrentPose(target.xMeters, target.yMeters)) {
      return { completed: true, reason: "reached_end" };
    }
    const useDirectDrive = this.canUseDirectShortConnector(target);
    if (useDirectDrive) {
      this.logger.info("mowing.connector.direct_drive", {
        stripIndex,
        connectorPointCount: connector.length,
        targetX: target.xMeters,
        targetY: target.yMeters,
      });
      this.persistResumeOperation({
        kind: "drive",
        phase: "following_connector",
        stripIndex,
        targetX: target.xMeters,
        targetY: target.yMeters,
        errorCode: "connector_failed",
        continuation,
      });
      const driveResult = await this.driveController.executeDrive({
        targetPosition: createPosition(target.xMeters, target.yMeters),
        learningEnabled: true,
        minimumDriveDistanceMeters: MOWING_MINIMUM_TRANSLATION_METERS,
      });
      if (driveResult.status === "success") {
        return { completed: true, reason: "reached_end" };
      }
      return {
        completed: false,
        reason: driveResult.status === "stopped" ? "user_stopped" : "error",
        error: driveResult.errorMessage,
      };
    }

    const executionConnector = [...connector];
    if (!isMowingExecutionPathSafe(
      executionConnector,
      this.areaPoints,
      this.obstaclePointsArray,
    )) {
      this.logger.warn("mowing.connector.unsafe_path_geometry", {
        stripIndex,
        inputPointCount: connector.length,
        executionPointCount: executionConnector.length,
      });
      return { completed: false, reason: "error", error: "connector_geometry_outside_safe_area" };
    }
    this.logger.info("mowing.connector.path_ready", {
      stripIndex,
      inputPointCount: connector.length,
      executionPointCount: executionConnector.length,
    });
    const followOperation: Extract<MowingResumeOperation, { kind: "follow_path" }> = {
      kind: "follow_path",
      phase: "following_connector",
      stripIndex,
      pathPoints: [...executionConnector],
      followOptions: {
        loopPath: false,
        strictOrderedProgress: true,
        pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
        pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
        minimumSpeed: PERIMETER_FOLLOW_SPEED,
        maximumSpeed: PERIMETER_FOLLOW_SPEED,
        pivotIfInnerWheelBelow: CONNECTOR_MINIMUM_INNER_WHEEL_OUTPUT,
      },
      errorCode: "connector_failed",
      continuation,
    };
    this.persistResumeOperation(followOperation);
    const followResult = await this.continuousPathFollower.executePath(
      [...executionConnector],
      {
        parameters: this.parameters,
        loopPath: false,
        strictOrderedProgress: true,
        pivotAtWaypointTurnDeg: PERIMETER_CORNER_PIVOT_DEG,
        pivotAtWaypointDistanceMeters: PERIMETER_CORNER_PIVOT_DISTANCE_METERS,
        minimumSpeed: PERIMETER_FOLLOW_SPEED,
        maximumSpeed: PERIMETER_FOLLOW_SPEED,
        pivotIfInnerWheelBelow: CONNECTOR_MINIMUM_INNER_WHEEL_OUTPUT,
      },
    );
    if (followResult.completed) {
      return { completed: true, reason: "reached_end" };
    }
    this.persistInterruptedFollowProgress(followOperation, followResult.completedWaypoints);
    return {
      completed: false,
      reason: followResult.reason === "user_stopped" ? "user_stopped" : "error",
      error: followResult.error,
    };
  }

  private canUseDirectShortConnector(target: PathPoint): boolean {
    if (this.areaPoints.length < 3) {
      return false;
    }

    const pose = this.poseFusion.getCurrentPose();
    const start = { x: pose.position.xMeters, y: pose.position.yMeters };
    const end = { x: target.xMeters, y: target.yMeters };
    const directDistanceMeters = Math.hypot(end.x - start.x, end.y - start.y);
    if (directDistanceMeters > SHORT_DIRECT_CONNECTOR_MAX_DISTANCE_METERS) {
      return false;
    }

    const sampleCount = Math.max(1, Math.ceil(
      directDistanceMeters / SHORT_DIRECT_CONNECTOR_SAFETY_SAMPLE_METERS,
    ));
    for (let index = 0; index <= sampleCount; index += 1) {
      const fraction = index / sampleCount;
      const x = start.x + ((end.x - start.x) * fraction);
      const y = start.y + ((end.y - start.y) * fraction);
      if (outsideDistanceFromAreaMeters(x, y, this.areaPoints) > SHORT_DIRECT_CONNECTOR_MAX_OUTSIDE_AREA_METERS) {
        return false;
      }
      if (this.obstaclePointsArray.some((obstacle) => pointInPolygon(x, y, obstacle))) {
        return false;
      }
    }

    return !this.obstaclePointsArray.some((obstacle) => segmentIntersectsPolygon(
      start,
      end,
      normalizePolygon(obstacle),
    ));
  }

  private async turnToHeading(targetHeadingDeg: number): Promise<void> {
    const currentPose = this.poseFusion.getCurrentPose();
    const targetHeading = createInternalHeading(targetHeadingDeg);
    const turnAngle = headingDifference(currentPose.heading, targetHeading);
    if (Math.abs(unwrapRelativeAngle(turnAngle)) <= this.parameters.turnAlignmentThresholdDeg) {
      return;
    }
    await this.turnController.executeTurn({
      targetAngle: turnAngle,
      direction: unwrapRelativeAngle(turnAngle) >= 0 ? "ccw" : "cw",
      learningEnabled: true,
    });
  }

  private boundaryKeyFromReference(boundary: MowingBoundaryReference): string {
    return boundary.kind === "area" ? "area" : `obstacle:${boundary.obstacleIndex}`;
  }

  private isNearCurrentPose(x: number, y: number, toleranceMeters: number = MOWING_TARGET_REACHED_TOLERANCE_METERS): boolean {
    const pose = this.poseFusion.getCurrentPose();
    return Math.hypot(
      pose.position.xMeters - x,
      pose.position.yMeters - y,
    ) <= toleranceMeters;
  }

  private reanchorPlanToCurrentPose(): void {
    if (this.plan.strips.length <= 1) {
      return;
    }

    const pose = this.poseFusion.getCurrentPose();
    const replanned = buildMowingPlan(
      [...this.areaPoints],
      {
        headingDeg: this.plan.headingDeg,
        stripSpacingMeters: this.plan.stripSpacingMeters,
        bladeWidthMeters: this.plan.bladeWidthMeters,
        mowingStandoffMeters: this.parameters.mowingStandoffMeters,
        preferredStartPoint: {
          xMeters: pose.position.xMeters,
          yMeters: pose.position.yMeters,
        },
        obstacles: this.obstaclePointsArray,
      },
    );

    if (replanned.stripCount !== this.plan.stripCount) {
      this.logger.warn("mowing.plan_reanchor_rejected", {
        originalStripCount: this.plan.stripCount,
        replannedStripCount: replanned.stripCount,
      });
      return;
    }

    this.plan = replanned;
    this.currentStripIndex = 0;
    this.logger.info("mowing.plan_reanchored", {
      stripCount: this.plan.stripCount,
      poseX: pose.position.xMeters,
      poseY: pose.position.yMeters,
      firstStripStartX: this.plan.strips[0]?.traversalReversed
        ? this.plan.strips[0].end.xMeters
        : this.plan.strips[0].start.xMeters,
      firstStripStartY: this.plan.strips[0]?.traversalReversed
        ? this.plan.strips[0].end.yMeters
        : this.plan.strips[0].start.yMeters,
    });
  }

  private prepareAreaStartAnchorPlan(): void {
    if (this.plan.strips.length === 0) {
      return;
    }

    const currentPose = this.poseFusion.getCurrentPose();
    const current = {
      x: currentPose.position.xMeters,
      y: currentPose.position.yMeters,
    };
    const areaPolygon = normalizePolygon(this.areaPoints);
    if (areaPolygon.length < 3) {
      return;
    }
    const obstaclePolygons = this.obstaclePointsArray
      .map((obstacle) => normalizePolygon(obstacle))
      .filter((obstacle) => obstacle.length >= 3);
    const currentInsideArea = pointInPolygon(current.x, current.y, this.areaPoints);

    let bestAnchor: AreaStartAnchorPlan | null = null;
    let bestDistanceMeters = Infinity;

    for (const strip of this.plan.strips) {
      const startCandidate = this.buildAreaStartAnchorCandidate(
        strip.startBoundary.kind === "area" ? strip.start : null,
        strip.startBoundary.kind === "area" ? strip.end : null,
        current,
        areaPolygon,
        obstaclePolygons,
        currentInsideArea,
      );
      if (startCandidate) {
        const distanceMeters = Math.hypot(
          startCandidate.entryPlan.approachTarget.xMeters - current.x,
          startCandidate.entryPlan.approachTarget.yMeters - current.y,
        );
        if (distanceMeters < bestDistanceMeters) {
          bestDistanceMeters = distanceMeters;
          bestAnchor = startCandidate;
        }
      }

      const endCandidate = this.buildAreaStartAnchorCandidate(
        strip.endBoundary.kind === "area" ? strip.end : null,
        strip.endBoundary.kind === "area" ? strip.start : null,
        current,
        areaPolygon,
        obstaclePolygons,
        currentInsideArea,
      );
      if (endCandidate) {
        const distanceMeters = Math.hypot(
          endCandidate.entryPlan.approachTarget.xMeters - current.x,
          endCandidate.entryPlan.approachTarget.yMeters - current.y,
        );
        if (distanceMeters < bestDistanceMeters) {
          bestDistanceMeters = distanceMeters;
          bestAnchor = endCandidate;
        }
      }
    }

    if (!bestAnchor) {
      this.logger.info("mowing.start_anchor.none_found", {
        strips: this.plan.strips.length,
      });
      return;
    }

    const anchoredPlan = buildMowingPlan([...this.areaPoints], {
      headingDeg: this.plan.headingDeg,
      stripSpacingMeters: this.plan.stripSpacingMeters,
      bladeWidthMeters: this.plan.bladeWidthMeters,
      mowingStandoffMeters: this.parameters.mowingStandoffMeters,
      preferredStartPoint: bestAnchor.preferredStartPoint,
      obstacles: this.obstaclePointsArray,
    });
    if (anchoredPlan.stripCount !== this.plan.stripCount || anchoredPlan.strips.length === 0) {
      this.logger.warn("mowing.start_anchor.replan_rejected", {
        originalStripCount: this.plan.stripCount,
        anchoredStripCount: anchoredPlan.stripCount,
      });
      return;
    }
    const anchoredFirstStrip = anchoredPlan.strips[0];
    const anchoredFirstStripStart = anchoredFirstStrip?.traversalReversed
      ? anchoredFirstStrip.end
      : anchoredFirstStrip?.start;
    if (!anchoredFirstStripStart || Math.hypot(
      anchoredFirstStripStart.xMeters - bestAnchor.preferredStartPoint.xMeters,
      anchoredFirstStripStart.yMeters - bestAnchor.preferredStartPoint.yMeters,
    ) > MOWING_TARGET_REACHED_TOLERANCE_METERS) {
      this.logger.warn("mowing.start_anchor.replan_start_mismatch", {
        preferredStartX: bestAnchor.preferredStartPoint.xMeters,
        preferredStartY: bestAnchor.preferredStartPoint.yMeters,
        anchoredStartX: anchoredFirstStripStart?.xMeters ?? null,
        anchoredStartY: anchoredFirstStripStart?.yMeters ?? null,
      });
      return;
    }

    this.plan = anchoredPlan;
    this.selectedAreaStartAnchor = bestAnchor;
    this.currentStripIndex = 0;
    this.logger.info("mowing.start_anchor.selected", {
      distanceMeters: bestDistanceMeters,
      entryX: bestAnchor.entryPlan.entryPoint.xMeters,
      entryY: bestAnchor.entryPlan.entryPoint.yMeters,
      approachX: bestAnchor.entryPlan.approachTarget.xMeters,
      approachY: bestAnchor.entryPlan.approachTarget.yMeters,
      firstStripStartX: anchoredPlan.strips[0]?.traversalReversed
        ? anchoredPlan.strips[0].end.xMeters
        : anchoredPlan.strips[0].start.xMeters,
      firstStripStartY: anchoredPlan.strips[0]?.traversalReversed
        ? anchoredPlan.strips[0].end.yMeters
        : anchoredPlan.strips[0].start.yMeters,
    });
  }

  private buildForcedInitialAreaTracePlan(
    boundaryKey: string,
    boundaryPoints: ReadonlyArray<PathPoint>,
    currentPose: ReturnType<PoseFusion["getCurrentPose"]>,
  ): { plan: ReturnType<typeof buildPerimeterJoinPlan>; orderedLoopPoints: PathPoint[]; anchorPoint: PathPoint; boundaryPoints: PathPoint[] } | null {
    if (boundaryKey !== "area" || this.tracedBoundaries.has("area") || !this.selectedAreaStartAnchor) {
      return null;
    }

    const anchorPoint = this.selectedAreaStartAnchor.entryPlan.entryPoint;
    const anchoredBoundaryPoints = insertPreferredBoundaryPoint(boundaryPoints, anchorPoint);
    const anchorPose = {
      ...currentPose,
      position: createPosition(anchorPoint.xMeters, anchorPoint.yMeters),
    };
    const plan = buildPerimeterJoinPlan(anchoredBoundaryPoints, anchorPose, this.parameters);
    if (!plan) {
      return null;
    }

    const orderedLoopPoints = buildPerimeterPathPointsFromPlan(anchoredBoundaryPoints, plan, this.parameters);
    if (orderedLoopPoints.length < 2) {
      return null;
    }

    return {
      plan,
      orderedLoopPoints,
      anchorPoint,
      boundaryPoints: anchoredBoundaryPoints,
    };
  }

  private buildAreaStartAnchorCandidate(
    perimeterPoint: PathPoint | null,
    oppositePoint: PathPoint | null,
    current: { x: number; y: number },
    areaPolygon: Array<{ x: number; y: number }>,
    obstaclePolygons: Array<Array<{ x: number; y: number }>>,
    currentInsideArea: boolean,
  ): AreaStartAnchorPlan | null {
    if (!perimeterPoint || !oppositePoint) {
      return null;
    }

    const stripVector = {
      x: oppositePoint.xMeters - perimeterPoint.xMeters,
      y: oppositePoint.yMeters - perimeterPoint.yMeters,
    };
    const stripLength = Math.hypot(stripVector.x, stripVector.y);
    if (stripLength <= 1e-6) {
      return null;
    }

    const approachTarget = {
      xMeters: perimeterPoint.xMeters + ((stripVector.x / stripLength) * this.standoff),
      yMeters: perimeterPoint.yMeters + ((stripVector.y / stripLength) * this.standoff),
    };
    if (!pointInPolygon(approachTarget.xMeters, approachTarget.yMeters, this.areaPoints)) {
      return null;
    }
    if (!this.isAreaStartAnchorReachable(
      current,
      approachTarget,
      obstaclePolygons,
      currentInsideArea,
    )) {
      return null;
    }

    return {
      preferredStartPoint: {
        xMeters: perimeterPoint.xMeters,
        yMeters: perimeterPoint.yMeters,
      },
      entryPlan: {
        entryPoint: {
          xMeters: perimeterPoint.xMeters,
          yMeters: perimeterPoint.yMeters,
          capturedAt: perimeterPoint.capturedAt,
        },
        approachTarget,
        segmentIndex: nearestAreaSegmentIndex(areaPolygon, {
          x: perimeterPoint.xMeters,
          y: perimeterPoint.yMeters,
        }),
        distanceMeters: Math.hypot(
          approachTarget.xMeters - current.x,
          approachTarget.yMeters - current.y,
        ),
        tangentHeadingDeg: Math.atan2(stripVector.y, stripVector.x) * (180 / Math.PI),
      },
    };
  }

  private isAreaStartAnchorReachable(
    current: { x: number; y: number },
    target: { xMeters: number; yMeters: number },
    obstaclePolygons: Array<Array<{ x: number; y: number }>>,
    currentInsideArea: boolean,
  ): boolean {
    const start = { x: current.x, y: current.y };
    const end = { x: target.xMeters, y: target.yMeters };
    if (obstaclePolygons.some((obstacle) => segmentIntersectsPolygon(start, end, obstacle))) {
      return false;
    }

    let hasEnteredArea = currentInsideArea;
    const sampleCount = 40;
    for (let index = 1; index <= sampleCount; index += 1) {
      const t = index / sampleCount;
      const sample = {
        x: start.x + ((end.x - start.x) * t),
        y: start.y + ((end.y - start.y) * t),
      };
      const inside = pointInPolygon(sample.x, sample.y, this.areaPoints);
      if (inside) {
        hasEnteredArea = true;
        continue;
      }
      if (hasEnteredArea) {
        return false;
      }
    }

    return !currentInsideArea || pointInPolygon(midpoint(start, end).x, midpoint(start, end).y, this.areaPoints) || hasEnteredArea;
  }

  private getBoundaryPoints(key: string): ReadonlyArray<PathPoint> {
    if (key === "area") {
      return [...this.areaPoints];
    }
    const match = key.match(/^obstacle:(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      return this.obstaclePointsArray[idx] ?? [];
    }
    return [];
  }

  private startAreaEscapeMonitor(): void {
    if (this.areaEscapeMonitor) {
      clearInterval(this.areaEscapeMonitor);
    }
    this.areaEscapeMonitor = setInterval(() => {
      if (this.outsideAreaViolationMessage || this.stopRequested || systemStop.isStopped()) {
        return;
      }
      const pose = this.poseFusion.getCurrentPose();
      const outsideDistanceMeters = outsideDistanceFromAreaMeters(
        pose.position.xMeters,
        pose.position.yMeters,
        this.areaPoints,
      );
      if (outsideDistanceMeters <= AREA_ESCAPE_STOP_DISTANCE_METERS) {
        return;
      }
      this.outsideAreaViolationMessage = `outside_mowing_area:${outsideDistanceMeters.toFixed(2)}m`;
      this.logger.warn("mowing.outside_area_limit_exceeded", {
        xMeters: pose.position.xMeters,
        yMeters: pose.position.yMeters,
        outsideDistanceMeters,
        limitMeters: AREA_ESCAPE_STOP_DISTANCE_METERS,
      });
      systemStop.requestStop("mowing", "outside_mowing_area_limit_exceeded");
    }, AREA_ESCAPE_CHECK_INTERVAL_MS);
    this.areaEscapeMonitor.unref?.();
  }

  private stopAreaEscapeMonitor(): void {
    if (!this.areaEscapeMonitor) {
      return;
    }
    clearInterval(this.areaEscapeMonitor);
    this.areaEscapeMonitor = null;
  }

  private startGnssSafetyMonitor(): void {
    this.stopGnssSafetyMonitor();
    let poorGnssSinceMillis: number | null = null;
    this.gnssSafetyMonitor = setInterval(() => {
      if (this.poorGnssViolation || this.stopRequested || systemStop.isStopped()) {
        return;
      }
      if (this.poseFusion.getCurrentPose().quality === "gnss") {
        poorGnssSinceMillis = null;
        return;
      }
      const nowMillis = Date.now();
      poorGnssSinceMillis ??= nowMillis;
      if (nowMillis - poorGnssSinceMillis < this.gnssLossGraceMs) {
        return;
      }
      this.requestPoorGnssStop("active_mow");
    }, MOWING_GNSS_CHECK_INTERVAL_MS);
    this.gnssSafetyMonitor.unref?.();
  }

  private stopGnssSafetyMonitor(): void {
    if (!this.gnssSafetyMonitor) {
      return;
    }
    clearInterval(this.gnssSafetyMonitor);
    this.gnssSafetyMonitor = null;
  }

  private requestPoorGnssStop(stage: "start" | "active_mow"): void {
    if (this.poorGnssViolation) {
      return;
    }
    this.poorGnssViolation = true;
    this.logger.warn("mowing.poor_gnss", {
      stage,
      poseQuality: this.poseFusion.getCurrentPose().quality,
      graceMs: stage === "start" ? 0 : this.gnssLossGraceMs,
    });
    systemStop.requestStop("mowing", "poor_gnss");
  }

  private buildOutsideAreaStatus(): MowingStatus | null {
    if (!this.outsideAreaViolationMessage) {
      return null;
    }
    this.phase = "error";
    return { ...this.getStatus(), error: this.outsideAreaViolationMessage };
  }

  private isStopped(): boolean {
    return this.stopRequested || systemStop.isStopped();
  }
}

export function buildMowingReturnPath(
  areaPoints: ReadonlyArray<PathPoint>,
  current: { readonly xMeters: number; readonly yMeters: number },
  mowingStart: { readonly xMeters: number; readonly yMeters: number },
): PathPoint[] {
  const perimeter = [...areaPoints];
  if (perimeter.length > 1) {
    const first = perimeter[0];
    const last = perimeter[perimeter.length - 1];
    if (Math.hypot(first.xMeters - last.xMeters, first.yMeters - last.yMeters) <= PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS) {
      perimeter.pop();
    }
  }
  if (perimeter.length < 2) {
    return [];
  }

  const nearestIndex = (point: { readonly xMeters: number; readonly yMeters: number }): number => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    perimeter.forEach((candidate, index) => {
      const distance = Math.hypot(candidate.xMeters - point.xMeters, candidate.yMeters - point.yMeters);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  };
  const currentIndex = nearestIndex(current);
  const startIndex = nearestIndex(mowingStart);
  const buildDirection = (step: 1 | -1): PathPoint[] => {
    const route: PathPoint[] = [perimeter[currentIndex]];
    let index = currentIndex;
    while (index !== startIndex && route.length <= perimeter.length) {
      index = (index + step + perimeter.length) % perimeter.length;
      route.push(perimeter[index]);
    }
    return route;
  };
  const routeLength = (route: ReadonlyArray<PathPoint>): number => route.slice(1).reduce(
    (total, point, index) => total + Math.hypot(
      point.xMeters - route[index].xMeters,
      point.yMeters - route[index].yMeters,
    ),
    0,
  );
  const forward = buildDirection(1);
  const reverse = buildDirection(-1);
  const perimeterRoute = routeLength(forward) <= routeLength(reverse) ? forward : reverse;
  const capturedAt = Date.now();
  const result: PathPoint[] = [{ xMeters: current.xMeters, yMeters: current.yMeters, capturedAt }];
  for (const point of perimeterRoute) {
    const previous = result[result.length - 1];
    if (Math.hypot(previous.xMeters - point.xMeters, previous.yMeters - point.yMeters) > 0.01) {
      result.push(point);
    }
  }
  const previous = result[result.length - 1];
  if (Math.hypot(previous.xMeters - mowingStart.xMeters, previous.yMeters - mowingStart.yMeters) > 0.01) {
    result.push({ xMeters: mowingStart.xMeters, yMeters: mowingStart.yMeters, capturedAt: capturedAt + 1 });
  }
  return result;
}

export function isMowingExecutionPathSafe(
  points: ReadonlyArray<PathPoint>,
  areaPoints: ReadonlyArray<PathPoint>,
  obstaclePointsArray: ReadonlyArray<ReadonlyArray<PathPoint>>,
): boolean {
  if (points.length < 2 || normalizePolygon(areaPoints).length < 3) {
    return false;
  }
  const sampleIsSafe = (x: number, y: number): boolean => (
    outsideDistanceFromAreaMeters(x, y, areaPoints) <= 0.01
    && !obstaclePointsArray.some((obstacle) => pointInPolygon(x, y, obstacle))
  );

  for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    const distanceMeters = Math.hypot(end.xMeters - start.xMeters, end.yMeters - start.yMeters);
    const sampleCount = Math.max(1, Math.ceil(distanceMeters / 0.025));
    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const fraction = sampleIndex / sampleCount;
      if (!sampleIsSafe(
        start.xMeters + ((end.xMeters - start.xMeters) * fraction),
        start.yMeters + ((end.yMeters - start.yMeters) * fraction),
      )) {
        return false;
      }
    }
  }
  return true;
}

function normalise(v: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-9 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

function offsetPoint(p: PathPoint, dir: { x: number; y: number }, distance: number): { x: number; y: number } {
  return { x: p.xMeters + dir.x * distance, y: p.yMeters + dir.y * distance };
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function pointToPathDistance(point: PathPoint, path: ReadonlyArray<PathPoint>): number {
  let nearest = Infinity;
  for (const p of path) {
    const d = Math.hypot(p.xMeters - point.xMeters, p.yMeters - point.yMeters);
    if (d < nearest) {
      nearest = d;
    }
  }
  return nearest;
}

function insertPreferredBoundaryPoint(boundaryPoints: ReadonlyArray<PathPoint>, preferredPoint: PathPoint): PathPoint[] {
  if (boundaryPoints.length < 2) {
    return boundaryPoints.slice();
  }

  const points = boundaryPoints.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const wasClosed = Math.hypot(first.xMeters - last.xMeters, first.yMeters - last.yMeters) <= PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS;
  if (wasClosed) {
    points.pop();
  }

  if (points.some((point) => Math.hypot(point.xMeters - preferredPoint.xMeters, point.yMeters - preferredPoint.yMeters) <= PREFERRED_BOUNDARY_POINT_TOLERANCE_METERS)) {
    return wasClosed ? points.concat([points[0]]) : points;
  }

  let nearestSegmentIndex = 0;
  let nearestDistance = Infinity;
  const segmentCount = wasClosed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const distance = pointToSegmentDistance(preferredPoint, current, next);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestSegmentIndex = index;
    }
  }

  points.splice(nearestSegmentIndex + 1, 0, preferredPoint);
  return wasClosed ? points.concat([points[0]]) : points;
}

function pointToSegmentDistance(point: PathPoint, start: PathPoint, end: PathPoint): number {
  const segmentX = end.xMeters - start.xMeters;
  const segmentY = end.yMeters - start.yMeters;
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  if (lengthSquared <= 1e-9) {
    return Math.hypot(point.xMeters - start.xMeters, point.yMeters - start.yMeters);
  }

  const t = Math.max(0, Math.min(1, (((point.xMeters - start.xMeters) * segmentX) + ((point.yMeters - start.yMeters) * segmentY)) / lengthSquared));
  const projectedX = start.xMeters + (segmentX * t);
  const projectedY = start.yMeters + (segmentY * t);
  return Math.hypot(point.xMeters - projectedX, point.yMeters - projectedY);
}

function normalizeSignedDegrees(angleDeg: number): number {
  let normalized = ((angleDeg + 180) % 360 + 360) % 360 - 180;
  if (normalized === -180) {
    normalized = 180;
  }
  return normalized;
}

function normalizePolygon(points: ReadonlyArray<PathPoint>): Array<{ x: number; y: number }> {
  if (points.length === 0) {
    return [];
  }
  const polygon = points.map((point) => ({ x: point.xMeters, y: point.yMeters }));
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9) {
    polygon.pop();
  }
  return polygon;
}

function nearestAreaSegmentIndex(
  polygon: ReadonlyArray<{ x: number; y: number }>,
  point: { x: number; y: number },
): number {
  if (polygon.length < 2) {
    return 0;
  }

  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const projection = nearestPointOnSegment(point, start, end);
    const distance = Math.hypot(point.x - projection.x, point.y - projection.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function nearestPointOnAreaBoundary(
  point: { readonly xMeters: number; readonly yMeters: number },
  polygonPoints: ReadonlyArray<PathPoint>,
): { x: number; y: number } | null {
  const polygon = normalizePolygon(polygonPoints);
  if (polygon.length < 2) {
    return null;
  }
  const query = { x: point.xMeters, y: point.yMeters };
  let nearest: { x: number; y: number } | null = null;
  let nearestDistance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const candidate = nearestPointOnSegment(query, polygon[index], polygon[(index + 1) % polygon.length]);
    const distance = Math.hypot(query.x - candidate.x, query.y - candidate.y);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function nearestPointOnSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 1e-12) {
    return start;
  }
  const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared));
  return {
    x: start.x + (dx * t),
    y: start.y + (dy * t),
  };
}

function pointInPolygon(x: number, y: number, polygonPoints: ReadonlyArray<PathPoint>): boolean {
  const polygon = normalizePolygon(polygonPoints);
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    const intersects = ((current.y > y) !== (prior.y > y))
      && (x < (((prior.x - current.x) * (y - current.y)) / ((prior.y - current.y) || 1e-12)) + current.x);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function outsideDistanceFromAreaMeters(x: number, y: number, polygonPoints: ReadonlyArray<PathPoint>): number {
  if (pointInPolygon(x, y, polygonPoints)) {
    return 0;
  }

  const polygon = normalizePolygon(polygonPoints);
  if (polygon.length < 2) {
    return Infinity;
  }

  let nearest = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    nearest = Math.min(nearest, pointToSegmentDistanceMeters(x, y, start.x, start.y, end.x, end.y));
  }
  return nearest;
}

function movePointInsideArea(
  entryPoint: PathPoint,
  approachTarget: { xMeters: number; yMeters: number },
  polygonPoints: ReadonlyArray<PathPoint>,
  preferredInsetMeters: number,
): { x: number; y: number } {
  const dx = approachTarget.xMeters - entryPoint.xMeters;
  const dy = approachTarget.yMeters - entryPoint.yMeters;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) {
    return { x: entryPoint.xMeters, y: entryPoint.yMeters };
  }

  const inset = Math.max(0.02, preferredInsetMeters);
  const candidate = {
    x: entryPoint.xMeters - ((dx / length) * inset),
    y: entryPoint.yMeters - ((dy / length) * inset),
  };
  if (pointInPolygon(candidate.x, candidate.y, polygonPoints)) {
    return candidate;
  }

  for (let scale = 1.5; scale <= 4; scale += 0.5) {
    const retried = {
      x: entryPoint.xMeters - ((dx / length) * inset * scale),
      y: entryPoint.yMeters - ((dy / length) * inset * scale),
    };
    if (pointInPolygon(retried.x, retried.y, polygonPoints)) {
      return retried;
    }
  }

  return { x: entryPoint.xMeters, y: entryPoint.yMeters };
}

function pointToSegmentDistanceMeters(
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = (segmentX * segmentX) + (segmentY * segmentY);
  if (lengthSquared <= 1e-12) {
    return Math.hypot(x - startX, y - startY);
  }

  const t = Math.max(0, Math.min(1, (((x - startX) * segmentX) + ((y - startY) * segmentY)) / lengthSquared));
  const projectedX = startX + (segmentX * t);
  const projectedY = startY + (segmentY * t);
  return Math.hypot(x - projectedX, y - projectedY);
}

function segmentIntersectsPolygon(
  start: { x: number; y: number },
  end: { x: number; y: number },
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (polygon.length < 2) {
    return false;
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (segmentsIntersect(start, end, current, next)) {
      return true;
    }
  }
  return false;
}

function segmentsIntersect(
  aStart: { x: number; y: number },
  aEnd: { x: number; y: number },
  bStart: { x: number; y: number },
  bEnd: { x: number; y: number },
): boolean {
  const o1 = orientation(aStart, aEnd, bStart);
  const o2 = orientation(aStart, aEnd, bEnd);
  const o3 = orientation(bStart, bEnd, aStart);
  const o4 = orientation(bStart, bEnd, aEnd);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  if (o1 === 0 && onSegment(aStart, bStart, aEnd)) {
    return true;
  }
  if (o2 === 0 && onSegment(aStart, bEnd, aEnd)) {
    return true;
  }
  if (o3 === 0 && onSegment(bStart, aStart, bEnd)) {
    return true;
  }
  if (o4 === 0 && onSegment(bStart, aEnd, bEnd)) {
    return true;
  }
  return false;
}

function orientation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const value = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
  if (Math.abs(value) <= 1e-9) {
    return 0;
  }
  return value > 0 ? 1 : 2;
}

function onSegment(
  start: { x: number; y: number },
  point: { x: number; y: number },
  end: { x: number; y: number },
): boolean {
  return point.x <= Math.max(start.x, end.x) + 1e-9
    && point.x + 1e-9 >= Math.min(start.x, end.x)
    && point.y <= Math.max(start.y, end.y) + 1e-9
    && point.y + 1e-9 >= Math.min(start.y, end.y);
}
