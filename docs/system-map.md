# System mapping

This document maps problem domains to candidate files removing the need for Codex to scan files looking for where logic etc. is located

## Constants
- `src/constants.ts`: system-wide DESIGN DECISION constants (see `docs/CONSTANTS-ARCHITECTURE.md`).
  - timing design decisions: sensor poll intervals (30Hz), manual drive loop rate, retry policies
  - I2C hardware addresses: GNSS (0x52), motor (0x66), IMU (0x69) - system topology
  - manual drive tuning: 12 parameters for joystick response, deadbands, spin thresholds
  - motor configuration: direction signs for hardware inversion, max wheel speed
  - network configuration: HTTP server defaults, port validation
  - calibration parameters: IMU sample count
  - turn controller parameters: polling interval (50Hz), settle times, ramp times, learning rate, angle bins
- Implementation constants (protocol formats, scaling factors, register values) are LOCAL to their modules, not in this global file.

## Heading and Angle Types
- `src/geometry/headingTypes.ts`: branded types for heading representations to prevent mixing incompatible angle conventions at compile time.
  - `FieldHeading`: GNSS/navigation heading, clockwise from north, range [0, 360)
  - `InternalHeading`: Cartesian heading, counterclockwise from +X axis, range (-180, 180]
  - `RelativeAngle`: signed angular difference for turns/errors, range (-180, 180]
  - `RawAngle`: unnormalized angle marker type
  - conversion functions: `fieldToInternal()`, `internalToField()`
  - angle operations: `headingDifference()`, `addRelativeAngle()`
  - normalization: `normalizeAngleTo180()`, `normalizeAngleTo360()`
- `test/headingTypes.test.js`: comprehensive tests for heading type system including edge cases and real-world scenarios.
- `docs/heading-types-guide.md`: developer guide for using branded heading types safely.

## Logging
- `src/logging/sessionLogger.ts`: public async logger API and session lifecycle management.
- `src/logging/logWriterWorker.ts`: dedicated worker-thread JSONL writer.
- `src/logging/types.ts`: logging entry and API types.
- `src/logging/index.ts`: logging exports.
- `test/logger.test.js`: logger unit tests (local timestamp format, scope, transitions, retention).

## Turn Controller
- `src/control/turnController.ts`: turn execution controller with self-learning brake points
  - executes on-the-spot turns using IMU heading integration
  - polls heading at 30Hz (matches sensor controller update rate)
  - adaptive brake angle learning per turn angle and direction
  - emergency stop support during turn execution
  - tuning sequence runner for comprehensive parameter learning
  - integrates with retry system for obstruction recovery
- `src/control/turnLearningModel.ts`: turn parameter learning and persistence
  - angle binning strategy (10° to 180° in 18 bins)
  - direction-specific learning (CCW vs CW asymmetry)
  - adaptive brake angle updates based on turn error
  - JSON persistence at `config/turn-learning-parameters.json`
- `src/control/turnControllerTypes.ts`: turn controller type definitions
- `src/server/turnTuningPage.ts`: modern responsive web UI for turn tuning
  - real-time turn execution and monitoring
  - results table with error visualization
  - learning parameter display
  - prominent STOP button for emergency abort
- `test/turnController.test.js`: turn controller unit tests
- API endpoints:
  - `GET /turn-tuning` - turn tuning web page
  - `GET /api/turn/status` - controller state and history
  - `POST /api/turn/execute` - execute single turn
  - `POST /api/turn/tune` - run full tuning sequence
  - `POST /api/turn/stop` - emergency stop current turn
  - `POST /api/turn/clear-history` - clear turn history
  - `POST /api/turn/reset-learning` - reset parameters to defaults

## Drive Controller
- `src/control/driveController.ts`: point-to-point driving controller with CTE correction and brake distance learning
  - executes straight-line drives from current position to target position
  - automatic turn-to-face-target before driving
  - continuous cross-track error (CTE) correction during drive
  - adaptive brake distance learning for arrival accuracy
  - integrates with retry system for obstruction recovery
  - creates checkpoints for retry system before each drive
- Drive sequence: settle → get pose → turn to target → settle → get pose → drive with CTE correction → brake → settle → measure errors → update learning
- API: `driveToTarget(target)`, `reverseForDuration(ms)` for retry recovery

## Retry System (Obstruction Recovery)
- `src/retry/retryManager.ts`: **EVENT-DRIVEN RECOVERY SYSTEM** - handles obstruction detection and context-aware recovery
  - subscribes to `obstructionDetected` events from sensor controller
  - session tracking: max 3 retry attempts per session before abort
  - context-aware recovery strategies:
    - **Line driving**: reverse 2 seconds, retry forward to target
    - **Path following**: retrace backwards 5 waypoints, resume forward
    - **Turn on spot**: escape turn opposite direction 2 seconds, retry original heading
  - emergency abort: powers off motors after max retries exceeded
  - comprehensive logging at each recovery step with algorithm-specific prefixes
- `src/retry/checkpointStore.ts`: checkpoint storage for recovery points
  - maintains circular buffer of last 10 checkpoints
  - context-specific checkpoint retrieval (line, path, turn)
  - automatic cleanup of old checkpoints
- `src/retry/retryTypes.ts`: type definitions for retry system
  - `ObstructionType`: high_current, wheel_slip, stall
  - `OperationContext`: line, path, turn
  - `Checkpoint`: recovery point with pose and context metadata
- Obstruction detection conditions:
  - Motor current > 2A threshold (configurable)
  - Wheel slip: encoder movement but position stationary
  - Stall: position stationary for 1 second with motors engaged

## Path Following
- `src/pathfollowing/pathFollowerApi.ts`: **PATH FOLLOWING API** - abstract interface supporting multiple algorithms
  - `IPathFollower`: interface for path following implementations (Pure Pursuit, Arc Interpolation, etc.)
  - `IPathRecorder`: interface for recording paths during manual driving
  - `IPathStore`: interface for persistent path storage
  - API methods: `followPath()`, `followPathPoints()`, `resumeFromWaypoint()`, `retraceToWaypoint()`, `stop()`
  - State: current path, waypoint index, distance to target, cross-track error
- `src/pathfollowing/purePursuitFollower.ts`: **PURE PURSUIT ALGORITHM IMPLEMENTATION**
  - adaptive lookahead distance (0.5m - 2.0m) based on speed and path curvature
  - smooth arc following using differential wheel speeds
  - automatic pivot turns for tight radius (<0.5m) - one wheel stationary
  - 20Hz control loop (configurable)
  - curvature calculation: κ = 2 * sin(α) / L (classic Pure Pursuit formula)
  - integrates with retry system via checkpoint creation
  - algorithm-specific logging with `pure_pursuit.*` prefixes
- `src/pathfollowing/pathStore.ts`: JSON-based persistent storage for recorded paths
  - file format: `{name}.path.json` in configured storage directory
  - in-memory caching for loaded paths
  - path metadata: total distance, point count, creation timestamp
- `src/pathfollowing/pathRecorder.ts`: records paths during manual driving
  - subscribes to `poseUpdate` events from pose fusion
  - records position every 10cm (configurable distance threshold)
  - start/stop recording with named paths
  - automatic point filtering based on movement threshold
- `src/geometry/positionTypes.ts`: geometry functions for path following
  - cross-track error calculation for line/arc following
  - point-to-line distance calculations
  - along-track progress measurement

## Sensors and Hardware
- `src/imu/bmi160ImuSensor.ts`: BMI160 gyro and accelerometer access over I2C.
  - gyro: Z-axis angular velocity for heading integration
  - accelerometer: 3-axis (X, Y, Z) for pitch and roll calculation
  - bias calibration on startup for drift compensation
  - pitch/roll zeroing to establish level reference on uneven ground
- `src/imu/bmi160Registers.ts`: BMI160 register/command constants.
- `src/imu/types.ts`: IMU sample and sensor contracts.
- `src/gnss/gnssProtocol.ts`: GNSS sample contract used by runtime.
- `src/gnss/gnssCodec.ts`: GNSS payload decoding (supports both 36-byte and 38-byte payload layouts).
- `src/gnss/gnssNodeClient.ts`: GNSS request/response polling client over I2C framed protocol.
- `src/motors/motorProtocol.ts`: motor command/feedback contracts.
- `src/motors/motorCodec.ts`: wheel-speed command encoding and motor-feedback payload decoding.
- `src/motors/motorMapping.ts`: app-facing forward-positive wheel convention mapping to/from raw motor node direction signs.
- `src/motors/motorNodeClient.ts`: motor command send + feedback polling over framed I2C protocol.
  - includes motor current sensing data in feedback samples
- `src/controller/hidGameController.ts`: HID game controller input adapter and button event source.
- `src/control/manualDriveProfile.ts`: manual drive demand shaping (deadband/arc/spin response).
- `src/control/manualDriveCoordinator.ts`: manual-drive loop; maps controller input to motor commands.
  - arm/disarm mapping: `right-top` arms, `left-top` disarms and stops.
  - safety behavior: controller disconnect while armed triggers disarm + stop.
- `src/protocols/commonProtocol.ts`: shared node/message identifiers and frame header shape.
- `src/protocols/codecPrimitives.ts`: optional scalar codec helpers for protocol payloads.
- `src/bus/frameCodec.ts`: frame encode/decode and CRC validation.
- `src/bus/crc.ts`: CRC16-CCITT implementation.
- `src/sensing/sensorController.ts`: single 30Hz sensor polling controller and latest sensor state integration.
  - heading API: `getHeading()` returns `InternalHeading`; `setHeading(InternalHeading)` for absolute heading reset integration.
  - heading convention: uses `InternalHeading` type internally; GNSS field headings converted via `fieldToInternal()`.
  - IMU yaw integration: uses `addRelativeAngle()` with `RelativeAngle` deltas from gyro samples.
  - IMU pitch/roll: calculated from accelerometer using atan2 formulas
  - motor API: `setMotorWheelSpeeds(...)` and `stopMotors()` command passthrough to hardware boundary.
  - **obstruction detection**: emits `obstructionDetected` events for high motor current, wheel slip, and stall conditions
- `src/sensing/sensorEvents.ts`: type-safe event definitions for sensor controller.
  - `ImuHeadingUpdateEvent`: heading, pitch, roll from IMU
  - `GnssPositionUpdateEvent`: position, heading, fix quality from GNSS
  - `MotorFeedbackUpdateEvent`: wheel speeds, encoder deltas, PWM, current, watchdog/fault state
  - `ObstructionDetectedEvent`: obstruction type, motor currents, wheel speeds
- `src/sensing/sensorHardwareGateway.ts`: hardware adapter boundary between application sensor controller and physical sensor drivers.
- `src/i2c/types.ts`: I2C transport and queued request types.
- `src/i2c/priorities.ts`: queue priorities for stop/motor/GNSS/IMU operations.
- `src/i2c/i2cBusController.ts`: single-bus queued priority controller with key-based request replacement.
- `src/i2c/liveI2cTransport.ts`: live Raspberry Pi I2C transport (`i2c-bus` module wrapper).
- `test/i2cBusController.test.js`: queue priority and replacement behavior tests.
- `test/bmi160ImuSensor.test.js`: BMI160 initialise/calibration/read conversion tests.
- `test/sensorController.test.js`: sensor controller loop and state integration tests.
- `test/motorNodeClient.test.js`: motor command priority and feedback-frame decode tests.
- `test/motorMapping.test.js`: motor direction sign mapping tests.
- `test/manualDriveProfile.test.js`: manual-drive demand shaping tests.

## Pose Estimation and Sensor Fusion
- `src/sensing/poseFusion.ts`: **POSE ESTIMATION IS HERE** - combines GNSS, IMU, and encoder feedback for best-estimate pose.
  - maintains current position (X, Y meters) and heading (InternalHeading)
  - quality tracking: "gnss" (RTK fixed/float), "dead-reckoning", or "unknown"
  - GNSS position updates: accepts high-quality GNSS fixes (RTK fixed/float with <0.1m accuracy)
  - GNSS heading fusion: updates from stable GNSS dual-antenna heading when available
  - IMU heading integration: continuously integrates IMU yaw for heading during GNSS gaps
  - encoder dead-reckoning: integrates motor encoder deltas for position during GNSS gaps
  - heading reset API: `setHeading()` for external absolute heading corrections
  - pose API: `getCurrentPose()` returns current position, heading, and quality
  - emits `poseUpdate` events on every update
- `src/geometry/positionTypes.ts`: branded types for position and pose.
  - `Meters`: branded number for type-safe distance values
  - `Position`: X/Y position in meters
  - `Pose`: position + heading + quality indicator
  - geometry functions: `distanceBetween()`, `angleTo()`, `crossTrackError()`, `calculateXError()`

## Operation And Server Entry
- `src/server/main.ts`: production server entrypoint (compiled to `dist/server/main.js`).
- `src/server/appServer.ts`: HTTP server bootstrapping, routing, and graceful shutdown.
- `src/server/homePage.ts`: minimal tabbed UI page with a Primitives tab.
- `src/server/primitivesStore.ts`: in-memory primitives state holder.
  - primitives payload shape contains `imu`, `gnss`, and `motors` sections.
- `docs/sensors.md`: sensor boundary/API contract, heading convention, GNSS frame/payload documentation, and primitive field purpose.
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
- `src/index.ts`: main module exports including heading type system for external consumers.
- `test/index.test.js`: basic runtime module tests including heading normalization.
