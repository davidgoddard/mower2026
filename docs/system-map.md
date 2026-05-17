# System mapping

This document maps problem domains to candidate files removing the need for Codex to scan files looking for where logic etc. is located

## Logging
- `src/logging/sessionLogger.ts`: public async logger API and session lifecycle management.
- `src/logging/logWriterWorker.ts`: dedicated worker-thread JSONL writer.
- `src/logging/types.ts`: logging entry and API types.
- `src/logging/index.ts`: logging exports.
- `test/logger.test.js`: logger unit tests (local timestamp format, scope, transitions, retention).

## Heading and Position
- `src/imu/bmi160ImuSensor.ts`: BMI160 gyro access and bias calibration over I2C.
- `src/imu/bmi160Registers.ts`: BMI160 register/command constants.
- `src/imu/types.ts`: IMU sample and sensor contracts.
- `src/sensing/sensorController.ts`: single 30Hz sensor polling controller and latest sensor state integration.
  - heading API: `getHeadingDegrees()` and `setHeadingDegrees(...)` for absolute heading reset integration.
- `src/sensing/sensorHardwareGateway.ts`: hardware adapter boundary between application sensor controller and physical sensor drivers.
- `src/i2c/types.ts`: I2C transport and queued request types.
- `src/i2c/priorities.ts`: queue priorities for stop/motor/GNSS/IMU operations.
- `src/i2c/i2cBusController.ts`: single-bus queued priority controller with key-based request replacement.
- `src/i2c/liveI2cTransport.ts`: live Raspberry Pi I2C transport (`i2c-bus` module wrapper).
- `test/i2cBusController.test.js`: queue priority and replacement behavior tests.
- `test/bmi160ImuSensor.test.js`: BMI160 initialise/calibration/read conversion tests.
- `test/sensorController.test.js`: sensor controller loop and state integration tests.

## Operation And Server Entry
- `src/server/main.ts`: production server entrypoint (compiled to `dist/server/main.js`).
- `src/server/appServer.ts`: HTTP server bootstrapping, routing, and graceful shutdown.
- `src/server/homePage.ts`: minimal tabbed UI page with a Primitives tab.
- `src/server/primitivesStore.ts`: in-memory primitives state holder.
  - primitives payload shape contains `imu`, `gnss`, and `motors` sections.
- `scripts/mower-launch.sh`: launcher used by both `npm run start` and systemd.
- `systemd/mower.service.template`: systemd unit template for runtime process management.
- `systemd/install-mower-service.sh`: installer for `/etc/systemd/system/mower.service`.
- `test/server.test.js`: server unit/integration tests.

## Project Build And Test Tooling
- `package.json`:
  - `build`: TypeScript compile (`node ./node_modules/typescript/bin/tsc -p tsconfig.json`)
  - `test`: runs full unit test suite (`node --test test`)
  - `start`: runs production launcher (`./scripts/mower-launch.sh`)
  - `lint`: runs static validation via TypeScript (`npm run typecheck`)
  - `typecheck`: strict type validation (`node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`)
- `tsconfig.json`: TypeScript compiler and project type-check settings.
- `src/index.ts`: skeletal runtime module compiled into `dist/`.
- `test/index.test.js`: unit tests executed by Node's built-in test runner.
