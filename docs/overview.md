# Autonomous Mower Software Design

## Project goal

I want software that runs on a Pi and communicates with motors and sensors to work out the mower state; position, heading etc.

I want the mower to be able eventually to map out its environment through a manually driven drive around the area to be mown and from this get a mowing plan and then execute it each day without re-tracing.  I.e. power up and mow.

Before that, I want to re-visit the hardware interfaces and the GPS-RTK messages received and sensor use to ensure the Pi has all the information and tools it needs.  

Then I want to build software that will allow for a self-configuring and constantly monitoring app that can take input either from a games controller for manual driving or to follow a route around the lawn.

Each leg of a route will require orientation and then driving in a dead straight line to the target.  The system's self-configuration phase is to allow for the mower to determine the differences in the motors, how the gps changes in rotation etc.

A perfect drive requires rotation that ends exactly pointing at the target and the drive is straight along the line between the start point and the target and arrival is to stop exactly on the target; no overrun, no missing by 10cm etc.

The software's self calibration should include a set of tests it can perform once I place the mower into the middle of the lawn where it will have a 4 meter square in which it can consider it is in the middle.  Within this space only the mower must learn its turning and driving parameters.  It should learn the control of the fastest spin on the spot that ends aligned perfectly to the target - no overshoot or undershoot.   Then it should learn some forward and backward driving to learn the differences in the motors to be able to compensate for natural turning or drift in the design.  Then learn the paramers needed to ensure a straight drive along the line minimising turn angles and oscillations whilst minimising the distance from the perfect line.

Finally I want to have a test app I can use with the games controller where by I drive a route marking some way points via a push-button and then when I press a go button, the mower should re-run the exact route but with pefect straight lines and perfect turns.  I will want logging of errors during the learning and test runs so that I can be sure when it is ready to use.

## Responsibilities

I give you full permission to read and write to the mower folder performing all operating system commands you need to achieve this work.  I want progress logged and I want each actual requirement written into a functional specification with a cross reference at the end that shows whether the requirements are not met, partially met or fully met with notes on the status so that this can be resumed by you later.

I want all code to be well written, modular and commented.

I want all testable methods and classes to be unit tested clearly and I want the unit tests run between each new feature development to ensure progress is forward not backward.

Anything that is not clear, I want to be involved in resolving with you and to work with you to make this a high quality project.

## TypeScript + Raspberry Pi + GNSS ESP + Motor ESP

This version assumes:

* **Raspberry Pi** runs the main TypeScript application
* **GNSS ESP** talks to the UM982, receives RTK corrections, decodes GNSS/dual-antenna data, and publishes mower-ready navigation samples
* **Motor ESP** handles PWM, encoder counting, wheel-speed execution, ramps, reversal handling, watchdogs, and low-level motor faults
* Pi communicates with these nodes over a bus such as **I²C now**, with the design written so it can later move to **CAN** without rewriting the navigation stack

The main architectural point is:

* **Pi owns truth and intent**
* **ESPs own real-time hardware execution**

---

# 1. Goals

The software should:

* estimate vehicle position, heading, speed, yaw rate, and confidence
* follow a straight line from current position to target position
* tolerate changing GNSS quality and temporary RTK loss
* compensate for slope, motor asymmetry, and wheel slip
* support self-calibration and replay-based testing
* keep low-level timing-sensitive behaviour off the Pi

---

# 2. System split

## Raspberry Pi

Owns:

* parameter store
* logging and replay
* measurement conditioning
* state estimation
* adaptive sensor trust
* line tracking / guidance
* vehicle-level compensation
* calibration supervisor
* mission/mode logic
* safety decisions at system level

## GNSS ESP

Owns:

* RTK correction transport
* UM982 comms
* parsing GNSS and dual-antenna heading
* conversion into compact transport messages
* GNSS status reporting
* local watchdog / health state

## Motor ESP

Owns:

* reading wheel encoders
* wheel-speed execution
* PWM and direction output
* smooth ramps and reversals
* low-level motor safety
* command timeout fail-safe
* fault/status reporting

---

# 3. Recommended command boundary

This is the most important design decision.

## Pi should send:

* **left wheel target speed**
* **right wheel target speed**
* optional accel/decel limits
* enable/disable state
* sequence number / timeout

## Motor ESP should send back:

* achieved wheel speeds
* encoder counts/deltas
* PWM actually applied
* currents if available
* fault flags
* watchdog status

Do **not** make the Pi send only vague commands like:

* “turn left”
* “go forward slowly”
* “reverse a bit”

That makes estimation, calibration, and debugging much harder.

---

# 4. Suggested source tree

```text
src/
  app/
    runtimeApp.ts
    calibrationApp.ts

  bus/
    busAdapter.ts
    i2cBusAdapter.ts
    canBusAdapter.ts
    frameCodec.ts
    crc.ts

  nodes/
    gnssNodeClient.ts
    motorNodeClient.ts
    nodeHealth.ts

  protocols/
    gnssProtocol.ts
    motorProtocol.ts
    commonProtocol.ts

  sensing/
    gnssAdapter.ts
    imuAdapter.ts
    motorFeedbackAdapter.ts
    coordinateFrame.ts
    signalFilters.ts
    measurementTypes.ts

  estimation/
    poseEstimator.ts
    adaptiveTrust.ts
    slipDetector.ts
    biasTracker.ts
    estimatorTypes.ts

  guidance/
    lineGeometry.ts
    lineTracker.ts
    missionTypes.ts
    guidanceTypes.ts

  control/
    vehicleCompensation.ts
    wheelCommandPlanner.ts
    commandLimiter.ts
    controlTypes.ts

  calibration/
    calibrationSupervisor.ts
    testSequences.ts
    metrics.ts
    parameterFitter.ts
    parameterValidator.ts
    calibrationTypes.ts

  config/
    parameterStore.ts
    parameterSchema.ts
    defaults.ts

  logging/
    telemetryLogger.ts
    replayReader.ts
    eventLogger.ts

  safety/
    safetyManager.ts
    faultRules.ts

  util/
    math.ts
    angles.ts
    time.ts
    ringBuffer.ts
```

---

# 5. Module roles and responsibilities

## `app/runtimeApp.ts`

Top-level runtime coordinator.

Responsibilities:

* initialize bus and node clients
* load parameters
* run main control loop
* collect telemetry
* invoke safety logic
* dispatch wheel commands to motor node

It should orchestrate modules, not contain detailed maths.

---

## `app/calibrationApp.ts`

Top-level calibration entry point.

Responsibilities:

* run calibration sequences
* command test manoeuvres
* collect logs
* fit candidate parameters
* validate updates
* store approved parameters
* generate reports

It should use the same runtime interfaces as normal operation, not bypass them.

---

## `bus/*`

Abstract transport away from the application.

Goal:
the estimator/guidance/control code should not care whether the transport is I²C or CAN.

### `busAdapter.ts`

Defines a common interface such as:

```ts
export interface BusAdapter {
  send(nodeId: number, payload: Uint8Array): Promise<void>;
  request(nodeId: number, payload: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

### `i2cBusAdapter.ts`

Current implementation for I²C.

### `canBusAdapter.ts`

Future implementation for CAN.

### `frameCodec.ts`

Encodes/decodes protocol frames:

* message type
* payload length
* sequence
* CRC

---

## `nodes/gnssNodeClient.ts`

Client for the GNSS ESP.

Responsibilities:

* poll or receive GNSS node frames
* decode them into typed objects
* track freshness and health
* expose latest GNSS sample to sensing layer

It should not decide how much the estimator trusts GNSS.

---

## `nodes/motorNodeClient.ts`

Client for the motor ESP.

Responsibilities:

* send wheel commands
* receive motor feedback
* track sequence, freshness, and watchdog state
* surface low-level motor faults

It should not decide how the mower follows a path.

---

## `sensing/gnssAdapter.ts`

Converts GNSS node messages into estimator-ready measurements.

Responsibilities:

* convert local XY into measurement objects
* interpret heading validity
* map RTK mode/status into confidence hints
* reject stale data

---

## `sensing/imuAdapter.ts`

Handles Pi-side IMU if connected to the Pi.

Responsibilities:

* apply IMU bias and alignment corrections
* produce yaw-rate and roll measurements
* timestamp and filter samples

If IMU is on a node instead, keep the same adapter interface and change only transport.

---

## `sensing/motorFeedbackAdapter.ts`

Converts motor node feedback into usable measurements.

Responsibilities:

* derive wheel speed measurements
* derive wheel distance increments
* expose PWM/current/fault context for logging and slip detection

---

## `estimation/poseEstimator.ts`

Core fusion module.

Responsibilities:

* estimate:

  * `x`
  * `y`
  * `heading`
  * `yawRate`
  * `speed`
  * `roll`
  * uncertainty values
* fuse:

  * GNSS position
  * dual-antenna heading when valid
  * IMU yaw rate
  * IMU roll
  * encoder wheel motion
* keep running during GNSS degradation
* recover cleanly when GNSS returns

This is where “use gyro more than GPS right now” belongs.

---

## `estimation/adaptiveTrust.ts`

Owns adaptive measurement trust logic.

Responsibilities:

* evaluate GNSS innovation consistency
* reduce GNSS trust when degraded
* reduce encoder trust when slip suspected
* handle heading trust differently at low speed vs high speed

This should output trust/covariance adjustments used by `poseEstimator.ts`.

---

## `estimation/slipDetector.ts`

Detect likely slip.

Responsibilities:

* compare encoder-derived motion vs GNSS motion
* compare encoder-derived turn vs gyro yaw-rate
* set `slipSuspected` flags
* expose confidence penalties

---

## `estimation/biasTracker.ts`

Tracks slow-changing biases.

Examples:

* gyro bias
* perhaps steering bias if estimator-owned

---

## `guidance/lineGeometry.ts`

Geometry helpers.

Responsibilities:

* represent a line from start to target
* compute signed cross-track error
* compute along-track position
* compute desired line heading

Pure math. Easy to unit test.

---

## `guidance/lineTracker.ts`

Generates vehicle motion intent.

Responsibilities:

* read estimated state
* compute line errors
* output:

  * desired forward speed
  * desired steering demand

It should know:

* line geometry
* state uncertainty enough to slow down when localization degrades

It should not know:

* PWM
* encoder tick formats
* UM982 packet details

---

## `control/vehicleCompensation.ts`

Applies mower-specific corrections.

Responsibilities:

* steering trim
* slope compensation
* left/right asymmetry compensation
* optional uncertainty-based softening

This is where learned vehicle quirks are handled.

---

## `control/wheelCommandPlanner.ts`

Converts motion intent into wheel targets.

Responsibilities:

* combine guidance output with compensation
* produce left/right speed targets
* maintain clear meaning of commanded wheel speeds

---

## `control/commandLimiter.ts`

Applies safety and smoothness constraints.

Responsibilities:

* clamp max speed
* clamp max wheel delta
* clamp accel/decel
* reduce command aggressiveness when localization quality is poor

---

## `calibration/calibrationSupervisor.ts`

Runs the self-calibration sequence.

Responsibilities:

* execute test stages
* request straight runs, turn tests, slope runs
* gather telemetry windows
* invoke fitters and validators
* write approved parameters

This is an orchestrator, not a maths dump.

---

## `calibration/testSequences.ts`

Defines reusable manoeuvres.

Examples:

* stationary hold
* drive straight N meters
* reverse N meters
* spin in place
* constant curvature arc
* side-slope traverse

---

## `calibration/metrics.ts`

Calculates calibration scores.

Examples:

* RMS cross-track error
* mean signed cross-track error
* final offset
* heading RMS
* oscillation metric
* control effort

---

## `calibration/parameterFitter.ts`

Fits candidate parameter updates from logs.

Examples:

* steering trim
* slope coefficient
* GNSS trust scaling
* deadband estimates
* guidance strengths

---

## `calibration/parameterValidator.ts`

Rejects nonsense.

Rules such as:

* parameter within plausible range
* updated configuration improves score
* no obvious instability
* no safety thresholds violated

---

## `config/parameterStore.ts`

Persistent config and learned values.

Responsibilities:

* load/save JSON or binary parameter sets
* version schema
* validate on load
* support defaults and upgrade path

---

## `logging/telemetryLogger.ts`

Structured runtime logging.

Responsibilities:

* record raw node messages
* record conditioned measurements
* record estimated state
* record guidance outputs
* record wheel commands
* record faults and status

Without this, tuning will be miserable.

---

## `logging/replayReader.ts`

Replay captured logs through estimator/guidance/calibration offline.

This should be built early.

---

## `safety/safetyManager.ts`

Final authority for safe operation.

Responsibilities:

* stop on stale node data
* stop on motor fault
* slow down on degraded localization
* stop on excessive uncertainty
* stop on command timeout issues

---

# 6. Message contracts

These are logical TypeScript contracts. The wire format can be binary.

## 6.1 Common protocol fields

Every frame should include:

* message type
* protocol version
* sequence number
* timestamp or source uptime
* payload
* CRC/checksum

---

## 6.2 GNSS ESP → Pi

```ts
export type RtkMode = "none" | "single" | "float" | "fixed";

export interface GnssNodeSample {
  sourceTimeUs: number;
  sequence: number;

  xMeters: number;
  yMeters: number;

  positionValid: boolean;
  horizAccuracyM: number;

  dualHeadingRad?: number;
  headingValid: boolean;
  headingAccuracyRad?: number;

  speedMps?: number;
  speedValid: boolean;

  rtkMode: RtkMode;
  satelliteCount: number;
  ageOfCorrectionsS?: number;

  faultFlags: number;
}
```

### Notes

* `xMeters`, `yMeters` should already be in a local frame if possible
* if the GNSS ESP cannot safely project to local XY, it can send lat/lon and let the Pi project, but local XY is cleaner for the runtime stack
* dual-antenna heading should be sent separately from motion-derived heading
* validity and uncertainty must be explicit

---

## 6.3 Pi → GNSS ESP

Only needed if the Pi manages configuration or passes RTCM elsewhere.

```ts
export interface GnssNodeCommand {
  sequence: number;
  requestStatus?: boolean;
  setBaseFrame?: boolean;
  resetFaults?: boolean;
}
```

If GNSS ESP is mostly autonomous, this can stay minimal.

---

## 6.4 Motor ESP → Pi

```ts
export interface MotorNodeFeedback {
  sourceTimeUs: number;
  sequence: number;

  leftEncoderCount: number;
  rightEncoderCount: number;

  leftWheelSpeedMps: number;
  rightWheelSpeedMps: number;

  leftPwm: number;
  rightPwm: number;

  leftCurrentA?: number;
  rightCurrentA?: number;

  enabled: boolean;
  watchdogHealthy: boolean;
  faultFlags: number;
}
```

### Recommended fault flags

Examples:

* overcurrent
* encoder fault
* command timeout
* driver fault
* emergency stop active
* wheel loop unstable
* overtemperature

---

## 6.5 Pi → Motor ESP

```ts
export interface WheelCommand {
  hostTimeUs: number;
  sequence: number;

  enable: boolean;

  leftWheelTargetMps: number;
  rightWheelTargetMps: number;

  maxAccelMps2?: number;
  maxDecelMps2?: number;

  commandTimeoutMs: number;
}
```

### Notes

* wheel target speeds should be explicit and signed
* the motor ESP should reject stale or repeated sequence numbers if appropriate
* the motor ESP should stop safely if commands stop arriving before `commandTimeoutMs`

---

## 6.6 Optional motor config message

```ts
export interface MotorNodeConfig {
  sequence: number;
  leftDeadband?: number;
  rightDeadband?: number;
  maxPwm?: number;
  resetFaults?: boolean;
}
```

Use this only for low-level motor-node tuning, not routine path following.

---

# 7. TypeScript domain types

## 7.1 Measurements

```ts
export interface GnssMeasurement {
  timestampUs: number;
  xMeters: number;
  yMeters: number;
  positionStdM: number;
  headingRad?: number;
  headingStdRad?: number;
  speedMps?: number;
  rtkMode: RtkMode;
  valid: boolean;
}

export interface ImuMeasurement {
  timestampUs: number;
  yawRateRadS: number;
  rollRad: number;
  valid: boolean;
}

export interface WheelMeasurement {
  timestampUs: number;
  leftWheelSpeedMps: number;
  rightWheelSpeedMps: number;
  leftEncoderCount: number;
  rightEncoderCount: number;
  valid: boolean;
}
```

---

## 7.2 Estimated state

```ts
export type LocalizationMode = "good" | "degraded" | "poor";

export interface EstimatedState {
  timestampUs: number;

  xMeters: number;
  yMeters: number;
  headingRad: number;
  yawRateRadS: number;
  speedMps: number;
  rollRad: number;

  positionUncertaintyM: number;
  headingUncertaintyRad: number;

  localizationMode: LocalizationMode;
  slipSuspected: boolean;
}
```

---

## 7.3 Guidance output

```ts
export interface GuidanceCommand {
  timestampUs: number;

  speedTargetMps: number;
  steeringDemand: number;

  crossTrackErrorM: number;
  headingErrorRad: number;
}
```

---

## 7.4 Wheel targets

```ts
export interface WheelTargets {
  timestampUs: number;
  leftWheelTargetMps: number;
  rightWheelTargetMps: number;
}
```

---

# 8. Parameter schema

Use one structured object, versioned.

```ts
export interface SystemParameters {
  schemaVersion: number;

  sensing: {
    imuYawRateBiasRadS: number;
    imuRollOffsetRad: number;
    leftEncoderScale: number;
    rightEncoderScale: number;
  };

  estimation: {
    baseGnssPosStdM: number;
    baseGnssHeadingStdRad: number;
    gyroYawRateStdRadS: number;
    encoderSpeedStdMps: number;

    gnssFloatTrustScale: number;
    gnssFixedTrustScale: number;
    encoderSlipTrustPenalty: number;

    lowSpeedHeadingThresholdMps: number;
  };

  guidance: {
    crossTrackStrength: number;
    headingStrength: number;
    yawDampingStrength: number;

    nominalSpeedMps: number;
    degradedSpeedMps: number;
    poorSpeedMps: number;
  };

  vehicle: {
    steeringTrim: number;
    slopeCompensationGain: number;
    leftRightAsymmetryGain: number;

    maxWheelSpeedMps: number;
    maxWheelAccelMps2: number;
    maxWheelDecelMps2: number;
  };

  calibration: {
    trimLearningRate: number;
    slopeLearningRate: number;
    trustAdaptationRate: number;
  };
}
```

---

# 9. Runtime loop

## 9.1 Responsibilities per cycle

At each loop:

1. fetch latest node data
2. convert to measurements
3. update estimator
4. compute line-following demand
5. apply vehicle compensation
6. generate wheel targets
7. limit commands
8. send wheel command to motor ESP
9. log everything
10. run safety checks

---

## 9.2 Pseudocode

```ts
async function runtimeTick(ctx: RuntimeContext): Promise<void> {
  const gnssSample = await ctx.gnssNode.getLatestSample();
  const motorFeedback = await ctx.motorNode.getLatestFeedback();
  const imuRaw = await ctx.imu.read();

  const gnssMeas = ctx.gnssAdapter.toMeasurement(gnssSample);
  const imuMeas = ctx.imuAdapter.toMeasurement(imuRaw, ctx.params.sensing);
  const wheelMeas = ctx.motorFeedbackAdapter.toMeasurement(
    motorFeedback,
    ctx.params.sensing
  );

  const estimatedState = ctx.poseEstimator.update({
    gnss: gnssMeas,
    imu: imuMeas,
    wheels: wheelMeas,
    params: ctx.params.estimation,
  });

  const guidance = ctx.lineTracker.compute({
    state: estimatedState,
    activeLine: ctx.mission.activeLine,
    params: ctx.params.guidance,
  });

  const wheelTargets = ctx.wheelCommandPlanner.plan({
    state: estimatedState,
    guidance,
    vehicleParams: ctx.params.vehicle,
  });

  const limitedTargets = ctx.commandLimiter.limit({
    requested: wheelTargets,
    state: estimatedState,
    vehicleParams: ctx.params.vehicle,
  });

  const wheelCommand: WheelCommand = {
    hostTimeUs: ctx.clock.nowUs(),
    sequence: ctx.sequencer.next(),
    enable: true,
    leftWheelTargetMps: limitedTargets.leftWheelTargetMps,
    rightWheelTargetMps: limitedTargets.rightWheelTargetMps,
    maxAccelMps2: ctx.params.vehicle.maxWheelAccelMps2,
    maxDecelMps2: ctx.params.vehicle.maxWheelDecelMps2,
    commandTimeoutMs: 250,
  };

  await ctx.motorNode.sendWheelCommand(wheelCommand);

  ctx.telemetry.log({
    gnssSample,
    motorFeedback,
    gnssMeas,
    imuMeas,
    wheelMeas,
    estimatedState,
    guidance,
    wheelTargets: limitedTargets,
    wheelCommand,
  });

  ctx.safetyManager.evaluate({
    estimatedState,
    gnssSample,
    motorFeedback,
  });
}
```

---

# 10. Control split between Pi and Motor ESP

This matters enough to state explicitly.

## On the Pi

Own:

* line tracking
* steering demand generation
* slope compensation
* trim compensation
* conversion to left/right wheel targets

## On the Motor ESP

Own:

* wheel speed execution
* PWM updates
* encoder-based speed tracking
* ramps and reversals
* command timeout stop
* low-level electrical fault handling

This keeps the Pi out of hard real-time work while preserving clean high-level control.

---

# 11. Self-calibration design

## 11.1 Two calibration domains

You should split calibration into two domains.

### A. Motor-node calibration

Calibrates the Motor ESP as a wheel-speed executor.

Examples:

* deadband
* wheel-speed tracking symmetry
* ramp smoothness
* reversal handling

This can be done partly on the motor ESP, partly from Pi-run tests.

### B. Vehicle navigation calibration

Calibrates:

* GNSS trust behaviour
* heading trust behaviour
* steering trim
* slope compensation
* line-following strengths

This belongs on the Pi.

Do not try to tune both domains as one big undifferentiated process.

---

## 11.2 Calibration supervisor stages

### Stage 1: static sensing calibration

Mower stationary.

Estimate:

* gyro bias
* roll offset
* sensor noise floors

### Stage 2: wheel execution validation

Command simple wheel targets.

Verify:

* left and right wheel speeds track correctly
* no gross asymmetry or deadband surprises

### Stage 3: straight-line trim calibration

Drive repeated straight runs.

Estimate:

* steering trim
* average signed path bias

### Stage 4: turn response calibration

Run controlled arcs or spins.

Estimate:

* yaw response gain
* turn lag
* heading response quality

### Stage 5: slope calibration

Traverse side slope.

Estimate:

* roll-to-steering compensation

### Stage 6: line-following refinement

Run repeated straight-line tests.

Adjust:

* cross-track strength
* heading strength
* yaw damping

using a bounded score-based improvement loop.

---

# 12. How each subsystem is adjusted

## 12.1 GNSS trust adjustment

Owned by estimator.

Method:

* compare predicted state vs GNSS updates
* measure innovation size
* increase assumed GNSS uncertainty when large, persistent mismatch appears
* reduce trust when RTK mode degrades

Test:

* simulated GNSS dropout and return
* fixed vs float replay data
* no wild jumps on degraded GNSS

---

## 12.2 Encoder trust / slip adjustment

Owned by estimator.

Method:

* compare wheel-derived motion against GNSS and IMU
* if wheel motion says “moving/turning” but other sensors disagree, penalize encoder trust

Test:

* replay logs with deliberate slip
* confirm `slipSuspected` becomes true in the right scenarios

---

## 12.3 Steering trim

Owned by vehicle compensation.

Method:

* repeated straight runs on flat ground
* calculate mean signed cross-track error
* adjust trim slightly opposite to the persistent bias

Test:

* mean signed cross-track error trends toward zero

---

## 12.4 Slope compensation

Owned by vehicle compensation.

Method:

* correlate roll angle with required steering correction
* fit a slope gain

Test:

* side-slope drift reduced on subsequent runs

---

## 12.5 Line-following strengths

Owned by guidance.

Parameters:

* cross-track strength
* heading strength
* yaw damping strength

Method:

* run same straight-line test
* score:

  * RMS cross-track error
  * final offset
  * oscillation
  * steering effort
* make small bounded adjustments
* keep only improvements

Test:

* lower score without introducing oscillation or excessive control effort

---

# 13. Testing strategy

## 13.1 Unit tests

For pure functions.

Test:

* line geometry
* signed cross-track error
* angle wrapping
* command limiting
* frame encode/decode
* parameter validation

These should be fast and numerous.

---

## 13.2 Integration tests

Test module boundaries.

Examples:

* GNSS sample → estimator measurement
* estimator → guidance
* guidance → wheel planner
* wheel planner → motor command

Mock the node clients.

---

## 13.3 Replay tests

Essential.

Feed recorded logs through:

* estimator
* guidance
* calibration metric computation

This lets you improve algorithms without going outside every time.

Build this early.

---

## 13.4 Simulation tests

Use a simple kinematic or first-order dynamic mower model.

Include:

* GNSS noise
* changing RTK quality
* slip events
* slope-induced drift
* motor asymmetry

This does not need to be fancy.

---

## 13.5 Field tests

Use staged scenarios:

* flat line
* side slope
* low speed
* medium speed
* RTK degrade/recover
* wet/slippery patch

Log everything.

---

# 14. Safety rules

Minimum rules:

* stop if motor feedback goes stale
* stop if GNSS and IMU data both go stale
* stop if motor node reports fault
* slow down when localization becomes degraded
* stop if localization becomes poor for too long
* stop if command sequence/watchdog fails
* stop if wheel targets saturate persistently but path error keeps increasing

The motor ESP should also independently stop if host commands stop arriving.

---

# 15. Recommended protocol design rules

Even over I²C, design as though this were a real field bus.

Every message should have:

* protocol version
* message type
* source ID
* sequence
* timestamp
* payload length
* CRC

And every client should check:

* stale data
* missed sequence jumps
* invalid CRC
* impossible values
* heartbeat timeout

That way you can move from I²C to CAN later with minimal software redesign.

---

# 16. Suggested interfaces Codex should implement first

## Bus-facing clients

* `GnssNodeClient`
* `MotorNodeClient`

## Core runtime modules

* `PoseEstimator`
* `LineTracker`
* `VehicleCompensation`
* `WheelCommandPlanner`
* `SafetyManager`
* `TelemetryLogger`

## Calibration modules

* `CalibrationSupervisor`
* `CalibrationMetrics`
* `ParameterFitter`
* `ParameterValidator`

## Core shared types

* `GnssNodeSample`
* `MotorNodeFeedback`
* `GnssMeasurement`
* `ImuMeasurement`
* `WheelMeasurement`
* `EstimatedState`
* `GuidanceCommand`
* `WheelTargets`
* `WheelCommand`
* `SystemParameters`

---

# 17. What Codex should avoid

* do not couple guidance directly to node protocols
* do not let estimator logic depend on I²C details
* do not bury safety checks inside random modules
* do not make the Motor ESP interpret vague steering intent
* do not hide uncertainty from upper layers
* do not store learned parameters as scattered constants
* do not bypass the runtime stack in calibration mode

---

# 18. Build order

Recommended order:

## Phase 1

* shared types
* bus adapter
* GNSS node client
* motor node client
* telemetry logger

## Phase 2

* sensing adapters
* simple estimator
* line geometry
* simple line tracker

## Phase 3

* vehicle compensation
* wheel command planner
* safety manager
* end-to-end runtime loop

## Phase 4

* replay tooling
* adaptive trust
* slip detector
* calibration metrics

## Phase 5

* calibration supervisor
* parameter fitting
* validation
* staged field testing

---

# 19. Best short summary

For your setup, the clean architecture is:

* **Pi in TypeScript:** estimation, guidance, compensation, calibration, logging, safety
* **GNSS ESP:** UM982/RTK decoding and publishing clean GNSS state
* **Motor ESP:** wheel execution and low-level motor safety
* **Pi sends wheel speed targets**
* **ESPs send typed status and feedback**
* **all learning and path intelligence lives on the Pi**
* **all timing-critical motor actuation stays on the motor ESP**

If you want the next step, I can turn this into a **Codex-ready implementation brief** with concrete TypeScript interfaces, class skeletons, and an ordered task list for generating the codebase.
