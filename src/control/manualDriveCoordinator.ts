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
  MANUAL_DRIVE_RAMP_DOWN_TIME_MS,
  MANUAL_DRIVE_RAMP_UP_TIME_MS,
  MANUAL_DRIVE_SNAPSHOT_STALE_AFTER_MS,
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
  private controllerEventsRegistered = false;
  private readonly onControllerUpdate: (snapshot: HidGameControllerSnapshot) => void;
  private readonly onControllerArm: () => void;
  private readonly onControllerDisarm: () => void;
  private readonly onControllerError: (error: unknown) => void;

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
    this.onControllerUpdate = (snapshot: HidGameControllerSnapshot) => {
      this.snapshot = {
        ...snapshot,
        lastUpdateMillis: snapshot.lastUpdateMillis > 0 ? snapshot.lastUpdateMillis : this.nowMillis(),
      };
      this.clearGlobalStopFromManualInput(this.snapshot);
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
    };
    this.onControllerArm = () => {
      systemStop.clearStop("manual-drive-armed");
      this.manualDriveEnabled = true;
      this.sensorController.beginMotionSession();
      this.logger.info("control.manual_drive.armed");
    };
    this.onControllerDisarm = () => {
      this.logger.info("control.manual_drive.disarmed");
      void this.disableManualDrive();
    };
    this.onControllerError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("control.manual_drive.controller_error", { error: message });
    };
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
    this.unregisterControllerEvents();
    this.hidController.close();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    await this.disableManualDrive();
    this.logger.transition("running", "stopped");
  }

  private registerControllerEvents(): void {
    if (this.controllerEventsRegistered) {
      return;
    }
    this.controllerEventsRegistered = true;
    this.hidController.on("update", this.onControllerUpdate);
    this.hidController.on("right-top", this.onControllerArm);
    this.hidController.on("left-top", this.onControllerDisarm);
    this.hidController.on("error", this.onControllerError);
  }

  private unregisterControllerEvents(): void {
    if (!this.controllerEventsRegistered) {
      return;
    }
    this.controllerEventsRegistered = false;
    this.hidController.off("update", this.onControllerUpdate);
    this.hidController.off("right-top", this.onControllerArm);
    this.hidController.off("left-top", this.onControllerDisarm);
    this.hidController.off("error", this.onControllerError);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        if (systemStop.isStopped()) {
          // The sensor loop is already re-asserting the H-bridge disable
          // every tick while systemStop is latched.  We just need to
          // release our local "actively driving" flag so we don't keep
          // sending speed updates that would race with the disable.
          if (this.drivingActive) {
            this.drivingActive = false;
          }
          await this.sleep(this.controlIntervalMs);
          continue;
        }

        if (!this.manualDriveEnabled) {
          if (this.drivingActive) {
            this.drivingActive = false;
            await this.sensorController.requestNeutralMotorOutputs();
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
            await this.sensorController.requestNeutralMotorOutputs();
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
          MANUAL_DRIVE_SNAPSHOT_STALE_AFTER_MS,
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
            await this.sensorController.requestNeutralMotorOutputs();
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
    const elapsedSinceLastCommand =
      this.lastCommandSentMillis === null ? Number.POSITIVE_INFINITY : this.nowMillis() - this.lastCommandSentMillis;
    if (
      !this.drivingActive ||
      this.lastCommandedLeftWheelOutputPercent !== left ||
      this.lastCommandedRightWheelOutputPercent !== right ||
      elapsedSinceLastCommand >= this.commandRefreshIntervalMs
    ) {
      return true;
    }
    return false;
  }

  private clearGlobalStopFromManualInput(snapshot: HidGameControllerSnapshot): void {
    if (!this.manualDriveEnabled || !snapshot.connected || !systemStop.isStopped()) {
      return;
    }

    const hasPressedButton = Object.values(snapshot.buttons).some(Boolean);
    const hasDriveDemand = Math.abs(snapshot.speed) > 0.01 || Math.abs(snapshot.angleDegrees) > 1;
    if (!hasPressedButton && !hasDriveDemand) {
      return;
    }

    systemStop.clearStop("manual-drive-hid-command");
    this.logger.info("control.manual_drive.cleared_system_stop_from_hid", {
      speed: snapshot.speed,
      angleDegrees: snapshot.angleDegrees,
      pressedButtons: Object.entries(snapshot.buttons)
        .filter(([, pressed]) => pressed)
        .map(([label]) => label),
    });
  }

  private async sendManualWheelCommand(left: number, right: number): Promise<void> {
    this.drivingActive = true;
    this.lastCommandedLeftWheelOutputPercent = left;
    this.lastCommandedRightWheelOutputPercent = right;
    this.lastCommandSentMillis = this.nowMillis();
    await this.sensorController.setMotorWheelOutputs(left, right, {
      rampUpTimeMs: MANUAL_DRIVE_RAMP_UP_TIME_MS,
      rampDownTimeMs: MANUAL_DRIVE_RAMP_DOWN_TIME_MS,
    });
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
      await this.sensorController.requestNeutralMotorOutputs();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("control.manual_drive.stop_failed", { error: message });
    }
  }
}
