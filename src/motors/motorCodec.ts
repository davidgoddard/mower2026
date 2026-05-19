import type { MotorFeedbackSample, WheelSpeedCommand } from "./motorProtocol.js";
import { decodeOptionalUint16 } from "../protocols/codecPrimitives.js";

// Motor protocol payload lengths (implementation details)
const WHEEL_SPEED_COMMAND_LENGTH = 15;
const MOTOR_FEEDBACK_SAMPLE_LENGTH = 26;

// Motor codec scaling factors (implementation details)
const VELOCITY_SCALE_MMS_TO_MS = 1000;
const ACCELERATION_SCALE_MILLI_TO_UNIT = 1000;
const CURRENT_SCALE_DECIAMP_TO_AMP = 10;

// Optional field sentinel values (implementation details)
const OPTIONAL_UINT16_SENTINEL = 0xffff;
const OPTIONAL_UINT16_MAX_VALUE = 0xfffe;

function encodeOptionalUint16(value: number | undefined, scale: number): number {
  if (value == null) {
    return OPTIONAL_UINT16_SENTINEL;
  }

  return Math.max(0, Math.min(OPTIONAL_UINT16_MAX_VALUE, Math.round(value * scale)));
}

export function wheelSpeedCommandLength(): number {
  return WHEEL_SPEED_COMMAND_LENGTH;
}

export function motorFeedbackSampleLength(): number {
  return MOTOR_FEEDBACK_SAMPLE_LENGTH;
}

export function encodeWheelSpeedCommand(command: WheelSpeedCommand): Uint8Array {
  const payload = new Uint8Array(WHEEL_SPEED_COMMAND_LENGTH);
  const view = new DataView(payload.buffer);

  view.setUint32(0, command.timestampMillis, true);
  view.setInt16(4, Math.round(command.leftWheelTargetMetersPerSecond * VELOCITY_SCALE_MMS_TO_MS), true);
  view.setInt16(6, Math.round(command.rightWheelTargetMetersPerSecond * VELOCITY_SCALE_MMS_TO_MS), true);
  view.setUint8(8, command.enableDrive ? 1 : 0);
  view.setUint16(9, command.commandTimeoutMillis, true);
  view.setUint16(11, encodeOptionalUint16(command.maxAccelerationMetersPerSecondSquared, ACCELERATION_SCALE_MILLI_TO_UNIT), true);
  view.setUint16(13, encodeOptionalUint16(command.maxDecelerationMetersPerSecondSquared, ACCELERATION_SCALE_MILLI_TO_UNIT), true);

  return payload;
}

export function decodeMotorFeedbackSample(payload: Uint8Array): MotorFeedbackSample {
  if (payload.length !== MOTOR_FEEDBACK_SAMPLE_LENGTH) {
    throw new Error(`Invalid motor feedback payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const leftMotorCurrentAmps = decodeOptionalUint16(view, 18, CURRENT_SCALE_DECIAMP_TO_AMP);
  const rightMotorCurrentAmps = decodeOptionalUint16(view, 20, CURRENT_SCALE_DECIAMP_TO_AMP);

  return {
    timestampMillis: view.getUint32(0, true),
    leftWheelActualMetersPerSecond: view.getInt16(4, true) / VELOCITY_SCALE_MMS_TO_MS,
    rightWheelActualMetersPerSecond: view.getInt16(6, true) / VELOCITY_SCALE_MMS_TO_MS,
    leftEncoderDelta: view.getInt32(8, true),
    rightEncoderDelta: view.getInt32(12, true),
    leftPwmApplied: view.getInt8(16),
    rightPwmApplied: view.getInt8(17),
    watchdogHealthy: view.getUint8(22) === 1,
    faultFlags: view.getUint16(23, true),
    ...(leftMotorCurrentAmps === undefined ? {} : { leftMotorCurrentAmps }),
    ...(rightMotorCurrentAmps === undefined ? {} : { rightMotorCurrentAmps }),
  };
}

