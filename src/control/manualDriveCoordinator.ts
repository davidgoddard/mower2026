import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { HidGameController, HidGameControllerSnapshot } from "../controller/hidGameController.js";
import { SensorController } from "../sensing/sensorController.js";
import { computeManualDriveDemand, normalizeManualTurnDemand } from "./manualDriveProfile.js";
import { systemStop } from "./systemStop.js";
import {
  DRIVE_FULL_SPEED_COMMAND_DEFAULT,
  MANUAL_DRIVE_COMMAND_REFRESH_INTERVAL_MS,
  MANUAL_DRIVE_CONTROLLER_DISCONNECT_GRACE_MS,
  MANUAL_DRIVE_LOOP_INTERVAL_MS,
  MANUAL_DRIVE_OUTPUT_QUANTIZATION_PERCENT,
} from "../constants.js";

interface ManualDriveCoordinatorOptions {
  logger: SessionLogger;
  sensorController: SensorController;
  hidController: HidGameController;
  controlIntervalMs?: number;
  commandRefreshIntervalMs?: number;
  controllerDisconnectGraceMs?: number;
  outputQuantizationPercent?: number;
  maxWheelOutputPercent?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function disconnectedSnapshot(): HidGameControllerSnapshot {
  return {
    connected: false,
    vendorId: 0,
    productId: 0,
    steeringByte: 128,
    speedByte: 128,
    angleDegrees: 0,
    speed: 0,
    buttons: {},
    lastPacketHex: "",
    lastUpdateMillis: 0,
  };
}

export class ManualDriveCoordinator {
  private readonly logger: LoggerScope;
  private readonly sensorController: SensorController;
  private readonly hidController: HidGameController;
  private readonly controlIntervalMs: number;
  private readonly commandRefreshIntervalMs: number;
  private readonly controllerDisconnectGraceMs: number;
  private readonly outputQuantizationPercent: number;
  private readonly maxWheelOutputPercent: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private manualDriveEnabled = false;
  private snapshot: HidGameControllerSnapshot = disconnectedSnapshot();
  private drivingActive = false;
  private lastCommandedLeftWheelOutputPercent: number | null = null;
  private lastCommandedRightWheelOutputPercent: number | null = null;
  private lastCommandSentMillis: number | null = null;
  private controllerLostSinceMillis: number | null = null;
  private gentleHaltSentForCurrentLoss = false;
  private snapshotStaleSinceMillis: number | null = null;
  private gentleStopSentForCurrentStaleSnapshot = false;

  constructor(options: ManualDriveCoordinatorOptions) {
    this.logger = options.logger.child({ context: "control", source: "ManualDriveCoordinator" });
    this.sensorController = options.sensorController;
    this.hidController = options.hidController;
    this.controlIntervalMs = options.controlIntervalMs ?? MANUAL_DRIVE_LOOP_INTERVAL_MS;
    this.commandRefreshIntervalMs = options.commandRefreshIntervalMs ?? MANUAL_DRIVE_COMMAND_REFRESH_INTERVAL_MS;
    this.controllerDisconnectGraceMs = options.controllerDisconnectGraceMs ?? MANUAL_DRIVE_CONTROLLER_DISCONNECT_GRACE_MS;
    this.outputQuantizationPercent = options.outputQuantizationPercent ?? MANUAL_DRIVE_OUTPUT_QUANTIZATION_PERCENT;
    this.maxWheelOutputPercent = options.maxWheelOutputPercent ?? DRIVE_FULL_SPEED_COMMAND_DEFAULT;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.registerControllerEvents();
    this.hidController.start();
    this.loopPromise = this.runLoop();
    this.logger.transition("idle", "running", { controlIntervalMs: this.controlIntervalMs });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    this.hidController.close();
    await this.disableManualDrive();
    this.logger.transition("running", "stopped");
  }

  private registerControllerEvents(): void {
    this.hidController.on("update", (snapshot: HidGameControllerSnapshot) => {
      this.snapshot = {
        ...snapshot,
        lastUpdateMillis: snapshot.lastUpdateMillis > 0 ? snapshot.lastUpdateMillis : this.nowMillis(),
      };
      if (!snapshot.connected) {
        if (this.manualDriveEnabled && this.controllerLostSinceMillis === null) {
          this.controllerLostSinceMillis = this.nowMillis();
          this.gentleHaltSentForCurrentLoss = false;
          this.logger.warn("control.manual_drive.controller_disconnected", {
            graceMs: this.controllerDisconnectGraceMs,
          });
        }
      } else {
        if (this.controllerLostSinceMillis !== null) {
          this.logger.info("control.manual_drive.controller_reconnected", {
            disconnectedForMs: this.nowMillis() - this.controllerLostSinceMillis,
          });
        }
        if (this.snapshotStaleSinceMillis !== null) {
          this.logger.info("control.manual_drive.snapshot_stream_recovered", {
            staleForMs: this.nowMillis() - this.snapshotStaleSinceMillis,
          });
        }
        this.controllerLostSinceMillis = null;
        this.gentleHaltSentForCurrentLoss = false;
        this.snapshotStaleSinceMillis = null;
        this.gentleStopSentForCurrentStaleSnapshot = false;
      }
    });

    this.hidController.on("right-top", () => {
      systemStop.clearStop("manual-drive-armed");
      this.manualDriveEnabled = true;
      this.sensorController.beginMotionSession();
      this.logger.info("control.manual_drive.armed");
    });

    this.hidController.on("left-top", () => {
      this.logger.info("control.manual_drive.disarmed");
      void this.disableManualDrive();
    });

    this.hidController.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("control.manual_drive.controller_error", { error: message });
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        if (systemStop.isStopped()) {
          if (this.drivingActive) {
            this.drivingActive = false;
            await this.sensorController.haltMotors();
          }
          await this.sleep(this.controlIntervalMs);
          continue;
        }

        if (!this.manualDriveEnabled) {
          if (this.drivingActive) {
            this.drivingActive = false;
            await this.sensorController.stopMotors();
          }
          await this.sleep(this.controlIntervalMs);
          continue;
        }

        if (!this.snapshot.connected) {
          // Flaky HID links drop briefly. Bring the mower to a gentle halt
          // immediately but keep manual drive armed for the grace window so
          // a quick reconnect can resume without re-arming. If the window
          // expires, fall through to the normal disarm path.
          if (!this.gentleHaltSentForCurrentLoss) {
            this.gentleHaltSentForCurrentLoss = true;
            this.drivingActive = false;
            this.lastCommandedLeftWheelOutputPercent = null;
            this.lastCommandedRightWheelOutputPercent = null;
            this.lastCommandSentMillis = null;
            await this.sensorController.stopMotors();
          }

          const lostSince = this.controllerLostSinceMillis;
          if (lostSince !== null && this.nowMillis() - lostSince >= this.controllerDisconnectGraceMs) {
            this.logger.warn("control.manual_drive.disarmed_controller_disconnect_grace_expired", {
              graceMs: this.controllerDisconnectGraceMs,
            });
            await this.disableManualDrive();
          }

          await this.sleep(this.controlIntervalMs);
          continue;
        }

        const snapshotAgeMillis = this.nowMillis() - this.snapshot.lastUpdateMillis;
        const snapshotStaleAfterMillis = Math.max(
          this.commandRefreshIntervalMs * 2,
          this.controlIntervalMs * 2,
        );

        if (snapshotAgeMillis >= snapshotStaleAfterMillis) {
          if (this.snapshotStaleSinceMillis === null) {
            this.snapshotStaleSinceMillis = this.nowMillis();
            this.gentleStopSentForCurrentStaleSnapshot = false;
            this.logger.warn("control.manual_drive.snapshot_stream_stale", {
              snapshotAgeMs: snapshotAgeMillis,
              staleAfterMs: snapshotStaleAfterMillis,
            });
          }

          if (!this.gentleStopSentForCurrentStaleSnapshot) {
            this.gentleStopSentForCurrentStaleSnapshot = true;
            this.drivingActive = false;
            this.lastCommandedLeftWheelOutputPercent = null;
            this.lastCommandedRightWheelOutputPercent = null;
            this.lastCommandSentMillis = null;
            await this.sensorController.stopMotors();
          }

          if (this.nowMillis() - this.snapshotStaleSinceMillis >= this.controllerDisconnectGraceMs) {
            this.logger.warn("control.manual_drive.disarmed_snapshot_stream_stale", {
              graceMs: this.controllerDisconnectGraceMs,
              snapshotAgeMs: snapshotAgeMillis,
            });
            await this.disableManualDrive();
          }

          await this.sleep(this.controlIntervalMs);
          continue;
        }

        const demand = computeManualDriveDemand({
          speedDemand: this.snapshot.speed,
          turnDemand: normalizeManualTurnDemand(this.snapshot.angleDegrees),
          maxWheelOutputPercent: this.maxWheelOutputPercent,
        });

        if (demand.mode === "stopped") {
          if (
            !this.drivingActive ||
            this.lastCommandedLeftWheelOutputPercent !== 0 ||
            this.lastCommandedRightWheelOutputPercent !== 0
          ) {
            await this.sendManualWheelCommand(0, 0);
          }
        } else {
          const left = this.quantizeWheelOutput(demand.requestedLeftWheelOutputPercent);
          const right = this.quantizeWheelOutput(demand.requestedRightWheelOutputPercent);

          if (this.shouldSendManualWheelCommand(left, right)) {
            await this.sendManualWheelCommand(left, right);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("control.manual_drive.loop_error", { error: message });
      }

      await this.sleep(this.controlIntervalMs);
    }
  }

  private quantizeWheelOutput(outputPercent: number): number {
    if (outputPercent === 0 || this.outputQuantizationPercent <= 0) {
      return outputPercent;
    }

    const quantized = Math.round(outputPercent / this.outputQuantizationPercent) * this.outputQuantizationPercent;
    const normalized = Math.max(-this.maxWheelOutputPercent, Math.min(this.maxWheelOutputPercent, quantized));
    return Object.is(normalized, -0) ? 0 : Number(normalized.toFixed(4));
  }

  private shouldSendManualWheelCommand(left: number, right: number): boolean {
    if (
      !this.drivingActive ||
      this.lastCommandedLeftWheelOutputPercent !== left ||
      this.lastCommandedRightWheelOutputPercent !== right
    ) {
      return true;
    }

    const commandIsMoving = left !== 0 || right !== 0;
    if (!commandIsMoving || this.lastCommandSentMillis === null) {
      return false;
    }

    return this.nowMillis() - this.lastCommandSentMillis >= this.commandRefreshIntervalMs;
  }

  private async sendManualWheelCommand(left: number, right: number): Promise<void> {
    this.drivingActive = true;
    this.lastCommandedLeftWheelOutputPercent = left;
    this.lastCommandedRightWheelOutputPercent = right;
    this.lastCommandSentMillis = this.nowMillis();
    await this.sensorController.setMotorWheelOutputs(left, right);
  }

  private async sleepWithStopChecks(delayMs: number): Promise<boolean> {
    const endTime = Date.now() + delayMs;

    while (Date.now() < endTime) {
      if (systemStop.isStopped() || !this.running) {
        return false;
      }

      const remaining = endTime - Date.now();
      await this.sleep(Math.min(50, Math.max(0, remaining)));
    }

    return true;
  }

  private async disableManualDrive(): Promise<void> {
    const wasArmed = this.manualDriveEnabled;
    this.manualDriveEnabled = false;
    this.drivingActive = false;
    this.lastCommandedLeftWheelOutputPercent = null;
    this.lastCommandedRightWheelOutputPercent = null;
    this.lastCommandSentMillis = null;
    this.controllerLostSinceMillis = null;
    this.gentleHaltSentForCurrentLoss = false;
    this.snapshotStaleSinceMillis = null;
    this.gentleStopSentForCurrentStaleSnapshot = false;
    if (wasArmed) {
      this.sensorController.endMotionSession();
    }
    try {
      await this.sensorController.stopMotors();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("control.manual_drive.stop_failed", { error: message });
    }
  }
}
