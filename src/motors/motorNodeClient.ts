import { decodeFrame, encodeFrame, frameLengthForPayload } from "../bus/frameCodec.js";
import { I2cBusController, I2cTaskReplacedError } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import {
  MOTOR_COMMAND_REFRESH_INTERVAL_MS,
  MOTOR_COMMAND_WATCHDOG_TIMEOUT_MS,
  MOTOR_DECEL_PERCENT_PER_SECOND,
  MOTOR_ACCEL_PERCENT_PER_SECOND,
} from "../constants.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../protocols/commonProtocol.js";
import { decodeMotorFeedbackSample, encodeWheelSpeedCommand, motorFeedbackSampleLength } from "./motorCodec.js";
import type { MotorFeedbackSample, WheelSpeedCommand } from "./motorProtocol.js";
import { MotorCalibration } from "../config/motorCalibration.js";

interface MotorNodeClientOptions {
  address: number;
  motorCalibration?: MotorCalibration;
  nowMillis?: () => number;
  commandTimeoutMillis?: number;
  maxReadAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  setCommandRefreshTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearCommandRefreshTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  currentCalibrationDelayMs?: number;
}

interface WheelSpeedCommandOptions {
  /** Override deceleration rate in %/s (replaces the calibrated default). */
  decelPercentPerSecond?: number;
  /** Override acceleration rate in %/s (replaces the calibrated default). */
  accelPercentPerSecond?: number;
  /** Legacy override: ramp-down time in ms — converted to %/s internally. */
  rampDownTimeMs?: number;
  /** Legacy override: ramp-up time in ms — converted to %/s internally. */
  rampUpTimeMs?: number;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function clampNormalizedTarget(target: number): number {
  return Math.max(-1, Math.min(1, target));
}

const MOTOR_COMMAND_QUEUE_KEY = "motor.command";

/**
 * Convert a deceleration/acceleration rate in %/s to the wire field value
 * expected by the ESP32 motor codec.
 *
 * The on-wire field is `1 / rampSeconds` (a frequency, in Hz), scaled by 1000
 * for uint16 encoding.  The firmware computes `rampMs = (1 / wireValue) × 1000`,
 * which is equivalent to `rampMs = 100_000 / decelPercentPerSecond`.
 *
 * Example: 250 %/s → rampSeconds = 100/250 = 0.4 s → wireValue = 1/0.4 = 2.5.
 */
function wireRateFromDecelPercentPerSecond(decelPercentPerSecond: number): number {
  return decelPercentPerSecond / 100;
}

export class MotorNodeClient {
  private sequence = 0;
  private readonly controller: I2cBusController;
  private readonly address: number;
  private readonly motorCalibration: MotorCalibration | null;
  private readonly nowMillis: () => number;
  private readonly commandTimeoutMillis: number;
  private readonly maxReadAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly setCommandRefreshTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearCommandRefreshTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private lastSentCommand: WheelSpeedCommand | null = null;
  private commandRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSensorsCalibrated = false;
  private currentCalibrationPromise: Promise<void> | null = null;
  private readonly currentCalibrationDelayMs: number;
  private commandGeneration = 0;
  private calibrationGeneration = 0;

  constructor(controller: I2cBusController, options: MotorNodeClientOptions) {
    this.controller = controller;
    this.address = options.address;
    this.motorCalibration = options.motorCalibration ?? null;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.commandTimeoutMillis = options.commandTimeoutMillis ?? MOTOR_COMMAND_WATCHDOG_TIMEOUT_MS;
    this.maxReadAttempts = options.maxReadAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 20;
    this.sleep = options.sleep ?? defaultSleep;
    this.setCommandRefreshTimer = options.setCommandRefreshTimer ?? setTimeout;
    this.clearCommandRefreshTimer = options.clearCommandRefreshTimer ?? clearTimeout;
    this.currentCalibrationDelayMs = options.currentCalibrationDelayMs ?? 400;
  }

  async sendWheelSpeedCommand(
    leftWheelTargetPercent: number,
    rightWheelTargetPercent: number,
    options: WheelSpeedCommandOptions = {},
  ): Promise<void> {
    const commandGeneration = ++this.commandGeneration;
    // The motor drive stays enabled by default. Bringing the mower to rest
    // is the responsibility of {@link SensorController.stopMotors}, which
    // sends a ramped target=0 with the drive still enabled so the ESP32
    // honours the configured deceleration profile rather than slamming the
    // H-bridges off. The dedicated {@link stop} method (and the systemStop
    // re-assert in the sensor loop) are the only paths that send
    // enableDrive=false.

    if (leftWheelTargetPercent !== 0 || rightWheelTargetPercent !== 0) {
      await this.ensureCurrentSensorsCalibrated();
      if (commandGeneration !== this.commandGeneration) return;
    }

    // Resolve deceleration rate: explicit %/s > legacy ms > calibrated > constant default.
    const decelPercentPerSecond = options.decelPercentPerSecond
      ?? (options.rampDownTimeMs != null ? 100_000 / options.rampDownTimeMs : undefined)
      ?? this.motorCalibration?.getDecelPercentPerSecond()
      ?? MOTOR_DECEL_PERCENT_PER_SECOND;

    const accelPercentPerSecond = options.accelPercentPerSecond
      ?? (options.rampUpTimeMs != null ? 100_000 / options.rampUpTimeMs : undefined)
      ?? this.motorCalibration?.getAccelPercentPerSecond()
      ?? MOTOR_ACCEL_PERCENT_PER_SECOND;

    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetPercent: clampNormalizedTarget(leftWheelTargetPercent),
      rightWheelTargetPercent: clampNormalizedTarget(rightWheelTargetPercent),
      enableDrive: true,
      commandTimeoutMillis: this.commandTimeoutMillis,
      // Wire field is 1/rampSeconds, not %/s — convert before sending.
      maxAccelerationPercentPerSecond: wireRateFromDecelPercentPerSecond(accelPercentPerSecond),
      maxDecelerationPercentPerSecond: wireRateFromDecelPercentPerSecond(decelPercentPerSecond),
    };

    if (this.isDuplicateCommand(command)) {
      return;
    }

    this.cancelCommandRefresh();
    this.lastSentCommand = command;
    await this.writeCommand(command);
    if (this.lastSentCommand === command) {
      this.scheduleCommandRefresh();
    }
  }

  async stop(): Promise<void> {
    this.commandGeneration += 1;
    this.calibrationGeneration += 1;
    this.currentSensorsCalibrated = false;
    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetPercent: 0,
      rightWheelTargetPercent: 0,
      enableDrive: false,
      commandTimeoutMillis: this.commandTimeoutMillis,
    };

    if (this.isDuplicateCommand(command)) {
      return;
    }

    this.cancelCommandRefresh();
    this.lastSentCommand = command;
    await this.writeCommand(command);
    if (this.lastSentCommand === command) {
      this.scheduleCommandRefresh();
    }
  }

  close(): void {
    this.commandGeneration += 1;
    this.calibrationGeneration += 1;
    this.cancelCommandRefresh();
    this.lastSentCommand = null;
    this.currentSensorsCalibrated = false;
    this.currentCalibrationPromise = null;
  }

  private async ensureCurrentSensorsCalibrated(): Promise<void> {
    if (this.currentSensorsCalibrated) return;
    if (this.currentCalibrationPromise) {
      await this.currentCalibrationPromise;
      return;
    }

    const calibrationGeneration = this.calibrationGeneration;
    this.currentCalibrationPromise = (async () => {
      this.cancelCommandRefresh();
      this.lastSentCommand = null;
      const frame = encodeFrame(
        {
          version: PROTOCOL_VERSION,
          nodeId: NodeId.Motor,
          messageType: MessageType.MotorCurrentCalibrationCommand,
          flags: 0,
          sequence: this.sequence,
        },
        new Uint8Array(0),
      );
      this.sequence = (this.sequence + 1) & 0xffff;
      await this.controller.queueWrite({
        key: "motor.current-calibration",
        priority: I2C_PRIORITY.stop,
        address: this.address,
        payload: frame,
      });
      await this.sleep(this.currentCalibrationDelayMs);
      if (calibrationGeneration === this.calibrationGeneration) {
        this.currentSensorsCalibrated = true;
      }
    })();

    try {
      await this.currentCalibrationPromise;
    } finally {
      this.currentCalibrationPromise = null;
    }
  }

  async refreshFeedback(): Promise<MotorFeedbackSample> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        const responseFrame = await this.controller.queueRead({
          key: "motor.feedback",
          priority: I2C_PRIORITY.motorSpeed,
          address: this.address,
          // The motor ESP always exposes its latest pre-encoded snapshot.
          // An empty request makes LiveI2cTransport perform a direct read.
          requestPayload: new Uint8Array(0),
          responseLength: frameLengthForPayload(motorFeedbackSampleLength()),
        });

        let decoded: ReturnType<typeof decodeFrame>;
        try {
          decoded = decodeFrame(responseFrame);
        } catch (decodeError) {
          const prefix = Array.from(responseFrame.subarray(0, Math.min(8, responseFrame.length)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
          const msg = decodeError instanceof Error ? decodeError.message : String(decodeError);
          throw new Error(`${msg} [raw: ${prefix}]`);
        }
        if (decoded.header.nodeId !== NodeId.Motor || decoded.header.messageType !== MessageType.MotorFeedbackSample) {
          throw new Error("Unexpected motor response frame");
        }
        return {
          ...decodeMotorFeedbackSample(decoded.payload),
          sequence: decoded.header.sequence,
        };
      } catch (error) {
        lastError = error;
        if (attempt < this.maxReadAttempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private scheduleCommandRefresh(): void {
    const command = this.lastSentCommand;
    if (!this.isRefreshableCommand(command)) {
      return;
    }

    this.cancelCommandRefresh();
    const timer = this.setCommandRefreshTimer(() => {
      if (this.commandRefreshTimer !== timer) return;
      this.commandRefreshTimer = null;
      void this.refreshLatestCommand().catch(() => {});
    }, MOTOR_COMMAND_REFRESH_INTERVAL_MS);
    timer.unref?.();
    this.commandRefreshTimer = timer;
  }

  private cancelCommandRefresh(): void {
    if (this.commandRefreshTimer === null) return;
    this.clearCommandRefreshTimer(this.commandRefreshTimer);
    this.commandRefreshTimer = null;
  }

  private async refreshLatestCommand(): Promise<void> {
    const current = this.lastSentCommand;
    if (!this.isRefreshableCommand(current)) return;

    const command: WheelSpeedCommand = {
      ...current,
      timestampMillis: this.nowMillis(),
    };
    this.lastSentCommand = command;
    try {
      await this.writeCommand(command);
    } finally {
      if (this.lastSentCommand === command) {
        this.scheduleCommandRefresh();
      }
    }
  }

  private isRefreshableCommand(command: WheelSpeedCommand | null): command is WheelSpeedCommand {
    return command !== null;
  }

  private async writeCommand(command: WheelSpeedCommand): Promise<void> {
    const requestsMotion = command.enableDrive
      && (command.leftWheelTargetPercent !== 0 || command.rightWheelTargetPercent !== 0);
    const priority = requestsMotion ? I2C_PRIORITY.motorSpeed : I2C_PRIORITY.stop;
    const frame = encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Motor,
        messageType: MessageType.MotorWheelSpeedCommand,
        flags: 0,
        sequence: this.sequence,
      },
      encodeWheelSpeedCommand(command),
    );
    this.sequence = (this.sequence + 1) & 0xffff;

    try {
      await this.controller.queueWrite({
        // Every wheel command represents the same logical state. A newer
        // start, neutral, disabled stop, or heartbeat must therefore replace
        // any older queued wheel command regardless of its command kind.
        key: MOTOR_COMMAND_QUEUE_KEY,
        priority,
        address: this.address,
        payload: frame,
      });
    } catch (error) {
      if (error instanceof I2cTaskReplacedError && error.key === MOTOR_COMMAND_QUEUE_KEY) {
        return;
      }
      throw error;
    }
  }

  private isDuplicateCommand(command: WheelSpeedCommand): boolean {
    const previous = this.lastSentCommand;
    if (previous === null) {
      return false;
    }

    return (
      previous.leftWheelTargetPercent === command.leftWheelTargetPercent &&
      previous.rightWheelTargetPercent === command.rightWheelTargetPercent &&
      previous.enableDrive === command.enableDrive &&
      previous.maxAccelerationPercentPerSecond === command.maxAccelerationPercentPerSecond &&
      previous.maxDecelerationPercentPerSecond === command.maxDecelerationPercentPerSecond
    );
  }
}
