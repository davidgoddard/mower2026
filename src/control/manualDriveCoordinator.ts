import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { HidGameController, HidGameControllerSnapshot } from "../controller/hidGameController.js";
import { SensorController } from "../sensing/sensorController.js";
import { computeManualDriveDemand, normalizeManualTurnDemand } from "./manualDriveProfile.js";
import { systemStop } from "./systemStop.js";
import { MANUAL_DRIVE_LOOP_INTERVAL_MS, MAX_WHEEL_SPEED_MPS_DEFAULT } from "../constants.js";

interface ManualDriveCoordinatorOptions {
  logger: SessionLogger;
  sensorController: SensorController;
  hidController: HidGameController;
  controlIntervalMs?: number;
  maxWheelSpeedMetersPerSecond?: number;
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
  private readonly maxWheelSpeedMetersPerSecond: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private manualDriveEnabled = false;
  private snapshot: HidGameControllerSnapshot = disconnectedSnapshot();
  private drivingActive = false;
  private lastCommandedLeftMetersPerSecond: number | null = null;
  private lastCommandedRightMetersPerSecond: number | null = null;
  private motorOperationActive = false;

  constructor(options: ManualDriveCoordinatorOptions) {
    this.logger = options.logger.child({ context: "control", source: "ManualDriveCoordinator" });
    this.sensorController = options.sensorController;
    this.hidController = options.hidController;
    this.controlIntervalMs = options.controlIntervalMs ?? MANUAL_DRIVE_LOOP_INTERVAL_MS;
    this.maxWheelSpeedMetersPerSecond = options.maxWheelSpeedMetersPerSecond ?? MAX_WHEEL_SPEED_MPS_DEFAULT;
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
      this.snapshot = snapshot;
      if (!snapshot.connected && this.manualDriveEnabled) {
        this.logger.warn("control.manual_drive.disarmed_controller_disconnected");
        void this.disableManualDrive();
      }
    });

    this.hidController.on("right-top", () => {
      systemStop.clearStop("manual-drive-armed");
      this.beginMotorOperation();
      this.manualDriveEnabled = true;
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
            await this.sensorController.stopMotors();
          }
          await this.sleep(this.controlIntervalMs);
          continue;
        }

        if (!this.manualDriveEnabled || !this.snapshot.connected) {
          if (this.drivingActive) {
            this.drivingActive = false;
            await this.sensorController.stopMotors();
          }
          await this.sleep(this.controlIntervalMs);
          continue;
        }

        const demand = computeManualDriveDemand({
          speedDemand: this.snapshot.speed,
          turnDemand: normalizeManualTurnDemand(this.snapshot.angleDegrees),
          maxWheelSpeedMetersPerSecond: this.maxWheelSpeedMetersPerSecond,
        });

        if (demand.mode === "stopped") {
          if (this.drivingActive) {
            this.drivingActive = false;
            this.lastCommandedLeftMetersPerSecond = null;
            this.lastCommandedRightMetersPerSecond = null;
            await this.sensorController.stopMotors();
          }
        } else {
          const left = demand.requestedLeftMetersPerSecond;
          const right = demand.requestedRightMetersPerSecond;
          const commandChanged =
            !this.drivingActive ||
            this.lastCommandedLeftMetersPerSecond !== left ||
            this.lastCommandedRightMetersPerSecond !== right;

          if (commandChanged) {
            this.drivingActive = true;
            this.lastCommandedLeftMetersPerSecond = left;
            this.lastCommandedRightMetersPerSecond = right;
            await this.sensorController.setMotorWheelSpeeds(left, right);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("control.manual_drive.loop_error", { error: message });
      }

      await this.sleep(this.controlIntervalMs);
    }
  }

  private beginMotorOperation(): void {
    if (this.motorOperationActive) {
      return;
    }

    this.motorOperationActive = true;
    this.sensorController.beginMotorOperation();
  }

  private async endMotorOperation(): Promise<void> {
    if (!this.motorOperationActive) {
      return;
    }

    this.motorOperationActive = false;
    try {
      await this.sensorController.endMotorOperation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("control.manual_drive.stop_failed", { error: message });
    }
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
    systemStop.requestStop("manual-drive", "manual_drive_disabled");
    this.manualDriveEnabled = false;
    this.drivingActive = false;
    this.lastCommandedLeftMetersPerSecond = null;
    this.lastCommandedRightMetersPerSecond = null;
    try {
      await this.sensorController.stopMotors();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("control.manual_drive.stop_failed", { error: message });
    } finally {
      await this.endMotorOperation();
    }
  }
}
