import type { MotorFeedbackSample, WheelSpeedCommand } from "./motorProtocol.js";
import { decodeOptionalUint16, encodeOptionalUint16 } from "./codecPrimitives.js";

const WHEEL_SPEED_COMMAND_LENGTH = 15;
const MOTOR_FEEDBACK_SAMPLE_LENGTH = 26;

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
  view.setInt16(4, Math.round(command.leftWheelTargetMetersPerSecond * 1000), true);
  view.setInt16(6, Math.round(command.rightWheelTargetMetersPerSecond * 1000), true);
  view.setUint8(8, command.enableDrive ? 1 : 0);
  view.setUint16(9, command.commandTimeoutMillis, true);
  encodeOptionalUint16(view, 11, command.maxAccelerationMetersPerSecondSquared, 1000);
  encodeOptionalUint16(view, 13, command.maxDecelerationMetersPerSecondSquared, 1000);

  return payload;
}

export function decodeWheelSpeedCommand(payload: Uint8Array): WheelSpeedCommand {
  if (payload.length !== WHEEL_SPEED_COMMAND_LENGTH) {
    throw new Error(`Invalid wheel speed command payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const maxAccelerationMetersPerSecondSquared = decodeOptionalUint16(view, 11, 1000);
  const maxDecelerationMetersPerSecondSquared = decodeOptionalUint16(view, 13, 1000);

  return {
    timestampMillis: view.getUint32(0, true),
    leftWheelTargetMetersPerSecond: view.getInt16(4, true) / 1000,
    rightWheelTargetMetersPerSecond: view.getInt16(6, true) / 1000,
    enableDrive: view.getUint8(8) === 1,
    commandTimeoutMillis: view.getUint16(9, true),
    ...(maxAccelerationMetersPerSecondSquared === undefined ? {} : { maxAccelerationMetersPerSecondSquared }),
    ...(maxDecelerationMetersPerSecondSquared === undefined ? {} : { maxDecelerationMetersPerSecondSquared }),
  };
}

export function encodeMotorFeedbackSample(sample: MotorFeedbackSample): Uint8Array {
  const payload = new Uint8Array(MOTOR_FEEDBACK_SAMPLE_LENGTH);
  const view = new DataView(payload.buffer);

  view.setUint32(0, sample.timestampMillis, true);
  view.setInt16(4, Math.round(sample.leftWheelActualMetersPerSecond * 1000), true);
  view.setInt16(6, Math.round(sample.rightWheelActualMetersPerSecond * 1000), true);
  view.setInt32(8, sample.leftEncoderDelta, true);
  view.setInt32(12, sample.rightEncoderDelta, true);
  view.setInt8(16, sample.leftPwmApplied);
  view.setInt8(17, sample.rightPwmApplied);
  encodeOptionalUint16(view, 18, sample.leftMotorCurrentAmps, 10);
  encodeOptionalUint16(view, 20, sample.rightMotorCurrentAmps, 10);
  view.setUint8(22, sample.watchdogHealthy ? 1 : 0);
  view.setUint16(23, sample.faultFlags, true);
  view.setUint8(25, 0);

  return payload;
}

export function decodeMotorFeedbackSample(payload: Uint8Array): MotorFeedbackSample {
  if (payload.length !== MOTOR_FEEDBACK_SAMPLE_LENGTH) {
    throw new Error(`Invalid motor feedback payload length ${payload.length}`);
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const leftMotorCurrentAmps = decodeOptionalUint16(view, 18, 10);
  const rightMotorCurrentAmps = decodeOptionalUint16(view, 20, 10);

  return {
    timestampMillis: view.getUint32(0, true),
    leftWheelActualMetersPerSecond: view.getInt16(4, true) / 1000,
    rightWheelActualMetersPerSecond: view.getInt16(6, true) / 1000,
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
