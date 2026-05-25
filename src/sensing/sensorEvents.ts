/**
 * Sensor event types for event-driven architecture
 */

import { InternalHeading } from "../geometry/headingTypes.js";

/**
 * IMU heading update event
 * Emitted each time IMU heading is integrated (sensor loop cadence)
 */
export interface ImuHeadingUpdateEvent {
  readonly heading: InternalHeading;
  readonly pitchDeg: number;
  readonly rollDeg: number;
  readonly timestampMillis: number;
}

/**
 * GNSS position update event
 * Emitted each time GNSS position is read (sensor loop cadence)
 */
export interface GnssPositionUpdateEvent {
  readonly xMeters: number;
  readonly yMeters: number;
  readonly heading: InternalHeading | null;
  readonly positionAccuracyMeters: number | null;
  readonly headingAccuracyDeg: number | null;
  readonly fixType: string;
  readonly satellitesInUse: number | null;
  readonly timestampMillis: number;
}

/**
 * Motor feedback update event
 * Emitted each time motor feedback is read (sensor loop cadence)
 */
export interface MotorFeedbackUpdateEvent {
  readonly leftWheelSpeedMetersPerSecond: number;
  readonly rightWheelSpeedMetersPerSecond: number;
  readonly leftEncoderDelta: number;
  readonly rightEncoderDelta: number;
  readonly leftPwmAppliedPercent: number;
  readonly rightPwmAppliedPercent: number;
  readonly leftMotorCurrentAmps: number | null;
  readonly rightMotorCurrentAmps: number | null;
  readonly watchdogHealthy: boolean;
  readonly faultFlags: number;
  readonly timestampMillis: number;
}

/**
 * Obstruction detection event types
 */
export type ObstructionType = "high_current" | "wheel_slip" | "stall";

/**
 * Obstruction detected event
 * Emitted when obstruction conditions are detected
 */
export interface ObstructionDetectedEvent {
  readonly type: ObstructionType;
  readonly timestampMillis: number;
  readonly leftMotorCurrentAmps: number;
  readonly rightMotorCurrentAmps: number;
  readonly leftWheelSpeedMetersPerSecond: number;
  readonly rightWheelSpeedMetersPerSecond: number;
}

/**
 * Type-safe event map for SensorController
 */
export interface SensorControllerEvents {
  imuHeadingUpdate: ImuHeadingUpdateEvent;
  gnssPositionUpdate: GnssPositionUpdateEvent;
  motorFeedbackUpdate: MotorFeedbackUpdateEvent;
  obstructionDetected: ObstructionDetectedEvent;
}

/**
 * Event names as constants for type safety
 */
export const SENSOR_EVENTS = {
  IMU_HEADING_UPDATE: "imuHeadingUpdate" as const,
  GNSS_POSITION_UPDATE: "gnssPositionUpdate" as const,
  MOTOR_FEEDBACK_UPDATE: "motorFeedbackUpdate" as const,
  OBSTRUCTION_DETECTED: "obstructionDetected" as const,
};
