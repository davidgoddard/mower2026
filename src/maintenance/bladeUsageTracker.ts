import { MowingRecordsStore } from "../config/mowingRecordsStore.js";
import { PoseCalibration } from "../config/poseCalibration.js";
import { SensorController } from "../sensing/sensorController.js";
import { MotorFeedbackUpdateEvent, SENSOR_EVENTS } from "../sensing/sensorEvents.js";

const PERSIST_INTERVAL_MS = 1_000;

export interface WheelDistanceCalibration {
  forwardLeftMetersPerTick: number;
  forwardRightMetersPerTick: number;
}

export function calculateBladeTravelMeters(
  leftEncoderDelta: number,
  rightEncoderDelta: number,
  calibration: WheelDistanceCalibration,
): number {
  return Math.max(
    Math.max(0, leftEncoderDelta) * calibration.forwardLeftMetersPerTick,
    Math.max(0, rightEncoderDelta) * calibration.forwardRightMetersPerTick,
  );
}

export class BladeUsageTracker {
  private pendingMeters = 0;
  private lastPersistedAt = 0;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sensorController: SensorController,
    private readonly poseCalibration: PoseCalibration,
    private readonly store: MowingRecordsStore,
  ) {}

  start(): void {
    this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);
  }

  async close(): Promise<void> {
    this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onMotorFeedback);
    await this.flush();
  }

  async flush(): Promise<void> {
    this.queuePersist();
    await this.persistChain;
  }

  private readonly onMotorFeedback = (event: MotorFeedbackUpdateEvent): void => {
    this.pendingMeters += calculateBladeTravelMeters(event.leftEncoderDelta, event.rightEncoderDelta, {
      forwardLeftMetersPerTick: this.poseCalibration.getForwardLeftEncoderMetersPerTick(),
      forwardRightMetersPerTick: this.poseCalibration.getForwardRightEncoderMetersPerTick(),
    });
    if (event.timestampMillis - this.lastPersistedAt >= PERSIST_INTERVAL_MS) {
      this.lastPersistedAt = event.timestampMillis;
      this.queuePersist();
    }
  };

  private queuePersist(): void {
    const meters = this.pendingMeters;
    this.pendingMeters = 0;
    if (meters <= 0) return;
    this.persistChain = this.persistChain.then(() => this.store.addBladeTravelMeters(meters));
  }
}
