import { startMowerServer, resolveServerPort } from "./appServer.js";

const host = process.env.MOWER_CORE_APP_HOST ?? "0.0.0.0";
const port = resolveServerPort(process.env.MOWER_CORE_APP_PORT, 8090);
const logDir = process.env.MOWER_LOG_DIR;
const i2cBusNumber = Number(process.env.MOWER_I2C_BUS_NUMBER ?? 1);
const gnssI2cAddress = Number(process.env.MOWER_GNSS_I2C_ADDRESS ?? 0x52);
const sensorPollingIntervalMs = Number(process.env.MOWER_SENSOR_POLL_INTERVAL_MS ?? 33);

const runningServer = await startMowerServer({
  appName: "mower-core",
  host,
  port,
  logDir,
  i2cBusNumber,
  gnssI2cAddress,
  sensorPollingIntervalMs,
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
