// Pi-side BMI160 IMU poller for manual bring-up.
// Run `npm run build` first so the built hardware layer exists in `dist/`.

import { LiveI2cTransport } from "../../dist/i2c/liveI2cTransport.js";
import { I2cBusController } from "../../dist/i2c/i2cBusController.js";
import { Bmi160ImuSensor } from "../../dist/imu/bmi160ImuSensor.js";

const SAMPLE_INTERVAL_MS = 200;
const BUS_NUMBER = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveOrientation(sample) {
  const ax = sample.acceleration.xMetersPerSecondSquared;
  const ay = sample.acceleration.yMetersPerSecondSquared;
  const az = sample.acceleration.zMetersPerSecondSquared;
  const gravityMagnitude = Math.sqrt((ax * ax) + (ay * ay) + (az * az));
  const rollDegrees = Math.atan2(ay, az) * (180 / Math.PI);
  const pitchDegrees = Math.atan2(-ax, Math.sqrt((ay * ay) + (az * az))) * (180 / Math.PI);
  return {
    pitchDegrees,
    rollDegrees,
    gravityMagnitude,
  };
}

async function main() {
  const transport = await LiveI2cTransport.create(BUS_NUMBER);
  const controller = new I2cBusController(transport);
  const sensor = new Bmi160ImuSensor(controller);

  try {
    console.log(`Initialising BMI160 IMU sensor on I2C bus ${BUS_NUMBER} address 0x69...`);
    await sensor.initialise();
    console.log("Calibrating gyro bias. Keep the mower still...");
    await sensor.calibrateGyro();
    console.log("BMI160 ready. Streaming 3-axis gyro (deg/s) and acceleration (m/s^2).\n");

    while (true) {
      const sample = await sensor.read();
      console.log({
        ...sample,
        derived: deriveOrientation(sample),
      });
      await sleep(SAMPLE_INTERVAL_MS);
    }
  } finally {
    await sensor.close();
    await controller.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
