export function normalizeHeadingDegrees(heading: number): number {
  const fullTurn = 360;
  const normalized = ((heading % fullTurn) + fullTurn) % fullTurn;
  return normalized;
}

export { SessionLogger } from "./logging/index.js";
export { routeServerRequest, startMowerServer, resolveServerPort } from "./server/appServer.js";
export { PrimitivesStore } from "./server/primitivesStore.js";
export { I2cBusController } from "./i2c/i2cBusController.js";
export { I2C_PRIORITY } from "./i2c/priorities.js";
export { Bmi160ImuSensor } from "./imu/bmi160ImuSensor.js";
export { SensorController } from "./sensing/sensorController.js";
export { createPiSensorHardwareGateway } from "./sensing/sensorHardwareGateway.js";
