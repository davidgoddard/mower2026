import { decodeFrame, encodeFrame, frameLengthForPayload } from "../bus/frameCodec.js";
import { I2cBusController, I2cTaskReplacedError } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { MOTOR_COMMAND_WATCHDOG_TIMEOUT_MS, MOTOR_RAMP_DOWN_TIME_MS, MOTOR_RAMP_UP_TIME_MS } from "../constants.js";
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
}

interface WheelSpeedCommandOptions {
  rampUpTimeMs?: number;
  rampDownTimeMs?: number;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function rampSecondsFromMillis(rampMillis: number): number {
  return Math.max(0.001, rampMillis / 1000);
}

function ratePerSecondFromRampMillis(rampMillis: number): number {
  return 1 / rampSecondsFromMillis(rampMillis);
}

function clampNormalizedTarget(target: number): number {
  return Math.max(-1, Math.min(1, target));
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
  private lastSentCommand: WheelSpeedCommand | null = null;

  constructor(controller: I2cBusController, options: MotorNodeClientOptions) {
    this.controller = controller;
    this.address = options.address;
    this.motorCalibration = options.motorCalibration ?? null;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.commandTimeoutMillis = options.commandTimeoutMillis ?? MOTOR_COMMAND_WATCHDOG_TIMEOUT_MS;
    this.maxReadAttempts = options.maxReadAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 20;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async sendWheelSpeedCommand(
    leftWheelTargetPercent: number,
    rightWheelTargetPercent: number,
    options: WheelSpeedCommandOptions = {},
  ): Promise<void> {
    // The motor drive stays enabled by default. Bringing the mower to rest
    // is the responsibility of {@link SensorController.stopMotors}, which
    // sends a ramped target=0 with the drive still enabled so the ESP32
    // honours the configured deceleration profile rather than slamming the
    // H-bridges off. The dedicated {@link stop} method (and the systemStop
    // re-assert in the sensor loop) are the only paths that send
    // enableDrive=false.
    const rampUpTimeMs = options.rampUpTimeMs ?? this.motorCalibration?.getRampUpTime() ?? MOTOR_RAMP_UP_TIME_MS;
    const rampDownTimeMs = options.rampDownTimeMs ?? this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS;
    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetPercent: clampNormalizedTarget(leftWheelTargetPercent),
      rightWheelTargetPercent: clampNormalizedTarget(rightWheelTargetPercent),
      enableDrive: true,
      commandTimeoutMillis: this.commandTimeoutMillis,
      maxAccelerationPercentPerSecond: ratePerSecondFromRampMillis(rampUpTimeMs),
      maxDecelerationPercentPerSecond: ratePerSecondFromRampMillis(rampDownTimeMs),
    };

    if (this.isDuplicateCommand(command)) {
      return;
    }

    await this.writeCommand(command, "motor.speed", I2C_PRIORITY.motorSpeed);
    this.lastSentCommand = command;
  }

  async stop(): Promise<void> {
    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetPercent: 0,
      rightWheelTargetPercent: 0,
      enableDrive: false,
      commandTimeoutMillis: this.commandTimeoutMillis,
    };

    await this.writeCommand(command, "motor.stop", I2C_PRIORITY.stop);
    this.lastSentCommand = command;
  }

  async refreshFeedback(): Promise<MotorFeedbackSample> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        const requestFrame = encodeFrame(
          {
            version: PROTOCOL_VERSION,
            nodeId: NodeId.Motor,
            messageType: MessageType.MotorFeedbackSample,
            flags: 0,
            sequence: this.sequence,
          },
          new Uint8Array(0),
        );
        this.sequence = (this.sequence + 1) & 0xffff;

        const responseFrame = await this.controller.queueRead({
          key: "motor.feedback",
          priority: I2C_PRIORITY.motorSpeed,
          address: this.address,
          requestPayload: requestFrame,
          responseLength: frameLengthForPayload(motorFeedbackSampleLength()),
        });

        const decoded = decodeFrame(responseFrame);
        if (decoded.header.nodeId !== NodeId.Motor || decoded.header.messageType !== MessageType.MotorFeedbackSample) {
          throw new Error("Unexpected motor response frame");
        }

        return decodeMotorFeedbackSample(decoded.payload);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxReadAttempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async writeCommand(command: WheelSpeedCommand, key: string, priority: number): Promise<void> {
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
        key,
        priority,
        address: this.address,
        payload: frame,
      });
    } catch (error) {
      if (error instanceof I2cTaskReplacedError && error.key === key) {
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
