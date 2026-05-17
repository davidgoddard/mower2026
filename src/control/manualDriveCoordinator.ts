import { SessionLogger } from "../logging/index.js";
import { LoggerScope } from "../logging/types.js";
import { HidGameController, HidGameControllerSnapshot } from "../controller/hidGameController.js";
import { SensorController } from "../sensing/sensorController.js";
import { computeManualDriveDemand, normalizeManualTurnDemand } from "./manualDriveProfile.js";

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

  constructor(options: ManualDriveCoordinatorOptions) {
    this.logger = options.logger.child({ context: "control", source: "ManualDriveCoordinator" });
    this.sensorController = options.sensorController;
    this.hidController = options.hidController;
    this.controlIntervalMs = options.controlIntervalMs ?? 100;
    this.maxWheelSpeedMetersPerSecond = options.maxWheelSpeedMetersPerSecond ?? 0.75;
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
    this.manualDriveEnabled = false;
    this.drivingActive = false;
    try {
      await this.sensorController.stopMotors();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("control.manual_drive.stop_failed", { error: message });
    }
    this.logger.transition("running", "stopped");
  }

  private registerControllerEvents(): void {
    this.hidController.on("update", (snapshot: HidGameControllerSnapshot) => {
      this.snapshot = snapshot;
      if (!snapshot.connected && this.manualDriveEnabled) {
        this.manualDriveEnabled = false;
        this.logger.warn("control.manual_drive.disarmed_controller_disconnected");
        void this.sensorController.stopMotors();
      }
    });

    this.hidController.on("right-top", () => {
      this.manualDriveEnabled = true;
      this.logger.info("control.manual_drive.armed");
    });

    this.hidController.on("left-top", () => {
      this.manualDriveEnabled = false;
      this.logger.info("control.manual_drive.disarmed");
      void this.sensorController.stopMotors();
    });

    this.hidController.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("control.manual_drive.controller_error", { error: message });
    });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
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
            await this.sensorController.stopMotors();
          }
        } else {
          this.drivingActive = true;
          await this.sensorController.setMotorWheelSpeeds(
            demand.requestedLeftMetersPerSecond,
            demand.requestedRightMetersPerSecond,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("control.manual_drive.loop_error", { error: message });
      }

      await this.sleep(this.controlIntervalMs);
    }
  }
}

