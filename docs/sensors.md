# Sensors API

This document defines the current sensor boundary and the payload contracts used by the mower runtime.

## Overview

The application has one sensor polling owner:

- `SensorController` (`src/sensing/sensorController.ts`)

Hardware access is isolated behind:

- `SensorHardwareGateway` (`src/sensing/sensorHardwareGateway.ts`)

This keeps application logic independent from device/protocol details.

## Polling Model

- Poll loop target: ~200Hz (`5ms` default)
- Poll order in each loop:
  1. IMU
  2. GNSS
  3. Motors
- Latest successful value is retained per sensor.
- On sensor error, last good values are preserved and error state is updated.

## Application-Facing API

### IMU heading API

The controller exposes a heading-focused API:

- `getHeadingDegrees(): number`
- `setHeadingDegrees(headingDegrees: number): void`

`setHeadingDegrees(...)` resets the integrated IMU heading baseline to an absolute value (for example from GNSS), then integration continues from the new baseline. GNSS heading rebases supply the controller-clock reset timestamp, and direct heading resets fall back to the current controller clock, so the next IMU sample does not skip or double-count a turn interval.

For rough yaw-scale checks without a turn rig, the interactive utility `external-hardware/manual-tests/imu_gnss_turn_calibration.js` can log paired IMU and GNSS headings at `S`/`E` points while applying a local per-run IMU offset so the session starts aligned to the current GNSS heading. When you finish runs it exports the averaged yaw scale factor to `config/imu-yaw-calibration.json`, which `SensorController` loads at startup and applies to the integrated gyro heading.

### Primitive snapshot API

The web/API primitives payload contains separate domains:

- `imu`
- `gnss`
- `motors`

Current sensor-related shape:

```json
{
  "sampledAt": "2026-05-17T16:00:00.000Z",
  "sensorController": {
    "status": "running",
    "pollIntervalMs": 33,
    "lastLoopDurationMs": 3
  },
  "imu": {
    "status": "running",
    "error": null,
    "headingDeg": 42.1,
    "pitchDeg": 2.3,
    "rollDeg": -1.5
  },
  "gnss": {
    "status": "running",
    "error": null,
    "xMeters": 12.345,
    "yMeters": -1.234,
    "headingDeg": 88.7,
    "positionAccuracyMeters": 0.024,
    "headingAccuracyDeg": 0.6,
    "fixType": "fixed",
    "satellitesInUse": 22,
    "sampleAgeMillis": 110
  },
  "poseFusion": {
    "status": "ok",
    "error": null,
    "xMeters": 12.345,
    "yMeters": -1.234,
    "headingDeg": 42.1,
    "quality": "gnss",
    "speedMetersPerSecond": null,
    "usingGnssHeading": true
  },
  "motors": {
    "status": "idle",
    "error": null,
    "commandedLeftWheelOutputPercent": null,
    "commandedRightWheelOutputPercent": null,
    "leftWheelSpeedMetersPerSecond": null,
    "rightWheelSpeedMetersPerSecond": null,
    "leftRpm": null,
    "rightRpm": null,
    "leftEncoderDelta": null,
    "rightEncoderDelta": null,
    "leftPwmAppliedPercent": null,
    "rightPwmAppliedPercent": null,
    "leftMotorCurrentAmps": null,
    "rightMotorCurrentAmps": null,
    "watchdogHealthy": null,
    "faultFlags": null
  }
}
```

The `poseFusion.usingGnssHeading` flag is the app-level indicator the live widgets use for the green/orange sync background. The browser does not compare headings itself.

### Motor command API

The controller exposes motor command methods:

- `setMotorWheelOutputs(leftWheelOutputPercent, rightWheelOutputPercent)` to update the latest controller-level motion request
- `stopMotors()` for a normal ramp-down stop
- `haltMotors()` for an immediate hard disable

`stopMotors()` maps to a dedicated stop command with higher I2C priority than normal output commands, while `haltMotors()` maps to the emergency disable path.
The latest requested wheel pair is sent through the normal I2C queue only when it changes. The ESP32 motor node latches the most recent accepted command until some newer command replaces it.
Every normal wheel-output write also carries the current global stop latch in the motor payload `enableDrive` flag. That means a user stop immediately changes the payload shape for subsequent motor writes, so the next write is forced out with drive disabled even if the wheel targets themselves did not change.
The stationary pose-fusion timer is armed by an explicit zero-output command or a user/abort stop path, so a mower that has been stopped by the controller can still qualify for a GNSS heading rebase after the timeout.
Motor output commands at or below 10% magnitude are treated as zero before transmission, which gives the controller a little tolerance around the joystick center and helps stationary detection settle cleanly.
Non-zero motor output commands are raised to at least 30% magnitude before transmission. A one-wheel motion command is converted into a minimum active arc command so the hardware is not asked to move with only one active motor.
The stationary timer uses the controller clock rather than the GNSS sample timestamp, so a stale GNSS receiver time cannot suppress the stop timeout.
The motor node command payload sent over I2C uses normalized percentages, where `1.0` is full output and `0.0` is stop.
IMU yaw-bias auto-recalibration is an idle-only maintenance action. It is suppressed while any motion session is active and only re-arms after the mower has been idle for about 30 minutes, so active tuning and test runs do not get their heading baseline nudged mid-session.

### Obstruction detection

The sensor controller raises a stall obstruction when:

- one or both wheels are commanded hard but the mower does not make progress over the observation window

That keeps normal steering corrections available while still catching a mower that is slipping or stuck and no longer advancing on GNSS even though motion is still being commanded.

## Heading Convention

Internal heading convention for both IMU and GNSS:

- `0°` points along `+X`
- positive rotation is counterclockwise toward `+Y`
- normalized to signed range `(-180, 180]`

GNSS heading from field/navigation convention (`0° = north`, clockwise positive) is rotated before exposure:

- `internalHeading = normalize(90 - fieldHeading)`

## IMU Integration Details

### Data Sources

The IMU sensor provides:

- **BMI160 gyroscope**: 3-axis angular velocity (`xDegreesPerSecond`, `yDegreesPerSecond`, `zDegreesPerSecond`)
- **BMI160 accelerometer**: 3-axis acceleration (X, Y, Z in m/s²) for pitch and roll calculation

The BMI160 gyro is configured for the `2000 dps` range, which corresponds to `16.4 LSB/dps` in this runtime.

### Heading Integration

- `heading += tiltCompensatedYawRateDegPerSec * deltaSeconds`
- the controller projects the 3-axis gyro vector onto the current gravity axis derived from pitch and roll before integrating yaw
- first sample sets timestamp reference only
- subsequent samples integrate using sample-to-sample timestamp delta
- heading always normalized to `(-180, 180]`

`SensorController` also keeps a short in-memory IMU diagnostic window so the runtime can emit one compact turn summary when pose fusion rebases GNSS heading. That gives us the raw sample interval and integrated yaw evidence without writing a log line for every 200Hz sample.
When a non-zero motor command transitions to a stop command, the controller snapshots that same window as `sensor.imu.motion_stop_summary`. Pose fusion prefers this stop-time summary when it later logs a GNSS heading rebase, because the actual turn may be several seconds behind the stationary rebase.

GNSS heading rebases are only allowed when the motor command is stopped and the latest tilt-compensated yaw rate is within 1 deg/s. During active turns the GNSS heading can still be observed for quality and position updates, but it does not write back into the IMU heading baseline.

### Pitch and Roll Calculation

Pitch and roll are derived from accelerometer readings using the gravity vector:

- **Pitch** (rotation around Y-axis, tilt front-to-back):
  - `pitch = atan2(-ax, sqrt(ay² + az²)) * 180/π`
  - Positive pitch = nose up, negative pitch = nose down
  
- **Roll** (rotation around X-axis, tilt side-to-side):
  - `roll = atan2(ay, az) * 180/π`
  - Positive roll = right side down, negative roll = left side down

### Calibration and Zeroing

At startup, the IMU performs calibration by sampling sensor noise:

1. **Gyroscope bias calibration**: Averages all three gyro axes over the default 240 stationary samples to determine drift offsets
2. **Pitch/roll zeroing**: Averages pitch and roll calculations over the same stationary sample window to establish level reference
3. All subsequent readings subtract these calibrated offsets

This allows the mower to zero its tilt reference on uneven ground during startup.

## GNSS I2C/Protocol

### Addressing and transport

- Shared Pi I2C bus: `MOWER_I2C_BUS_NUMBER` (default `1`)
- GNSS node I2C address: `MOWER_GNSS_I2C_ADDRESS` (default `0x52`)

### Framed request/response

Request/response uses framed messages:

- Start-of-frame: `0x4d`
- Header bytes:
  - `version`
  - `nodeId`
  - `messageType`
  - `flags`
  - `sequence` (`uint16`, little-endian)
  - `payloadLength` (`uint16`, little-endian)
- Payload bytes
- CRC16-CCITT (`uint16`, little-endian) over header+payload excluding start byte

GNSS sample request:

- `nodeId = 0x10`
- `messageType = 0x01`
- empty payload

GNSS low-satellite debug request:

- `nodeId = 0x10`
- `messageType = 0x02`
- empty payload

When the receiver reports fewer than the trusted satellite threshold, the ESP32
retains the latest raw `PVTSLNA` text payload after the semicolon and exposes
it through this debug frame so the Pi can write it into the normal session log.
That keeps the forensic text available over SSH without needing a USB serial
console on the machine.

### GNSS payload variants

The runtime currently supports the compact `40` byte GNSS sample layout from
node firmware.

### `GnssSample` fields and meaning

- `timestampMillis`: sample timestamp reported by node
- `xMeters`: planar X in meters
- `yMeters`: planar Y in meters
- `headingDegrees` (optional): field/navigation heading before rotation
- `pitchDegrees` (optional): pitch estimate from node
- `groundSpeedMetersPerSecond` (optional): speed estimate
- `positionAccuracyMeters`: horizontal position accuracy estimate
- `headingAccuracyDegrees` (optional): heading accuracy estimate
- `fixType`: one of `none | single | float | fixed`
- `satellitesInUse`: satellites used in the current solution
- `sampleAgeMillis`: node-reported age of GNSS sample
- `debug` (optional):
  - `receiverLineAgeMillis`
  - `pvtslnaAgeMillis`
  - `uniheadingAgeMillis`
  - `rtcmAgeMillis`
  - `logConfigMask`

### Vehicle geometry correction

The runtime treats the GNSS sample position as a fixed receiver reference point and then translates that point into the mower control point using a calibrated body-frame offset:

- `positionOffsetForwardMeters`: distance from the raw GNSS reference point toward the mower nose
- `positionOffsetRightMeters`: distance from the raw GNSS reference point toward the mower's right-hand side

That offset is applied before the position is exposed through `SensorController`, `PoseFusion`, and the primitive snapshot. The manual calibration utility `external-hardware/manual-tests/rotation_center_calibration.js` estimates the offset by slowly spinning the mower through at least one full rotation and fitting the observed GNSS trace to a circle.
For quick field tuning, `config/geometry-calibration.json` is the live persisted value the runtime loads at startup, so small manual nudges to `positionOffsetForwardMeters` and `positionOffsetRightMeters` will immediately affect the mower reference point on the next restart.

## Error Handling

- GNSS read path retries short transient failures (`maxAttempts`, short delay).
- Frame decode rejects invalid SOF, short frame, bad CRC, and unexpected node/message types.
- Sensor controller updates `gnss.status = "error"` with message and keeps previous numeric values for visibility.

## Motor I2C/Protocol

### Addressing and transport

- Motor node I2C address: `MOWER_MOTOR_I2C_ADDRESS` (default `0x66`)
- Motor direction signs:
  - `MOWER_LEFT_MOTOR_FORWARD_SIGN` (default `-1`)
  - `MOWER_RIGHT_MOTOR_FORWARD_SIGN` (default `-1`)

Runtime convention is application-facing forward-positive normalized wheel output (`-1..1`, where `1` is full forward output). Direction-sign inversion is applied in the motor hardware gateway when converting:
- app command -> raw motor command
- raw motor feedback -> app-facing feedback

### Framed messages

The same common frame contract is used.

Motor message types:

- `0x21`: wheel output command
- `0x22`: motor feedback sample

### Wheel output command payload (`15` bytes)

- `timestampMillis` (`uint32`)
- `leftWheelTargetPercent` (`int16`, scale `1/1000`)
- `rightWheelTargetPercent` (`int16`, scale `1/1000`)
- `enableDrive` (`uint8`, `1` enabled / `0` stop)
- `commandTimeoutMillis` (`uint16`)
- `maxAccelerationPercentPerSecond` (`uint16`, optional, `0xffff` sentinel, scale `1/1000`)
- `maxDecelerationPercentPerSecond` (`uint16`, optional, `0xffff` sentinel, scale `1/1000`)

### Motor feedback payload (`22` bytes)

- `timestampMillis` (`uint32`)
- `leftEncoderDelta` (`int32`)
- `rightEncoderDelta` (`int32`)
- `leftPwmAppliedPercent` (`int8`)
- `rightPwmAppliedPercent` (`int8`)
- `leftMotorCurrentAmps` (optional `uint16`, `0xffff` sentinel, scale `1/10`)
- `rightMotorCurrentAmps` (optional `uint16`, `0xffff` sentinel, scale `1/10`)
- `watchdogHealthy` (`uint8`)
- `faultFlags` (`uint16`)

The ESP32 motor node now sends raw encoder deltas only. The Pi-side sensor controller converts those deltas into wheel speed estimates using the persisted encoder calibration in `config/pose-calibration.json`.

For control/odometry purposes the most important motor feedback value is encoder delta per sample (`leftEncoderDelta`, `rightEncoderDelta`), which is intended to be integrated over time.

### Motor queue priorities

- Stop command priority: `1` (`I2C_PRIORITY.stop`)
- Normal motor speed commands priority: `2` (`I2C_PRIORITY.motorSpeed`)
- Motor feedback read priority: `2`

This ensures queued stop commands are sent ahead of other queued traffic.

## Game Controller Interface

The runtime supports a HID game controller interface for manual drive.

Default controller signs in this runtime:
- `MOWER_CONTROLLER_STEERING_SIGN=-1`
- `MOWER_CONTROLLER_SPEED_SIGN=1`

### Manual drive arm/disarm

- `right-top` button: arm manual drive
- `left-top` button: disarm manual drive and issue motor stop

### Joystick mapping

The mapping follows the previous working model:

- Steering byte: `data[3]` to angle in `[-90, 90]` degrees
- Speed byte: `data[4]` to speed demand in `[-1, 1]`
- Speed deadband near center: magnitude under `0.02` is treated as `0`

Manual demand shaping then converts speed + turn demand into wheel targets (straight/arc/spin modes) and sends those targets through the normal motor command path.
Manual wheel outputs are quantized into small 2% steps before comparison so tiny held-stick jitter is coalesced instead of creating unnecessary I2C writes.

Path and perimeter recording consumes fused poses, but it only writes GNSS-quality poses and skips implausible jumps between consecutive recorded points. This prevents degraded GNSS or dead-reckoning drift from being persisted as long spikes in saved boundaries.

### Motion path

Manual-drive commands are not applied directly to PWM. They flow through the same wheel-speed command primitive used by the rest of the app, so the motor node's ramping and latched-command behavior still apply.

If controller connection drops while manual drive is armed, the runtime disarms manual mode and issues a stop command.
