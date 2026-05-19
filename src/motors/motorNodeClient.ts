import { decodeFrame, encodeFrame, frameLengthForPayload } from "../bus/frameCodec.js";
import { I2cBusController } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { MOTOR_RAMP_DOWN_TIME_MS, MOTOR_RAMP_UP_TIME_MS } from "../constants.js";
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

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

  constructor(controller: I2cBusController, options: MotorNodeClientOptions) {
    this.controller = controller;
    this.address = options.address;
    this.motorCalibration = options.motorCalibration ?? null;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.commandTimeoutMillis = options.commandTimeoutMillis ?? 300;
    this.maxReadAttempts = options.maxReadAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 20;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async sendWheelSpeedCommand(
    leftWheelTargetMetersPerSecond: number,
    rightWheelTargetMetersPerSecond: number,
  ): Promise<void> {
    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetMetersPerSecond,
      rightWheelTargetMetersPerSecond,
      enableDrive: true,
      commandTimeoutMillis: this.commandTimeoutMillis,
      maxAccelerationMetersPerSecondSquared: (this.motorCalibration?.getRampUpTime() ?? MOTOR_RAMP_UP_TIME_MS) / 1000,
      maxDecelerationMetersPerSecondSquared: (this.motorCalibration?.getRampDownTime() ?? MOTOR_RAMP_DOWN_TIME_MS) / 1000,
    };

    await this.writeCommand(command, "motor.speed", I2C_PRIORITY.motorSpeed);
  }

  async stop(): Promise<void> {
    const command: WheelSpeedCommand = {
      timestampMillis: this.nowMillis(),
      leftWheelTargetMetersPerSecond: 0,
      rightWheelTargetMetersPerSecond: 0,
      enableDrive: false,
      commandTimeoutMillis: this.commandTimeoutMillis,
    };

    await this.writeCommand(command, "motor.stop", I2C_PRIORITY.stop);
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

    await this.controller.queueWrite({
      key,
      priority,
      address: this.address,
      payload: frame,
    });
  }
}
