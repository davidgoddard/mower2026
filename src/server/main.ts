import { startMowerServer, resolveServerPort } from "./appServer.js";

const host = process.env.MOWER_CORE_APP_HOST ?? "0.0.0.0";
const port = resolveServerPort(process.env.MOWER_CORE_APP_PORT, 8090);
const logDir = process.env.MOWER_LOG_DIR;
const i2cBusNumber = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const gnssI2cAddress = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? 0x52);
const motorI2cAddress = Number(process.env.MOWER_MOTOR_I2C_ADDRESS ?? 0x66);
const leftMotorForwardSign = Number(process.env.MOWER_LEFT_MOTOR_FORWARD_SIGN ?? -1);
const rightMotorForwardSign = Number(process.env.MOWER_RIGHT_MOTOR_FORWARD_SIGN ?? -1);
const sensorPollingIntervalMs = Number(process.env.MOWER_SENSOR_POLL_INTERVAL_MS ?? 33);
const controllerEnabled = (process.env.MOWER_CONTROLLER_ENABLED ?? "1") !== "0";
const controllerSteeringSign = Number(process.env.MOWER_CONTROLLER_STEERING_SIGN ?? -1);
const controllerSpeedSign = Number(process.env.MOWER_CONTROLLER_SPEED_SIGN ?? 1);
const manualDriveLoopMs = Number(process.env.MOWER_MANUAL_DRIVE_LOOP_MS ?? 100);
const maxWheelSpeedMetersPerSecond = Number(process.env.MOWER_MAX_WHEEL_SPEED_MPS ?? 0.75);

const runningServer = await startMowerServer({
  appName: "mower-core",
  host,
  port,
  logDir,
  i2cBusNumber,
  gnssI2cAddress,
  motorI2cAddress,
  leftMotorForwardSign,
  rightMotorForwardSign,
  sensorPollingIntervalMs,
  controllerEnabled,
  controllerSteeringSign,
  controllerSpeedSign,
  manualDriveLoopMs,
  maxWheelSpeedMetersPerSecond,
});

console.log(`mower-core server listening on http://${runningServer.host}:${runningServer.port}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`mower-core received ${signal}; stopping server`);
  try {
    await runningServer.close();
    process.exit(0);
  } catch (error) {
    console.error("mower-core failed to stop cleanly", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
