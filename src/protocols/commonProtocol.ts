export interface FrameHeader {
  readonly version: number;
  readonly nodeId: number;
  readonly messageType: number;
  readonly flags: number;
  readonly sequence: number;
}

export interface TimestampedPayload {
  readonly timestampMillis: number;
}

export const PROTOCOL_VERSION = 1;

export enum NodeId {
  Gnss = 0x10,
  Motor = 0x20,
}

export enum MessageType {
  GnssSample = 0x01,
  MotorWheelSpeedCommand = 0x21,
  MotorFeedbackSample = 0x22,
}
