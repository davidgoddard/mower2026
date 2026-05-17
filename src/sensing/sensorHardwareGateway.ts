import { I2cBusController } from "../i2c/i2cBusController.js";
import { LiveI2cTransport } from "../i2c/liveI2cTransport.js";
import { GnssNodeClient } from "../gnss/gnssNodeClient.js";
import { GnssSample } from "../gnss/gnssProtocol.js";
import { Bmi160ImuSensor } from "../imu/bmi160ImuSensor.js";
import { ImuSample } from "../imu/types.js";

export interface SensorHardwareGateway {
  initialise(): Promise<void>;
  readImu(): Promise<ImuSample>;
  readGnss(): Promise<GnssSample>;
  close(): Promise<void>;
}

interface PiSensorHardwareGatewayOptions {
  busNumber: number;
  gnssAddress: number;
}

class PiSensorHardwareGateway implements SensorHardwareGateway {
  private readonly busNumber: number;
  private readonly gnssAddress: number;
  private controller: I2cBusController | null = null;
  private imuSensor: Bmi160ImuSensor | null = null;
  private gnssClient: GnssNodeClient | null = null;

  constructor(options: PiSensorHardwareGatewayOptions) {
    this.busNumber = options.busNumber;
    this.gnssAddress = options.gnssAddress;
  }

  async initialise(): Promise<void> {
    const transport = await LiveI2cTransport.create(this.busNumber);
    this.controller = new I2cBusController(transport);
    this.imuSensor = new Bmi160ImuSensor(this.controller);
    this.gnssClient = new GnssNodeClient(this.controller, { address: this.gnssAddress });

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

  async close(): Promise<void> {
    await this.imuSensor?.close();
    this.imuSensor = null;
    this.gnssClient = null;

    await this.controller?.close();
    this.controller = null;
  }
}

export async function createPiSensorHardwareGateway(
  busNumber: number,
  options: { gnssAddress?: number } = {},
): Promise<SensorHardwareGateway> {
  const gateway = new PiSensorHardwareGateway({
    busNumber,
    gnssAddress: options.gnssAddress ?? 0x52,
  });
  await gateway.initialise();
  return gateway;
}
