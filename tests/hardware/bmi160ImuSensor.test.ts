import test from "node:test";
import assert from "node:assert/strict";
import { Bmi160ImuSensor } from "../../src/hardware/bmi160ImuSensor.js";

class FakeBmi160Bus {
  public writes: Array<{ cmd: number; value: number }> = [];
  public gyroBytes = Buffer.from([0x20, 0x03, 0xe0, 0xfc, 0x90, 0x01]);
  public accelBytes = Buffer.from([0x00, 0x08, 0x00, 0xf8, 0x00, 0x40]);

  public readByteSync(_address: number, _cmd: number): number {
    return 0xd1;
  }

  public writeByteSync(_address: number, cmd: number, value: number): void {
    this.writes.push({ cmd, value });
  }

  public readI2cBlockSync(_address: number, cmd: number, _length: number, buffer: Buffer): number {
    const source = cmd === 0x0c ? this.gyroBytes : this.accelBytes;
    source.copy(buffer);
    return source.length;
  }
}

test("Bmi160ImuSensor initialises the accelerometer and gyroscope", async () => {
  const bus = new FakeBmi160Bus();
  const sensor = new Bmi160ImuSensor({ bus, now: () => 1_000 });

  await sensor.initialise();

  assert.deepEqual(
    bus.writes.map((write) => write.value),
    [0x11, 0x15, 0x03, 0x28, 0x03, 0x28],
  );
});

test("Bmi160ImuSensor returns gyro and accelerometer samples", async () => {
  const bus = new FakeBmi160Bus();
  const sensor = new Bmi160ImuSensor({ bus, now: () => 1_234 });

  await sensor.initialise();
  await sensor.calibrateGyro(1, 0);

  bus.gyroBytes = Buffer.from([0x40, 0x06, 0xc0, 0xf9, 0x20, 0x03]);
  bus.accelBytes = Buffer.from([0x00, 0x10, 0x00, 0xf0, 0x00, 0x40]);

  const sample = await sensor.read();

  assert.equal(sample.timestampMillis, 1_234);
  assert.equal(Number(sample.angularVelocity.xDegreesPerSecond.toFixed(3)), 6.098);
  assert.equal(Number(sample.angularVelocity.yDegreesPerSecond.toFixed(3)), -6.098);
  assert.equal(Number(sample.angularVelocity.zDegreesPerSecond.toFixed(3)), 3.049);
  assert.equal(Number(sample.acceleration.xMetersPerSecondSquared.toFixed(3)), 2.452);
  assert.equal(Number(sample.acceleration.yMetersPerSecondSquared.toFixed(3)), -2.452);
  assert.equal(Number(sample.acceleration.zMetersPerSecondSquared.toFixed(3)), 9.807);
});
