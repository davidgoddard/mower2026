/**
 * Real-pose turn validation runner.
 *
 * Wraps the existing turn controller so we can compare the IMU-reported
 * achieved angle against the mower's pose fusion heading after the turn.
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { Pose } from "../geometry/positionTypes.js";
import {
  createRelativeAngle,
  headingDifference,
  addRelativeAngle,
  unwrapInternalHeading,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import { TurnController } from "./turnController.js";
import { TurnResult } from "./turnControllerTypes.js";
import { systemStop } from "./systemStop.js";

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface TurnPoseValidationResult {
  readonly index: number;
  readonly timestamp: string;
  readonly startHeading: number;
  readonly targetHeading: number;
  readonly targetAngle: number;
  readonly imuAchievedAngle: number;
  readonly imuErrorAngle: number;
  readonly realPoseHeading: number | null;
  readonly realPoseChange: number | null;
  readonly poseErrorAngle: number | null;
  readonly poseQuality: "gnss" | "dead-reckoning" | "unknown" | null;
  readonly turnResult: TurnResult;
}

export interface TurnValidationRunnerOptions {
  turnController: TurnController;
  poseProvider: () => Pose | null;
  stationaryPoseProvider?: () => Promise<Pose | null> | Pose | null;
  logger: SessionLogger;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface TurnValidationRunnerState {
  readonly running: boolean;
  readonly completedIterations: number;
  readonly totalIterations: number;
  readonly lastUpdated: string | null;
  readonly stopRequested: boolean;
}

export class TurnValidationRunner {
  private static readonly MIN_VALIDATION_TURN_DEGREES = 45.000001;
  private static readonly MAX_VALIDATION_TURN_DEGREES = 180;

  private readonly logger: LoggerScope;
  private readonly turnController: TurnController;
  private readonly poseProvider: () => Pose | null;
  private readonly stationaryPoseProvider: (() => Promise<Pose | null> | Pose | null) | null;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private validationHistory: TurnPoseValidationResult[] = [];
  private stopRequested = false;
  private running = false;
  private completedIterations = 0;
  private totalIterations = 0;
  private lastUpdated: string | null = null;

  constructor(options: TurnValidationRunnerOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnValidationRunner" });
    this.turnController = options.turnController;
    this.poseProvider = options.poseProvider;
    this.stationaryPoseProvider = options.stationaryPoseProvider ?? null;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async run(iterations: number = 20): Promise<TurnPoseValidationResult[]> {
    this.validationHistory = [];
    this.stopRequested = false;
    this.running = true;
    this.completedIterations = 0;
    this.totalIterations = iterations;
    this.lastUpdated = new Date().toISOString();
    const results: TurnPoseValidationResult[] = [];

    this.logger.info("turn.real_pose_validation.started", { iterations });

    try {
      for (let index = 0; index < iterations; index += 1) {
        if (systemStop.isStopped() || this.stopRequested) {
          this.logger.warn("turn.real_pose_validation.stopped", {
            completed: results.length,
            reason: this.stopRequested ? "stop_requested" : "system_stop",
          });
          return results;
        }

        const startPose = await this.getSettledPose();
        if (startPose === null) {
          this.logger.warn("turn.real_pose_validation.stopped", {
            completed: results.length,
            reason: "interrupted",
          });
          return results;
        }

        const targetAngle = this.pickLargeValidationTurn();
        const targetHeading = addRelativeAngle(startPose.heading, targetAngle);
        const turnResult = await this.turnController.executeTurn({
          targetAngle,
          direction: unwrapRelativeAngle(targetAngle) >= 0 ? "ccw" : "cw",
          learningEnabled: true,
        });

        const endPose = await this.getSettledPose();
        const validationResult: TurnPoseValidationResult = {
          index: index + 1,
          timestamp: turnResult.timestamp,
          startHeading: unwrapInternalHeading(startPose.heading),
          targetHeading: unwrapInternalHeading(targetHeading),
          targetAngle: unwrapRelativeAngle(targetAngle),
          imuAchievedAngle: unwrapRelativeAngle(turnResult.achievedAngle),
          imuErrorAngle: unwrapRelativeAngle(turnResult.errorAngle),
          realPoseHeading: endPose === null ? null : unwrapInternalHeading(endPose.heading),
          realPoseChange: endPose === null
            ? null
            : unwrapRelativeAngle(headingDifference(startPose.heading, endPose.heading)),
          poseErrorAngle: endPose === null
            ? null
            : unwrapRelativeAngle(headingDifference(endPose.heading, targetHeading)),
          poseQuality: endPose?.quality ?? null,
          turnResult,
        };

        results.push(validationResult);
        this.validationHistory.push(validationResult);
        this.completedIterations = results.length;
        this.lastUpdated = new Date().toISOString();

        if (turnResult.status !== "success") {
          this.logger.warn("turn.real_pose_validation.stopped", {
            completed: results.length,
            reason: turnResult.status,
          });
          return results;
        }

        if (systemStop.isStopped() || this.stopRequested) {
          this.logger.warn("turn.real_pose_validation.stopped", {
            completed: results.length,
            reason: this.stopRequested ? "stop_requested" : "system_stop",
          });
          return results;
        }
      }

      this.logger.info("turn.real_pose_validation.completed", { totalTurns: results.length });
      return results;
    } finally {
      // Keep the latest run visible to the web page even after completion.
      this.validationHistory = [...results];
      this.running = false;
      this.completedIterations = results.length;
      this.totalIterations = iterations;
      this.lastUpdated = new Date().toISOString();
    }
  }

  getState(): TurnValidationRunnerState {
    return {
      running: this.running,
      completedIterations: this.completedIterations,
      totalIterations: this.totalIterations,
      lastUpdated: this.lastUpdated,
      stopRequested: this.stopRequested,
    };
  }

  getHistory(): TurnPoseValidationResult[] {
    return [...this.validationHistory];
  }

  clearHistory(): void {
    this.validationHistory = [];
  }

  stopCurrentValidation(): void {
    this.stopRequested = true;
  }

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    let remainingMs = delayMs;

    while (remainingMs > 0) {
      if (systemStop.isStopped() || this.stopRequested) {
        return false;
      }

      const chunkMs = Math.min(50, remainingMs);
      await this.sleep(chunkMs);
      remainingMs -= chunkMs;
    }

    return true;
  }

  private pickLargeValidationTurn(): ReturnType<typeof createRelativeAngle> {
    const magnitudeRange = TurnValidationRunner.MAX_VALIDATION_TURN_DEGREES - TurnValidationRunner.MIN_VALIDATION_TURN_DEGREES;
    const magnitude = TurnValidationRunner.MIN_VALIDATION_TURN_DEGREES + (this.random() * magnitudeRange);
    const signedMagnitude = this.random() < 0.5 ? -magnitude : magnitude;
    return createRelativeAngle(signedMagnitude);
  }

  private async getSettledPose(): Promise<Pose | null> {
    if (this.stationaryPoseProvider !== null) {
      return await this.stationaryPoseProvider();
    }

    const settled = await this.sleepWithStopChecks(750);
    if (!settled) {
      return null;
    }

    return this.poseProvider();
  }
}
