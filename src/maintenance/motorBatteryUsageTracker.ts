import { readJsonFile, writeJsonFile } from "../config/jsonFileStore.js";
import type { PoseCalibration } from "../config/poseCalibration.js";
import type { SensorController } from "../sensing/sensorController.js";
import { SENSOR_EVENTS, type MotorFeedbackUpdateEvent } from "../sensing/sensorEvents.js";

export interface MotorBatteryUsageState {
  readonly version: 1;
  readonly maximumCapacityAh: number;
  readonly returnToChargePercent: number;
  readonly usedAhSinceCharge: number;
  readonly combinedWheelMetersSinceCharge: number;
  readonly lastChargedAt: string | null;
  readonly updatedAt: string;
}

const DEFAULT_STATE: MotorBatteryUsageState = {
  version: 1,
  maximumCapacityAh: 50,
  returnToChargePercent: 15,
  usedAhSinceCharge: 0,
  combinedWheelMetersSinceCharge: 0,
  lastChargedAt: null,
  updatedAt: new Date(0).toISOString(),
};
const PERSIST_INTERVAL_MS = 10_000;
const MAX_INTEGRATION_INTERVAL_MS = 1_000;
const CURRENT_DEADBAND_AMPS = 0.1;

export class MotorBatteryUsageTracker {
  private state: MotorBatteryUsageState = DEFAULT_STATE;
  private lastSampleTimestampMillis: number | null = null;
  private lastPersistedAtMillis = 0;
  private dirty = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sensorController: SensorController,
    private readonly poseCalibration: PoseCalibration,
    private readonly filePath = "./data/motor-battery-usage.json",
  ) {}

  async load(): Promise<void> {
    try {
      this.state = this.validate(await readJsonFile(this.filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
      await writeJsonFile(this.filePath, this.state);
    }
  }

  start(): void { this.sensorController.on(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onFeedback); }
  snapshot(): MotorBatteryUsageState { return structuredClone(this.state); }

  isReturnDue(): boolean {
    const remainingPercent = 100 * Math.max(0, this.state.maximumCapacityAh - this.state.usedAhSinceCharge)
      / this.state.maximumCapacityAh;
    return remainingPercent <= this.state.returnToChargePercent;
  }

  async updateSettings(maximumCapacityAh: unknown, returnToChargePercent: unknown): Promise<MotorBatteryUsageState> {
    const capacity = Number(maximumCapacityAh);
    const percentage = Number(returnToChargePercent);
    if (!Number.isFinite(capacity) || capacity <= 0 || capacity > 1000) throw new Error("maximum_capacity_ah_invalid");
    if (!Number.isFinite(percentage) || percentage < 0 || percentage >= 100) throw new Error("return_to_charge_percent_invalid");
    this.state = { ...this.state, maximumCapacityAh: capacity, returnToChargePercent: percentage, updatedAt: new Date().toISOString() };
    this.dirty = true;
    await this.flush();
    return this.snapshot();
  }

  async markCharged(): Promise<MotorBatteryUsageState> {
    const now = new Date().toISOString();
    this.state = { ...this.state, usedAhSinceCharge: 0, combinedWheelMetersSinceCharge: 0, lastChargedAt: now, updatedAt: now };
    this.lastSampleTimestampMillis = null;
    this.dirty = true;
    await this.flush();
    return this.snapshot();
  }

  async resetDistance(): Promise<void> {
    this.state = { ...this.state, combinedWheelMetersSinceCharge: 0, updatedAt: new Date().toISOString() };
    this.dirty = true;
    await this.flush();
  }

  async close(): Promise<void> {
    this.sensorController.off(SENSOR_EVENTS.MOTOR_FEEDBACK_UPDATE, this.onFeedback);
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) { await this.persistChain; return; }
    this.dirty = false;
    const snapshot = this.snapshot();
    this.persistChain = this.persistChain.then(() => writeJsonFile(this.filePath, snapshot));
    await this.persistChain;
  }

  private readonly onFeedback = (event: MotorFeedbackUpdateEvent): void => {
    const previousTimestamp = this.lastSampleTimestampMillis;
    this.lastSampleTimestampMillis = event.timestampMillis;
    const elapsedMs = previousTimestamp === null ? 0 : event.timestampMillis - previousTimestamp;
    const usableElapsedMs = elapsedMs > 0 && elapsedMs <= MAX_INTEGRATION_INTERVAL_MS ? elapsedMs : 0;
    const current = (Math.max(0, event.leftMotorCurrentAmps ?? 0) >= CURRENT_DEADBAND_AMPS ? Math.max(0, event.leftMotorCurrentAmps ?? 0) : 0)
      + (Math.max(0, event.rightMotorCurrentAmps ?? 0) >= CURRENT_DEADBAND_AMPS ? Math.max(0, event.rightMotorCurrentAmps ?? 0) : 0);
    const usedAh = current * usableElapsedMs / 3_600_000;
    const combinedMeters = Math.abs(event.leftEncoderDelta) * this.poseCalibration.getForwardLeftEncoderMetersPerTick()
      + Math.abs(event.rightEncoderDelta) * this.poseCalibration.getForwardRightEncoderMetersPerTick();
    if (usedAh > 0 || combinedMeters > 0) {
      this.state = {
        ...this.state,
        usedAhSinceCharge: this.state.usedAhSinceCharge + usedAh,
        combinedWheelMetersSinceCharge: this.state.combinedWheelMetersSinceCharge + combinedMeters,
        updatedAt: new Date().toISOString(),
      };
      this.dirty = true;
    }
    if (event.timestampMillis - this.lastPersistedAtMillis >= PERSIST_INTERVAL_MS) {
      this.lastPersistedAtMillis = event.timestampMillis;
      void this.flush();
    }
  };

  private validate(raw: unknown): MotorBatteryUsageState {
    const value = raw as Partial<MotorBatteryUsageState> | null;
    const finite = (candidate: unknown, fallback: number) => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
    return {
      version: 1,
      maximumCapacityAh: Math.max(0.01, finite(value?.maximumCapacityAh, 50)),
      returnToChargePercent: Math.min(99, Math.max(0, finite(value?.returnToChargePercent, 15))),
      usedAhSinceCharge: Math.max(0, finite(value?.usedAhSinceCharge, 0)),
      combinedWheelMetersSinceCharge: Math.max(0, finite(value?.combinedWheelMetersSinceCharge, 0)),
      lastChargedAt: typeof value?.lastChargedAt === "string" ? value.lastChargedAt : null,
      updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    };
  }
}
