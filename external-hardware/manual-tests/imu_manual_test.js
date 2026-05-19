// Pi-side BMI160 IMU poller for manual bring-up.
// Run `npm run build` first so the built hardware layer exists in `dist/`.

import { Bmi160ImuSensor } from "../../dist/src/hardware/bmi160ImuSensor.js";

const SAMPLE_INTERVAL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const sensor = new Bmi160ImuSensor();

  try {
    console.log("Initialising BMI160 IMU sensor on I2C bus 1 address 0x69...");
    await sensor.initialise();
    console.log("Calibrating gyro bias. Keep the mower still...");
    await sensor.calibrateGyro();
    console.log("BMI160 ready. Streaming 3-axis gyro (deg/s) and acceleration (m/s^2).\n");

    while (true) {
      const sample = await sensor.read();
      console.log(sample);
      await sleep(SAMPLE_INTERVAL_MS);
    }
  } finally {
    await sensor.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
