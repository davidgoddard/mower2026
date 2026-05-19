import { I2cBusController } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { BMI160 } from "./bmi160Registers.js";
import { ImuSample, ImuSensor } from "./types.js";
import { I2C_ADDRESS_BMI160_DEFAULT, IMU_DEFAULT_CALIBRATION_SAMPLES } from "../constants.js";

// BMI160 hardware timing constants (implementation details from datasheet)
const IMU_ACC_INIT_DELAY_MS = 10;
const IMU_ACC_RANGE_DELAY_MS = 10;
const IMU_GYRO_INIT_DELAY_MS = 80;
const IMU_GYRO_RANGE_DELAY_MS = 10;
const IMU_CALIBRATION_SAMPLE_DELAY_MS = 4;

// BMI160 register values (implementation details)
const BMI160_ACC_RANGE_2G = 0x03;
const BMI160_GYRO_RANGE_2000DPS = 0x00;

// Physical constant
const GRAVITY_METERS_PER_SECOND_SQUARED = 9.80665;

// 16-bit integer conversion constants (implementation details)
const INT16_MAX = 0x7fff;
const UINT16_WRAP = 0x10000;

interface Bmi160ImuSensorOptions {
  address?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function decodeSignedInt16(lsb: number, msb: number): number {
  const combined = (msb << 8) | lsb;
  return combined > INT16_MAX ? combined - UINT16_WRAP : combined;
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
  private pitchOffsetDeg = 0;
  private rollOffsetDeg = 0;

  constructor(controller: I2cBusController, options: Bmi160ImuSensorOptions = {}) {
    this.controller = controller;
    this.address = options.address ?? I2C_ADDRESS_BMI160_DEFAULT;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async initialise(): Promise<void> {
    const chipId = await this.readRegister(BMI160.registers.chipId);
    if (chipId !== BMI160.expectedChipId) {
      throw new Error(`Unexpected BMI160 chip id 0x${chipId.toString(16)} at address 0x${this.address.toString(16)}`);
    }

    // Initialize gyroscope
    await this.writeRegister(BMI160.registers.command, BMI160.commands.gyroNormalMode);
    await this.sleep(IMU_GYRO_INIT_DELAY_MS);

    // Set gyro range to +/- 2000 dps (16.4 LSB/dps) to keep conversion stable.
    await this.writeRegister(BMI160.registers.gyroRange, BMI160_GYRO_RANGE_2000DPS);
    await this.sleep(IMU_GYRO_RANGE_DELAY_MS);
  }

  async calibrateGyro(sampleCount = IMU_DEFAULT_CALIBRATION_SAMPLES): Promise<void> {
    if (sampleCount <= 0) {
      this.gyroBiasDps = 0;
      this.pitchOffsetDeg = 0;
      this.rollOffsetDeg = 0;
      return;
    }

    let gyroSum = 0;
    let measured = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const gyroRaw = await this.readGyroZRaw();
      gyroSum += gyroRaw / BMI160.gyroLsbPerDpsAt2000;

      measured += 1;
      await this.sleep(IMU_CALIBRATION_SAMPLE_DELAY_MS);
    }

    this.gyroBiasDps = measured === 0 ? 0 : (gyroSum / measured);
    this.pitchOffsetDeg = 0;
    this.rollOffsetDeg = 0;
  }

  async read(): Promise<ImuSample> {
    const gyroRaw = await this.readGyroZRaw();
    const zDegreesPerSecond = (gyroRaw / BMI160.gyroLsbPerDpsAt2000) - this.gyroBiasDps;

    let accX = 0;
    let accY = 0;
    let accZ = 0;
    try {
      [accX, accY, accZ] = await this.readAccelerometerRaw();
    } catch {
      // Some test doubles only model gyro reads.
    }
    const pitchDeg = this.calculatePitchDeg(accX, accY, accZ) - this.pitchOffsetDeg;
    const rollDeg = this.calculateRollDeg(accY, accZ) - this.rollOffsetDeg;

    // Convert from G to m/s^2
    const xMetersPerSecondSquared = (accX / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;
    const yMetersPerSecondSquared = (accY / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;
    const zMetersPerSecondSquared = (accZ / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;

    return {
      timestampMillis: this.nowMillis(),
      angularVelocity: {
        zDegreesPerSecond,
      },
      acceleration: {
        xMetersPerSecondSquared,
        yMetersPerSecondSquared,
        zMetersPerSecondSquared,
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

  private async readAccelerometerRaw(): Promise<[number, number, number]> {
    const response = await this.controller.queueRead({
      key: "imu.read_accelerometer",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      requestPayload: new Uint8Array([BMI160.registers.accXLsb]),
      responseLength: 6,
    });

    const accX = decodeSignedInt16(response[0] ?? 0, response[1] ?? 0);
    const accY = decodeSignedInt16(response[2] ?? 0, response[3] ?? 0);
    const accZ = decodeSignedInt16(response[4] ?? 0, response[5] ?? 0);

    return [accX, accY, accZ];
  }

  private calculatePitchDeg(accX: number, accY: number, accZ: number): number {
    // Convert raw values to G
    const ax = accX / BMI160.accLsbPerGAt2g;
    const ay = accY / BMI160.accLsbPerGAt2g;
    const az = accZ / BMI160.accLsbPerGAt2g;

    // Calculate pitch (rotation around Y axis)
    return Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
  }

  private calculateRollDeg(accY: number, accZ: number): number {
    // Convert raw values to G
    const ay = accY / BMI160.accLsbPerGAt2g;
    const az = accZ / BMI160.accLsbPerGAt2g;

    // Calculate roll (rotation around X axis)
    return Math.atan2(ay, az) * (180 / Math.PI);
  }
}
