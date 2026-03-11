import { createRequire } from "node:module";
import type { ImuSensor, RawImuSample } from "../sensing/imuSensor.js";

export interface Bmi160RegisterBus {
  readByteSync(address: number, cmd: number): number;
  writeByteSync(address: number, cmd: number, byte: number): void;
  readI2cBlockSync(address: number, cmd: number, length: number, buffer: Buffer): number;
  closeSync?(): void;
}

export interface Bmi160ImuSensorOptions {
  readonly address?: number;
  readonly busNumber?: number;
  readonly bus?: Bmi160RegisterBus;
  readonly now?: () => number;
}

export class Bmi160ImuSensor implements ImuSensor {
  private readonly address: number;
  private readonly bus: Bmi160RegisterBus;
  private readonly now: () => number;
  private ready = false;
  private gyroBias = { x: 0, y: 0, z: 0 };

  private readonly commandRegister = 0x7e;
  private readonly accelConfigRegister = 0x40;
  private readonly accelRangeRegister = 0x41;
  private readonly gyroConfigRegister = 0x42;
  private readonly gyroRangeRegister = 0x43;
  private readonly whoAmIRegister = 0x00;
  private readonly accelXLsbRegister = 0x12;
  private readonly gyroXLsbRegister = 0x0c;
  private readonly chipId = 0xd1;
  private readonly gyroSensitivity = 131.2; // LSB per degree/s at +/-250 dps
  private readonly accelSensitivity = 16384; // LSB per g at +/-2g
  private readonly standardGravity = 9.80665;
  private static readonly require = createRequire(import.meta.url);

  public constructor(options: Bmi160ImuSensorOptions = {}) {
    this.address = options.address ?? 0x69;
    this.bus = options.bus ?? Bmi160ImuSensor.openI2cBus(options.busNumber ?? 1);
    this.now = options.now ?? (() => Date.now());
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public async initialise(): Promise<void> {
    const detectedChipId = this.bus.readByteSync(this.address, this.whoAmIRegister);
    if (detectedChipId !== this.chipId) {
      throw new Error(`Unexpected BMI160 chip ID: 0x${detectedChipId.toString(16)}`);
    }

    this.bus.writeByteSync(this.address, this.commandRegister, 0x11);
    await this.delay(100);
    this.bus.writeByteSync(this.address, this.commandRegister, 0x15);
    await this.delay(100);

    this.bus.writeByteSync(this.address, this.accelRangeRegister, 0x03);
    this.bus.writeByteSync(this.address, this.accelConfigRegister, 0x28);
    this.bus.writeByteSync(this.address, this.gyroRangeRegister, 0x03);
    this.bus.writeByteSync(this.address, this.gyroConfigRegister, 0x28);
  }

  public async calibrateGyro(samples = 200, delayMs = 10): Promise<void> {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;

    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      const sample = this.readRawGyro();
      sumX += sample.x;
      sumY += sample.y;
      sumZ += sample.z;
      await this.delay(delayMs);
    }

    this.gyroBias = {
      x: sumX / samples,
      y: sumY / samples,
      z: sumZ / samples,
    };
    this.ready = true;
  }

  public async read(): Promise<RawImuSample> {
    if (!this.ready) {
      throw new Error("BMI160 IMU sensor is not calibrated");
    }

    const rawGyro = this.readRawGyro();
    const rawAccel = this.readRawAcceleration();

    return {
      timestampMillis: this.now(),
      angularVelocity: {
        xDegreesPerSecond: (rawGyro.x - this.gyroBias.x) / this.gyroSensitivity,
        yDegreesPerSecond: (rawGyro.y - this.gyroBias.y) / this.gyroSensitivity,
        zDegreesPerSecond: (rawGyro.z - this.gyroBias.z) / this.gyroSensitivity,
      },
      acceleration: {
        xMetersPerSecondSquared: (rawAccel.x / this.accelSensitivity) * this.standardGravity,
        yMetersPerSecondSquared: (rawAccel.y / this.accelSensitivity) * this.standardGravity,
        zMetersPerSecondSquared: (rawAccel.z / this.accelSensitivity) * this.standardGravity,
      },
    };
  }

  public async close(): Promise<void> {
    this.bus.closeSync?.();
  }

  private readRawGyro(): { x: number; y: number; z: number } {
    const buffer = Buffer.alloc(6);
    this.bus.readI2cBlockSync(this.address, this.gyroXLsbRegister, 6, buffer);
    const bytes = this.requireSixBytes(buffer);

    return {
      x: this.toSigned16(bytes[1], bytes[0]),
      y: this.toSigned16(bytes[3], bytes[2]),
      z: this.toSigned16(bytes[5], bytes[4]),
    };
  }

  private readRawAcceleration(): { x: number; y: number; z: number } {
    const buffer = Buffer.alloc(6);
    this.bus.readI2cBlockSync(this.address, this.accelXLsbRegister, 6, buffer);
    const bytes = this.requireSixBytes(buffer);

    return {
      x: this.toSigned16(bytes[1], bytes[0]),
      y: this.toSigned16(bytes[3], bytes[2]),
      z: this.toSigned16(bytes[5], bytes[4]),
    };
  }

  private requireSixBytes(buffer: Buffer): [number, number, number, number, number, number] {
    const b0 = buffer[0];
    const b1 = buffer[1];
    const b2 = buffer[2];
    const b3 = buffer[3];
    const b4 = buffer[4];
    const b5 = buffer[5];
    if (
      b0 === undefined
      || b1 === undefined
      || b2 === undefined
      || b3 === undefined
      || b4 === undefined
      || b5 === undefined
    ) {
      throw new Error("BMI160 returned an incomplete sample");
    }

    return [b0, b1, b2, b3, b4, b5];
  }

  private toSigned16(high: number, low: number): number {
    let value = (high << 8) | low;
    if ((value & 0x8000) !== 0) {
      value = -(0x10000 - value);
    }
    return value;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static openI2cBus(busNumber: number): Bmi160RegisterBus {
    const i2c = Bmi160ImuSensor.require("i2c-bus") as { openSync: (busNum: number) => Bmi160RegisterBus };
    return i2c.openSync(busNumber);
  }
}
