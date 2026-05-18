import { startMowerServer, resolveServerPort } from "./appServer.js";
import {
  HTTP_SERVER_HOST_DEFAULT,
  HTTP_SERVER_PORT_DEFAULT,
  I2C_BUS_NUMBER_DEFAULT,
  I2C_ADDRESS_GNSS_DEFAULT,
  I2C_ADDRESS_MOTOR_DEFAULT,
  MOTOR_LEFT_FORWARD_SIGN_DEFAULT,
  MOTOR_RIGHT_FORWARD_SIGN_DEFAULT,
  SENSOR_POLL_INTERVAL_MS,
  CONTROLLER_STEERING_SIGN_DEFAULT,
  CONTROLLER_SPEED_SIGN_DEFAULT,
  MANUAL_DRIVE_LOOP_INTERVAL_MS,
  MAX_WHEEL_SPEED_MPS_DEFAULT,
} from "../constants.js";

const host = process.env.MOWER_CORE_APP_HOST ?? HTTP_SERVER_HOST_DEFAULT;
const port = resolveServerPort(process.env.MOWER_CORE_APP_PORT, HTTP_SERVER_PORT_DEFAULT);
const logDir = process.env.MOWER_LOG_DIR;
const i2cBusNumber = Number(process.env.MOWER_I2C_BUS_NUMBER ?? I2C_BUS_NUMBER_DEFAULT);
const gnssI2cAddress = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? I2C_ADDRESS_GNSS_DEFAULT);
const motorI2cAddress = Number(process.env.MOWER_MOTOR_I2C_ADDRESS ?? I2C_ADDRESS_MOTOR_DEFAULT);
const leftMotorForwardSign = Number(process.env.MOWER_LEFT_MOTOR_FORWARD_SIGN ?? MOTOR_LEFT_FORWARD_SIGN_DEFAULT);
const rightMotorForwardSign = Number(process.env.MOWER_RIGHT_MOTOR_FORWARD_SIGN ?? MOTOR_RIGHT_FORWARD_SIGN_DEFAULT);
const sensorPollingIntervalMs = Number(process.env.MOWER_SENSOR_POLL_INTERVAL_MS ?? SENSOR_POLL_INTERVAL_MS);
const controllerEnabled = (process.env.MOWER_CONTROLLER_ENABLED ?? "1") !== "0";
const controllerSteeringSign = Number(process.env.MOWER_CONTROLLER_STEERING_SIGN ?? CONTROLLER_STEERING_SIGN_DEFAULT);
const controllerSpeedSign = Number(process.env.MOWER_CONTROLLER_SPEED_SIGN ?? CONTROLLER_SPEED_SIGN_DEFAULT);
const manualDriveLoopMs = Number(process.env.MOWER_MANUAL_DRIVE_LOOP_MS ?? MANUAL_DRIVE_LOOP_INTERVAL_MS);
const maxWheelSpeedMetersPerSecond = Number(process.env.MOWER_MAX_WHEEL_SPEED_MPS ?? MAX_WHEEL_SPEED_MPS_DEFAULT);

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
