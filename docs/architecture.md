# Architecture

## Top-level split

The system has three computing domains:

- Raspberry Pi application
- GNSS ESP node
- Motor ESP node

The IMU is currently expected to remain Pi-side hardware rather than moving to an ESP node. The legacy mower wiring used a BMI160-class device on the Pi I2C chain at address `0x69`.

The Pi owns truth and intent. The ESP nodes own time-critical execution.

## Data flow

1. GNSS ESP publishes compact navigation samples.
2. Motor ESP publishes compact wheel and fault feedback.
3. Pi adapts those into estimator measurements.
4. Estimator produces pose and confidence.
5. Guidance computes vehicle motion intent toward a target line or waypoint.
6. Control converts intent into wheel targets.
7. Motor node executes wheel targets and reports what actually happened.

## Current implemented runtime slice

The codebase now contains a minimal but executable control path:

1. `PollingGnssNodeClient` and `PollingMotorNodeClient` fetch framed node data.
2. `GnssAdapter` and `MotorFeedbackAdapter` convert raw protocol data into measurements.
3. `PoseEstimator` integrates wheel odometry and blends GNSS corrections.
4. `LineTracker` computes forward speed and yaw-rate intent for a target line.
5. `WheelCommandPlanner` and `CommandLimiter` produce bounded wheel targets.
6. `RuntimeApp` executes one control cycle and applies `RuleBasedSafetyManager` decisions.
7. Telemetry and events can be captured via memory loggers and replayed in tests.

## Current operator app boundary

The intended Pi-side operator boundary is now a single core app:

- `pi-app/core_server.js`
- `pi-app/web/core_dashboard.html`

That core app is responsible for:

- booting into manual drive by default
- hosting the landing page on the Pi
- exposing mode switching between:
  - manual
  - site capture
  - autonomous
- keeping one shared live controller/sensor/estimator loop behind those modes

Current implementation status:

- manual mode is live
- site-capture mode is live for first-pass perimeter/obstacle recording
- autonomous mode is a shell only and does not yet execute mowing missions

## Design constraints

- I2C bandwidth is limited, so messages must be compact and mower-oriented.
- Bus details must not leak into guidance or estimator code.
- Calibration must use the same runtime interfaces as normal operation.
- Logging must support both live diagnosis and offline replay.

## Module map

- `app/`: runtime entrypoints and orchestration
- `bus/`: transport abstraction and frame encoding
- `protocols/`: message shapes and transport-neutral payload models
- `nodes/`: clients for GNSS and motor nodes
- `sensing/`: adaptation of raw node messages into estimator measurements
- `estimation/`: pose, trust, bias, and slip logic
- `guidance/`: line geometry and route tracking
- `control/`: compensation, wheel planning, command limiting
- `calibration/`: test sequencing, fitting, validation, reporting
- `config/`: parameter schema, defaults, persistence
- `logging/`: telemetry, event, and replay interfaces
- `safety/`: safety state and rules
- `util/`: pure math and time helpers

## Firmware implications

The motor firmware needs a redesign around explicit wheel-speed commands and richer feedback. The GNSS firmware may need message additions, but those additions must stay compact enough for I2C.

Current IMU implication:

- the Pi-side sensing layer now has an explicit raw IMU sample interface and adapter shape for a three-axis gyro plus three-axis accelerometer path
