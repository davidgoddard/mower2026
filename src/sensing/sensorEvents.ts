/**
 * Sensor event types for event-driven architecture
 */

import { InternalHeading } from "../geometry/headingTypes.js";

/**
 * IMU heading update event
 * Emitted each time IMU heading is integrated (30Hz)
 */
export interface ImuHeadingUpdateEvent {
  readonly heading: InternalHeading;
  readonly pitchDeg: number;
  readonly rollDeg: number;
  readonly timestampMillis: number;
}

/**
 * GNSS position update event
 * Emitted each time GNSS position is read (30Hz)
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
 * Emitted each time motor feedback is read (30Hz)
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
 * Type-safe event map for SensorController
 */
export interface SensorControllerEvents {
  imuHeadingUpdate: ImuHeadingUpdateEvent;
  gnssPositionUpdate: GnssPositionUpdateEvent;
  motorFeedbackUpdate: MotorFeedbackUpdateEvent;
}

/**
 * Event names as constants for type safety
 */
export const SENSOR_EVENTS = {
  IMU_HEADING_UPDATE: "imuHeadingUpdate" as const,
  GNSS_POSITION_UPDATE: "gnssPositionUpdate" as const,
  MOTOR_FEEDBACK_UPDATE: "motorFeedbackUpdate" as const,
};
