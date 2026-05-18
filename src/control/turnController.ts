/**
 * Turn controller - executes on-the-spot turns with self-learning brake points
 */

import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { SensorController } from "../sensing/sensorController.js";
import { TurnLearningModel } from "./turnLearningModel.js";
import {
  InternalHeading,
  RelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
import {
  TurnRequest,
  TurnResult,
  TurnControllerState,
  TurnStatus,
} from "./turnControllerTypes.js";
import {
  MAX_WHEEL_SPEED_MPS_DEFAULT,
  TURN_POLLING_INTERVAL_MS,
  TURN_SETTLE_TIME_MS,
  TURN_TIMEOUT_MULTIPLIER,
  TURN_HISTORY_MAX_SIZE,
} from "../constants.js";

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface TurnControllerOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  learningModel: TurnLearningModel;
  maxWheelSpeedMetersPerSecond?: number;
  pollingIntervalMs?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class TurnController {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly learningModel: TurnLearningModel;
  private readonly maxWheelSpeed: number;
  private readonly pollingIntervalMs: number;
  private readonly settleTimeMs: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private status: TurnStatus = "idle";
  private currentTurn: TurnRequest | null = null;
  private stopRequested = false;
  private running = true;
  private turnHistory: TurnResult[] = [];
  private turnsCompleted = 0;
  private totalErrorDeg = 0;

  constructor(options: TurnControllerOptions) {
    this.logger = options.logger.child({ context: "control", source: "TurnController" });
    this.sensorController = options.sensorController;
    this.learningModel = options.learningModel;
    this.maxWheelSpeed = options.maxWheelSpeedMetersPerSecond ?? MAX_WHEEL_SPEED_MPS_DEFAULT;
    this.pollingIntervalMs = options.pollingIntervalMs ?? TURN_POLLING_INTERVAL_MS;
    this.settleTimeMs = options.settleTimeMs ?? TURN_SETTLE_TIME_MS;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Execute a turn maneuver
   */
  async executeTurn(request: TurnRequest): Promise<TurnResult> {
    // 1. STARTING - Record initial state
    this.currentTurn = request;
    this.status = "starting";
    const startHeading = this.sensorController.getHeading();
    const startTime = this.nowMillis();

    this.logger.info("turn.started", {
      targetAngle: unwrapRelativeAngle(request.targetAngle),
      direction: request.direction,
    });

    // 2. Get predicted brake angle from learning model
    const absAngle = Math.abs(unwrapRelativeAngle(request.targetAngle));
    const brakeAngle = this.learningModel.getBrakeAngle(absAngle, request.direction);

    // 3. Check if this is a "small angle" case
    const isSmallAngle = absAngle < this.learningModel.getSmallAngleThreshold();

    // 4. TURNING - Engage motors at full speed
    this.status = "turning";
    const wheelSpeed = this.maxWheelSpeed;
    if (request.direction === "ccw") {
      await this.sensorController.setMotorWheelSpeeds(-wheelSpeed, wheelSpeed);
    } else {
      await this.sensorController.setMotorWheelSpeeds(wheelSpeed, -wheelSpeed);
    }

    // 5. Monitor heading until brake point
    let currentHeading = startHeading;
    let angularProgress = createRelativeAngle(0);

    while (this.running) {
      await this.sleep(this.pollingIntervalMs);

      // Check for emergency stop
      if (this.stopRequested) {
        await this.sensorController.stopMotors();
        this.status = "stopped";
        this.currentTurn = null;
        this.stopRequested = false;
        this.logger.warn("turn.stopped", { durationMs: this.nowMillis() - startTime });
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: createRelativeAngle(0),
          errorAngle: createRelativeAngle(0),
          durationMs: this.nowMillis() - startTime,
          brakeAngleUsed: brakeAngle,
          motorEngaged: false,
          status: "stopped",
          errorMessage: "Turn stopped by user request",
          timestamp: new Date().toISOString(),
        };
      }

      currentHeading = this.sensorController.getHeading();
      angularProgress = headingDifference(startHeading, currentHeading);

      const absProgress = Math.abs(unwrapRelativeAngle(angularProgress));

      // For small angles, engage motors briefly even if brake angle is large
      if (isSmallAngle && absProgress >= absAngle * 0.5) {
        break; // Brake at halfway point for small angles
      }

      // Normal case: brake when we reach the brake angle
      if (absProgress >= unwrapRelativeAngle(brakeAngle)) {
        break;
      }

      // Safety: timeout after reasonable duration
      if (this.nowMillis() - startTime > this.calculateTimeout(absAngle)) {
        this.status = "idle";
        this.currentTurn = null;
        this.logger.error("turn.timeout", { absAngle, durationMs: this.nowMillis() - startTime });
        const timeoutError = createRelativeAngle(
          unwrapRelativeAngle(angularProgress) - unwrapRelativeAngle(request.targetAngle)
        );
        return {
          requestedAngle: request.targetAngle,
          achievedAngle: angularProgress,
          errorAngle: timeoutError,
          durationMs: this.nowMillis() - startTime,
          brakeAngleUsed: brakeAngle,
          motorEngaged: true,
          status: "timeout",
          errorMessage: "Turn execution timeout",
          timestamp: new Date().toISOString(),
        };
      }
    }

    // 6. BRAKING - Command motors to zero
    this.status = "braking";
    await this.sensorController.stopMotors();
    const brakeTime = this.nowMillis();

    // 7. Wait for motor ramp-down (2x ramp-down time per spec)
    const rampDownTime = this.learningModel.getMotorRampDownTime();
    await this.sleep(2 * rampDownTime);

    // 8. SETTLING - Additional settle for stability
    this.status = "settling";
    await this.sleep(this.settleTimeMs);

    // 9. MEASURING - Read final heading
    this.status = "measuring";
    const finalHeading = this.sensorController.getHeading();
    const achievedAngle = headingDifference(startHeading, finalHeading);
    const errorAngle = createRelativeAngle(
      unwrapRelativeAngle(achievedAngle) - unwrapRelativeAngle(request.targetAngle)
    );

    this.logger.info("turn.completed", {
      requestedAngle: unwrapRelativeAngle(request.targetAngle),
      achievedAngle: unwrapRelativeAngle(achievedAngle),
      errorAngle: unwrapRelativeAngle(errorAngle),
      durationMs: this.nowMillis() - startTime,
    });

    // 10. LEARNING - Update model if enabled
    if (request.learningEnabled !== false) {
      this.status = "learning";
      await this.learningModel.updateFromTurn({
        requestedAngle: request.targetAngle,
        achievedAngle,
        errorAngle,
        brakeAngleUsed: brakeAngle,
        direction: request.direction,
      });
    }

    // 11. Return to idle and return result
    this.status = "idle";
    this.currentTurn = null;

    const result: TurnResult = {
      requestedAngle: request.targetAngle,
      achievedAngle,
      errorAngle,
      durationMs: this.nowMillis() - startTime,
      brakeAngleUsed: brakeAngle,
      motorEngaged: true,
      status: "success",
      timestamp: new Date().toISOString(),
    };

    // Update history
    this.addToHistory(result);

    return result;
  }

  /**
   * Stop current turn immediately (emergency stop)
   */
  async stopCurrentTurn(): Promise<void> {
    if (this.currentTurn) {
      this.stopRequested = true;
      this.logger.warn("turn.stop_requested", {
        currentTurn: this.currentTurn,
      });
    }
  }

  /**
   * Run tuning sequence through multiple test angles
   */
  async runTuningSequence(iterations: number = 1, anglesToTest?: number[]): Promise<TurnResult[]> {
    const testAngles = anglesToTest ?? [10, -10, 20, -20, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180, -180];
    const results: TurnResult[] = [];

    this.logger.info("turn.tuning.started", { iterations, angles: testAngles.length });

    for (let i = 0; i < iterations; i++) {
      this.logger.info("turn.tuning.iteration", { iteration: i + 1, of: iterations });

      for (const angleDeg of testAngles) {
        if (this.stopRequested) {
          this.logger.warn("turn.tuning.stopped", { completed: results.length });
          this.stopRequested = false;
          return results;
        }

        const result = await this.executeTurn({
          targetAngle: createRelativeAngle(angleDeg),
          direction: angleDeg > 0 ? "ccw" : "cw",
          learningEnabled: true,
        });
        results.push(result);

        // Small pause between turns
        await this.sleep(500);
      }
    }

    this.logger.info("turn.tuning.completed", { totalTurns: results.length });
    return results;
  }

  /**
   * Get current controller state
   */
  getState(): TurnControllerState {
    return {
      status: this.status,
      currentTurn: this.currentTurn,
      turnsCompleted: this.turnsCompleted,
      averageErrorDeg: this.turnsCompleted > 0 ? this.totalErrorDeg / this.turnsCompleted : 0,
    };
  }

  /**
   * Get turn history
   */
  getTurnHistory(): TurnResult[] {
    return [...this.turnHistory];
  }

  /**
   * Clear turn history
   */
  clearHistory(): void {
    this.turnHistory = [];
    this.turnsCompleted = 0;
    this.totalErrorDeg = 0;
  }

  /**
   * Calculate timeout for turn angle
   */
  private calculateTimeout(absAngleDeg: number): number {
    // Assume ~90 degrees per second turn rate at full speed
    const estimatedDurationMs = (absAngleDeg / 90) * 1000;
    return estimatedDurationMs * TURN_TIMEOUT_MULTIPLIER;
  }

  /**
   * Add result to history with size limit
   */
  private addToHistory(result: TurnResult): void {
    this.turnHistory.push(result);
    if (this.turnHistory.length > TURN_HISTORY_MAX_SIZE) {
      this.turnHistory.shift();
    }
    this.turnsCompleted++;
    this.totalErrorDeg += Math.abs(unwrapRelativeAngle(result.errorAngle));
  }
}
