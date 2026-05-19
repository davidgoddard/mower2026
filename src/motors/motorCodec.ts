import type { MotorFeedbackSample, WheelSpeedCommand } from "./motorProtocol.js";
import { decodeOptionalUint16 } from "../protocols/codecPrimitives.js";

// Motor protocol payload lengths (implementation details)
const WHEEL_SPEED_COMMAND_LENGTH = 15;
const MOTOR_FEEDBACK_SAMPLE_LENGTH = 22;

// Motor codec scaling factors (implementation details)
const NORMALIZED_SCALE_MILLI_TO_UNIT = 1000;
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
  view.setInt16(4, Math.round(command.leftWheelTargetPercent * NORMALIZED_SCALE_MILLI_TO_UNIT), true);
  view.setInt16(6, Math.round(command.rightWheelTargetPercent * NORMALIZED_SCALE_MILLI_TO_UNIT), true);
  view.setUint8(8, command.enableDrive ? 1 : 0);
  view.setUint16(9, command.commandTimeoutMillis, true);
  view.setUint16(11, encodeOptionalUint16(command.maxAccelerationPercentPerSecond, NORMALIZED_SCALE_MILLI_TO_UNIT), true);
  view.setUint16(13, encodeOptionalUint16(command.maxDecelerationPercentPerSecond, NORMALIZED_SCALE_MILLI_TO_UNIT), true);

  return payload;
}

export function decodeMotorFeedbackSample(payload: Uint8Array): MotorFeedbackSample {
  if (payload.length !== MOTOR_FEEDBACK_SAMPLE_LENGTH) {
    throw new Error(`Invalid motor feedback payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const leftMotorCurrentAmps = decodeOptionalUint16(view, 14, CURRENT_SCALE_DECIAMP_TO_AMP);
  const rightMotorCurrentAmps = decodeOptionalUint16(view, 16, CURRENT_SCALE_DECIAMP_TO_AMP);

  return {
    timestampMillis: view.getUint32(0, true),
    leftEncoderDelta: view.getInt32(4, true),
    rightEncoderDelta: view.getInt32(8, true),
    leftPwmAppliedPercent: view.getInt8(12),
    rightPwmAppliedPercent: view.getInt8(13),
    watchdogHealthy: view.getUint8(18) === 1,
    faultFlags: view.getUint16(19, true),
    ...(leftMotorCurrentAmps === undefined ? {} : { leftMotorCurrentAmps }),
    ...(rightMotorCurrentAmps === undefined ? {} : { rightMotorCurrentAmps }),
  };
}
