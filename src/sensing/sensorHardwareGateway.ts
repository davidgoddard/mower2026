import { I2cBusController } from "../i2c/i2cBusController.js";
import { LiveI2cTransport } from "../i2c/liveI2cTransport.js";
import { Bmi160ImuSensor } from "../imu/bmi160ImuSensor.js";
import { ImuSample } from "../imu/types.js";

export interface SensorHardwareGateway {
  initialise(): Promise<void>;
  readImu(): Promise<ImuSample>;
  close(): Promise<void>;
}

interface PiSensorHardwareGatewayOptions {
  busNumber: number;
}

class PiSensorHardwareGateway implements SensorHardwareGateway {
  private readonly busNumber: number;
  private controller: I2cBusController | null = null;
  private imuSensor: Bmi160ImuSensor | null = null;

  constructor(options: PiSensorHardwareGatewayOptions) {
    this.busNumber = options.busNumber;
  }

  async initialise(): Promise<void> {
    const transport = await LiveI2cTransport.create(this.busNumber);
    this.controller = new I2cBusController(transport);
    this.imuSensor = new Bmi160ImuSensor(this.controller);

    await this.imuSensor.initialise();
    await this.imuSensor.calibrateGyro();
  }

  async readImu(): Promise<ImuSample> {
    if (!this.imuSensor) {
      throw new Error("sensor gateway not initialised");
    }

    return this.imuSensor.read();
  }

  async close(): Promise<void> {
    await this.imuSensor?.close();
    this.imuSensor = null;

    await this.controller?.close();
    this.controller = null;
  }
}

export async function createPiSensorHardwareGateway(busNumber: number): Promise<SensorHardwareGateway> {
  const gateway = new PiSensorHardwareGateway({ busNumber });
  await gateway.initialise();
  return gateway;
}
