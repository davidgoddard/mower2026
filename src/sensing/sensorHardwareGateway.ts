import { I2cBusController } from "../i2c/i2cBusController.js";
import { LiveI2cTransport } from "../i2c/liveI2cTransport.js";
import { GnssNodeClient } from "../gnss/gnssNodeClient.js";
import { GnssSample } from "../gnss/gnssProtocol.js";
import { buildMotorDirectionMapping, mapPhysicalWheelTargetsToRaw, mapRawMotorFeedbackToPhysical, MotorDirectionMapping } from "../motors/motorMapping.js";
import { MotorNodeClient } from "../motors/motorNodeClient.js";
import { MotorFeedbackSample } from "../motors/motorProtocol.js";
import { Bmi160ImuSensor } from "../imu/bmi160ImuSensor.js";
import { ImuSample } from "../imu/types.js";

export interface SensorHardwareGateway {
  initialise(): Promise<void>;
  readImu(): Promise<ImuSample>;
  readGnss(): Promise<GnssSample>;
  readMotorFeedback(): Promise<MotorFeedbackSample>;
  setMotorWheelSpeeds(leftWheelTargetMetersPerSecond: number, rightWheelTargetMetersPerSecond: number): Promise<void>;
  stopMotors(): Promise<void>;
  close(): Promise<void>;
}

interface PiSensorHardwareGatewayOptions {
  busNumber: number;
  gnssAddress: number;
  motorAddress: number;
  leftMotorForwardSign: number;
  rightMotorForwardSign: number;
}

class PiSensorHardwareGateway implements SensorHardwareGateway {
  private readonly busNumber: number;
  private readonly gnssAddress: number;
  private readonly motorAddress: number;
  private readonly motorMapping: MotorDirectionMapping;
  private controller: I2cBusController | null = null;
  private imuSensor: Bmi160ImuSensor | null = null;
  private gnssClient: GnssNodeClient | null = null;
  private motorClient: MotorNodeClient | null = null;

  constructor(options: PiSensorHardwareGatewayOptions) {
    this.busNumber = options.busNumber;
    this.gnssAddress = options.gnssAddress;
    this.motorAddress = options.motorAddress;
    this.motorMapping = buildMotorDirectionMapping(options.leftMotorForwardSign, options.rightMotorForwardSign);
  }

  async initialise(): Promise<void> {
    const transport = await LiveI2cTransport.create(this.busNumber);
    this.controller = new I2cBusController(transport);
    this.imuSensor = new Bmi160ImuSensor(this.controller);
    this.gnssClient = new GnssNodeClient(this.controller, { address: this.gnssAddress });
    this.motorClient = new MotorNodeClient(this.controller, { address: this.motorAddress });

    await this.imuSensor.initialise();
    await this.imuSensor.calibrateGyro();
  }

  async readImu(): Promise<ImuSample> {
    if (!this.imuSensor) {
      throw new Error("sensor gateway not initialised");
    }

    return this.imuSensor.read();
  }

  async readGnss(): Promise<GnssSample> {
    if (!this.gnssClient) {
      throw new Error("sensor gateway not initialised");
    }

    return this.gnssClient.refresh();
  }

  async readMotorFeedback(): Promise<MotorFeedbackSample> {
    if (!this.motorClient) {
      throw new Error("sensor gateway not initialised");
    }

    const raw = await this.motorClient.refreshFeedback();
    return mapRawMotorFeedbackToPhysical(this.motorMapping, raw);
  }

  async setMotorWheelSpeeds(leftWheelTargetMetersPerSecond: number, rightWheelTargetMetersPerSecond: number): Promise<void> {
    if (!this.motorClient) {
      throw new Error("sensor gateway not initialised");
    }

    const raw = mapPhysicalWheelTargetsToRaw(this.motorMapping, {
      leftMetersPerSecond: leftWheelTargetMetersPerSecond,
      rightMetersPerSecond: rightWheelTargetMetersPerSecond,
    });

    await this.motorClient.sendWheelSpeedCommand(raw.leftMetersPerSecond, raw.rightMetersPerSecond);
  }

  async stopMotors(): Promise<void> {
    if (!this.motorClient) {
      throw new Error("sensor gateway not initialised");
    }

    await this.motorClient.stop();
  }

  async close(): Promise<void> {
    try {
      await this.motorClient?.stop();
    } catch {
      // Best-effort stop on shutdown; continue closing transport even if node is offline.
    }
    this.motorClient = null;
    await this.imuSensor?.close();
    this.imuSensor = null;
    this.gnssClient = null;

    await this.controller?.close();
    this.controller = null;
  }
}

export async function createPiSensorHardwareGateway(
  busNumber: number,
  options: {
    gnssAddress?: number;
    motorAddress?: number;
    leftMotorForwardSign?: number;
    rightMotorForwardSign?: number;
  } = {},
): Promise<SensorHardwareGateway> {
  const gateway = new PiSensorHardwareGateway({
    busNumber,
    gnssAddress: options.gnssAddress ?? 0x52,
    motorAddress: options.motorAddress ?? 0x66,
    leftMotorForwardSign: options.leftMotorForwardSign ?? -1,
    rightMotorForwardSign: options.rightMotorForwardSign ?? -1,
  });
  await gateway.initialise();
  return gateway;
}
