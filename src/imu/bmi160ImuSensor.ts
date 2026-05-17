import { I2cBusController } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { BMI160 } from "./bmi160Registers.js";
import { ImuSample, ImuSensor } from "./types.js";

interface Bmi160ImuSensorOptions {
  address?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function decodeSignedInt16(lsb: number, msb: number): number {
  const combined = (msb << 8) | lsb;
  return combined > 0x7fff ? combined - 0x10000 : combined;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class Bmi160ImuSensor implements ImuSensor {
  private readonly controller: I2cBusController;
  private readonly address: number;
  private readonly nowMillis: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private gyroBiasDps = 0;

  constructor(controller: I2cBusController, options: Bmi160ImuSensorOptions = {}) {
    this.controller = controller;
    this.address = options.address ?? BMI160.defaultAddress;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async initialise(): Promise<void> {
    const chipId = await this.readRegister(BMI160.registers.chipId);
    if (chipId !== BMI160.expectedChipId) {
      throw new Error(`Unexpected BMI160 chip id 0x${chipId.toString(16)} at address 0x${this.address.toString(16)}`);
    }

    await this.writeRegister(BMI160.registers.command, BMI160.commands.gyroNormalMode);
    await this.sleep(80);

    // Set gyro range to +/- 2000 dps (16.4 LSB/dps) to keep conversion stable.
    await this.writeRegister(BMI160.registers.gyroRange, 0x00);
    await this.sleep(10);
  }

  async calibrateGyro(sampleCount = 60): Promise<void> {
    if (sampleCount <= 0) {
      this.gyroBiasDps = 0;
      return;
    }

    let sum = 0;
    let measured = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const raw = await this.readGyroZRaw();
      sum += raw / BMI160.gyroLsbPerDpsAt2000;
      measured += 1;
      await this.sleep(4);
    }

    this.gyroBiasDps = measured === 0 ? 0 : (sum / measured);
  }

  async read(): Promise<ImuSample> {
    const raw = await this.readGyroZRaw();
    const zDegreesPerSecond = (raw / BMI160.gyroLsbPerDpsAt2000) - this.gyroBiasDps;

    return {
      timestampMillis: this.nowMillis(),
      angularVelocity: {
        zDegreesPerSecond,
      },
    };
  }

  async close(): Promise<void> {
    // No dedicated close action for the BMI160 itself in this minimal integration.
  }

  private async readRegister(register: number): Promise<number> {
    const response = await this.controller.queueRead({
      key: "imu.read_register",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      requestPayload: new Uint8Array([register]),
      responseLength: 1,
    });

    return response[0] ?? 0;
  }

  private async writeRegister(register: number, value: number): Promise<void> {
    await this.controller.queueWrite({
      key: "imu.write_register",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      payload: new Uint8Array([register, value]),
    });
  }

  private async readGyroZRaw(): Promise<number> {
    const response = await this.controller.queueRead({
      key: "imu.read_gyro_z",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      requestPayload: new Uint8Array([BMI160.registers.gyroZLsb]),
      responseLength: 2,
    });

    return decodeSignedInt16(response[0] ?? 0, response[1] ?? 0);
  }
}
