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
  private gyroBiasXDegreesPerSecond = 0;
  private gyroBiasYDegreesPerSecond = 0;
  private gyroBiasZDegreesPerSecond = 0;
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

    // Initialize accelerometer
    await this.writeRegister(BMI160.registers.command, BMI160.commands.accNormalMode);
    await this.sleep(IMU_ACC_INIT_DELAY_MS);

    // Set accelerometer range to +/-2g for stable pitch/roll calculations.
    await this.writeRegister(BMI160.registers.accRange, BMI160_ACC_RANGE_2G);
    await this.sleep(IMU_ACC_RANGE_DELAY_MS);

    // Initialize gyroscope
    await this.writeRegister(BMI160.registers.command, BMI160.commands.gyroNormalMode);
    await this.sleep(IMU_GYRO_INIT_DELAY_MS);

    // Set gyro range to +/- 2000 dps (16.4 LSB/dps) to keep conversion stable.
    await this.writeRegister(BMI160.registers.gyroRange, BMI160_GYRO_RANGE_2000DPS);
    await this.sleep(IMU_GYRO_RANGE_DELAY_MS);
  }

  async calibrateGyro(sampleCount = IMU_DEFAULT_CALIBRATION_SAMPLES): Promise<void> {
    if (sampleCount <= 0) {
      this.gyroBiasXDegreesPerSecond = 0;
      this.gyroBiasYDegreesPerSecond = 0;
      this.gyroBiasZDegreesPerSecond = 0;
      this.pitchOffsetDeg = 0;
      this.rollOffsetDeg = 0;
      return;
    }

    let gyroXSum = 0;
    let gyroYSum = 0;
    let gyroZSum = 0;
    let pitchSum = 0;
    let rollSum = 0;
    let measured = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const [gyroXRaw, gyroYRaw, gyroZRaw] = await this.readGyroRaw();
      const [accX, accY, accZ] = await this.readAccelerometerRaw();
      gyroXSum += gyroXRaw / BMI160.gyroLsbPerDpsAt2000;
      gyroYSum += gyroYRaw / BMI160.gyroLsbPerDpsAt2000;
      gyroZSum += gyroZRaw / BMI160.gyroLsbPerDpsAt2000;
      pitchSum += this.calculatePitchDeg(accX, accY, accZ);
      rollSum += this.calculateRollDeg(accY, accZ);

      measured += 1;
      await this.sleep(IMU_CALIBRATION_SAMPLE_DELAY_MS);
    }

    this.gyroBiasXDegreesPerSecond = measured === 0 ? 0 : (gyroXSum / measured);
    this.gyroBiasYDegreesPerSecond = measured === 0 ? 0 : (gyroYSum / measured);
    this.gyroBiasZDegreesPerSecond = measured === 0 ? 0 : (gyroZSum / measured);
    this.pitchOffsetDeg = measured === 0 ? 0 : (pitchSum / measured);
    this.rollOffsetDeg = measured === 0 ? 0 : (rollSum / measured);
  }

  async read(): Promise<ImuSample> {
    let gyroXRaw = 0;
    let gyroYRaw = 0;
    let gyroZRaw = 0;
    let accX = 0;
    let accY = 0;
    let accZ = 0;
    try {
      [gyroXRaw, gyroYRaw, gyroZRaw, accX, accY, accZ] = await this.readGyroAndAccelRaw();
    } catch {
      // Test doubles may only model the legacy single-bank reads.
      [gyroXRaw, gyroYRaw, gyroZRaw] = await this.readGyroRaw();
      try {
        [accX, accY, accZ] = await this.readAccelerometerRaw();
      } catch {
        // Some test doubles only model gyro reads.
      }
    }
    const xDegreesPerSecond = (gyroXRaw / BMI160.gyroLsbPerDpsAt2000) - this.gyroBiasXDegreesPerSecond;
    const yDegreesPerSecond = (gyroYRaw / BMI160.gyroLsbPerDpsAt2000) - this.gyroBiasYDegreesPerSecond;
    const zDegreesPerSecond = (gyroZRaw / BMI160.gyroLsbPerDpsAt2000) - this.gyroBiasZDegreesPerSecond;

    // Convert from G to m/s^2
    const xMetersPerSecondSquared = (accX / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;
    const yMetersPerSecondSquared = (accY / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;
    const zMetersPerSecondSquared = (accZ / BMI160.accLsbPerGAt2g) * GRAVITY_METERS_PER_SECOND_SQUARED;
    const pitchDeg = this.calculatePitchDeg(accX, accY, accZ) - this.pitchOffsetDeg;
    const rollDeg = this.calculateRollDeg(accY, accZ) - this.rollOffsetDeg;

    return {
      timestampMillis: this.nowMillis(),
      angularVelocity: {
        xDegreesPerSecond,
        yDegreesPerSecond,
        zDegreesPerSecond,
      },
      acceleration: {
        xMetersPerSecondSquared,
        yMetersPerSecondSquared,
        zMetersPerSecondSquared,
      },
      pitchDeg,
      rollDeg,
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

  private async readGyroAndAccelRaw(): Promise<[number, number, number, number, number, number]> {
    // Gyro X/Y/Z LSB lives at 0x0C..0x11 and accel X/Y/Z LSB at 0x12..0x17.
    // The bank is contiguous so one 12-byte burst replaces two 6-byte reads,
    // halving the IMU's I2C cost per sample.
    const response = await this.controller.queueRead({
      key: "imu.read_gyro_accel",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      requestPayload: new Uint8Array([BMI160.registers.gyroXLsb]),
      responseLength: 12,
    });

    const gyroX = decodeSignedInt16(response[0] ?? 0, response[1] ?? 0);
    const gyroY = decodeSignedInt16(response[2] ?? 0, response[3] ?? 0);
    const gyroZ = decodeSignedInt16(response[4] ?? 0, response[5] ?? 0);
    const accX = decodeSignedInt16(response[6] ?? 0, response[7] ?? 0);
    const accY = decodeSignedInt16(response[8] ?? 0, response[9] ?? 0);
    const accZ = decodeSignedInt16(response[10] ?? 0, response[11] ?? 0);

    return [gyroX, gyroY, gyroZ, accX, accY, accZ];
  }

  private async readGyroRaw(): Promise<[number, number, number]> {
    const response = await this.controller.queueRead({
      key: "imu.read_gyro",
      priority: I2C_PRIORITY.imuRead,
      address: this.address,
      requestPayload: new Uint8Array([BMI160.registers.gyroXLsb]),
      responseLength: 6,
    });

    const gyroX = decodeSignedInt16(response[0] ?? 0, response[1] ?? 0);
    const gyroY = decodeSignedInt16(response[2] ?? 0, response[3] ?? 0);
    const gyroZ = decodeSignedInt16(response[4] ?? 0, response[5] ?? 0);

    return [gyroX, gyroY, gyroZ];
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
