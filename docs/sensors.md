# Sensors API

This document defines the current sensor boundary and the payload contracts used by the mower runtime.

## Overview

The application has one sensor polling owner:

- `SensorController` (`src/sensing/sensorController.ts`)

Hardware access is isolated behind:

- `SensorHardwareGateway` (`src/sensing/sensorHardwareGateway.ts`)

This keeps application logic independent from device/protocol details.

## Polling Model

- Poll loop target: ~30Hz (`33ms` default)
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

`setHeadingDegrees(...)` resets the integrated IMU heading baseline to an absolute value (for example from GNSS), then integration continues from the new baseline.

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
    "headingDeg": 42.1
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
  "motors": {
    "status": "idle",
    "error": null,
    "commandedLeftWheelSpeedMetersPerSecond": null,
    "commandedRightWheelSpeedMetersPerSecond": null,
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

### Motor command API

The controller exposes motor command methods:

- `setMotorWheelSpeeds(leftWheelTargetMetersPerSecond, rightWheelTargetMetersPerSecond)`
- `stopMotors()`

`stopMotors()` maps to a dedicated stop command with higher I2C priority than normal speed commands.

## Heading Convention

Internal heading convention for both IMU and GNSS:

- `0°` points along `+X`
- positive rotation is counterclockwise toward `+Y`
- normalized to signed range `(-180, 180]`

GNSS heading from field/navigation convention (`0° = north`, clockwise positive) is rotated before exposure:

- `internalHeading = normalize(90 - fieldHeading)`

## IMU Integration Details

Source:

- BMI160 gyro Z angular velocity (`zDegreesPerSecond`)

Integration:

- `heading += yawRateDegPerSec * deltaSeconds`
- first sample sets timestamp reference only
- subsequent samples integrate using sample-to-sample timestamp delta
- heading always normalized to `(-180, 180]`

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

### GNSS payload variants

The runtime currently supports two GNSS payload layouts from node firmware:

- `36` bytes
- `38` bytes

Both decode to the same application `GnssSample` shape.

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

Runtime convention is application-facing forward-positive wheel speeds. Direction-sign inversion is applied in the motor hardware gateway when converting:
- app command -> raw motor command
- raw motor feedback -> app-facing feedback

### Framed messages

The same common frame contract is used.

Motor message types:

- `0x21`: wheel speed command
- `0x22`: motor feedback sample

### Wheel speed command payload (`15` bytes)

- `timestampMillis` (`uint32`)
- `leftWheelTargetMetersPerSecond` (`int16`, scale `1/1000`)
- `rightWheelTargetMetersPerSecond` (`int16`, scale `1/1000`)
- `enableDrive` (`uint8`, `1` enabled / `0` stop)
- `commandTimeoutMillis` (`uint16`)
- `maxAccelerationMetersPerSecondSquared` (`uint16`, optional, `0xffff` sentinel, scale `1/1000`)
- `maxDecelerationMetersPerSecondSquared` (`uint16`, optional, `0xffff` sentinel, scale `1/1000`)

### Motor feedback payload (`26` bytes)

- `timestampMillis` (`uint32`)
- `leftWheelActualMetersPerSecond` (`int16`, scale `1/1000`)
- `rightWheelActualMetersPerSecond` (`int16`, scale `1/1000`)
- `leftEncoderDelta` (`int32`)
- `rightEncoderDelta` (`int32`)
- `leftPwmApplied` (`int8`)
- `rightPwmApplied` (`int8`)
- `leftMotorCurrentAmps` (optional `uint16`, `0xffff` sentinel, scale `1/10`)
- `rightMotorCurrentAmps` (optional `uint16`, `0xffff` sentinel, scale `1/10`)
- `watchdogHealthy` (`uint8`)
- `faultFlags` (`uint16`)

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

### Motion path

Manual-drive commands are not applied directly to PWM. They flow through the same wheel-speed command primitive used by the rest of the app, so the motor node's ramp and watchdog behavior still apply.

If controller connection drops while manual drive is armed, the runtime disarms manual mode and issues a stop command.
