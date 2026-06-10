/**
 * Stub sensor gateway for development/testing without hardware
 * Returns error states for all sensor reads
 */

import { SensorHardwareGateway } from "./sensorHardwareGateway.js";
import type { MotorCommandOptions } from "./sensorHardwareGateway.js";

export class StubSensorGateway implements SensorHardwareGateway {
  private readonly error = new Error("Stub sensor gateway - no hardware available");

  async initialise(): Promise<void> {
    // No initialization needed for stub
    return Promise.resolve();
  }

  async close(): Promise<void> {
    // No cleanup needed for stub
    return Promise.resolve();
  }

  async readImu(): Promise<any> {
    throw this.error;
  }

  async readGnss(): Promise<any> {
    throw this.error;
  }

  async readMotorFeedback(): Promise<any> {
    throw this.error;
  }

  async setMotorWheelOutputs(
    _leftOutputPercent: number,
    _rightOutputPercent: number,
    _options?: MotorCommandOptions,
  ): Promise<void> {
    // Silently ignore motor commands when no hardware
    return Promise.resolve();
  }

  async stopMotors(): Promise<void> {
    // Silently ignore stop commands when no hardware
    return Promise.resolve();
  }
}
