# To investigate — motors slamming to a dead stop and restarting

Symptom: during manual drive (and during test suites that run a sequence of
drives), the motors are observed to come to a hard stop and then resume.
Manual driving feels jerky. Expected behaviour is that motor stops are always
ramped by the ESP32 unless the `enableDrive` flag is explicitly cleared, which
should only happen for full shutdown / safety faults.

## How the ESP32 decides to slam

Firmware: [external-hardware/esp32/motor-controller-v2/motor-controller-v2.ino:548-561](external-hardware/esp32/motor-controller-v2/motor-controller-v2.ino#L548-L561)

```
bool commandFresh = ... (nowMillis - g_lastAcceptedCommandMillis) <= g_latestCommand.commandTimeoutMillis;
bool allowDrive = commandFresh && g_latestCommand.enableDrive;

if (!allowDrive) {
  forceMotorStop(g_leftMotor);   // zero PWM, zero direction sign — no ramp
  forceMotorStop(g_rightMotor);
  ...
}
```

So the firmware only slams when:

1. `enableDrive == false` in the latest accepted command, OR
2. The i2c command watchdog has expired (default 300ms — see
   [src/motors/motorNodeClient.ts:52](src/motors/motorNodeClient.ts#L52); ESP32
   `DEFAULT_TIMEOUT_MS = 250`).

Anything else is ramped via `stepMotorTowardRequested()` using the persisted
ramp-up/ramp-down calibration. So the slam-then-restart pattern must be one of
these two paths.

## Suspect 1 — `endMotorOperation()` always sends `enableDrive=false`

[src/sensing/sensorController.ts:1204-1234](src/sensing/sensorController.ts#L1204-L1234)
`sendDisableMotorsCommand()` calls `gateway.stopMotors()`, which calls
[src/motors/motorNodeClient.ts:75-85](src/motors/motorNodeClient.ts#L75-L85)
`stop()` — and that command sets `enableDrive: false`. That hits the firmware's
`forceMotorStop()` path immediately on receipt, no ramp.

It is invoked whenever `motorOperationDepth` drops to zero. Two places this
fires repeatedly inside what the operator perceives as a single session:

- **Segment test runner** opens a motor op around waypoint collection
  ([src/control/segmentTestRunner.ts:154](src/control/segmentTestRunner.ts#L154)),
  closes it before the home/random drives
  ([src/control/segmentTestRunner.ts:213](src/control/segmentTestRunner.ts#L213)) —
  → slam between phases.
- Each `runSegmentTest` then calls `driveController.executeDrive()`, which
  inside `driveLineController` runs its own `beginMotorOperation` /
  `endMotorOperation` pair (open at
  [src/control/driveLineController.ts:180](src/control/driveLineController.ts#L180),
  close at lines
  [1162](src/control/driveLineController.ts#L1162),
  [1185](src/control/driveLineController.ts#L1185),
  [1223](src/control/driveLineController.ts#L1223)).
  Depth goes 0→1→0 around every single segment drive — slam between every
  segment.

The same shape in `disableManualDrive()`
([src/control/manualDriveCoordinator.ts:258-273](src/control/manualDriveCoordinator.ts#L258-L273)):
gentle `stopMotors()` first, then immediately `endMotorOperation()` which
slams. For disarm this is a single event rather than a repeating jerk pattern,
but it is still a hard stop where a ramp would be cleaner.

## Suspect 2 — i2c command watchdog expiring mid-drive

The Pi's 200Hz sensor loop
([src/sensing/sensorController.ts:669-706](src/sensing/sensorController.ts#L669-L706))
is the only thing keeping the ESP32 watchdog fed once the manual drive
coordinator goes quiet (the manual loop only re-sends on stick changes or its
150ms refresh — see `MANUAL_DRIVE_COMMAND_REFRESH_INTERVAL_MS`).

Each loop iteration runs serially through the single i2c bus controller:

1. IMU read (up to 3 attempts × 20ms retry delay —
   [src/imu/bmi160ImuSensor.ts](src/imu/bmi160ImuSensor.ts))
2. GNSS read (3 attempts × 20ms retry — see `GNSS_DEFAULT_MAX_ATTEMPTS`,
   `GNSS_RETRY_DELAY_MS` in [src/constants.ts](src/constants.ts))
3. Motor feedback read (3 attempts × 20ms retry —
   [src/motors/motorNodeClient.ts:52-54](src/motors/motorNodeClient.ts#L52-L54))
4. Motor command write (`replayLastMotorCommand` —
   [src/sensing/sensorController.ts:1279-1301](src/sensing/sensorController.ts#L1279-L1301))

If any single read consumes its full retry budget (~60ms each), the cycle can
blow past 300ms. The ESP32 watchdog fires, `forceMotorStop()` slams both
wheels, and the next successful cycle re-issues the wheel command and the
motors resume — exactly the "dead stop and then restart" pattern reported.

Notably the keep-alive (`replayLastMotorCommand`) is the **last** step of the
loop — so a stalled read also stalls the keep-alive.

## IMU re-biasing — ruled out

`maybeAutoRecalibrateImuYawBias()`
([src/sensing/sensorController.ts:708-738](src/sensing/sensorController.ts#L708-L738))
fires after 2s of stationary stop (`IMU_BIAS_AUTO_RECALIBRATION_SETTLE_MS =
2000`), but it only updates `imuYawRateBiasDegPerSec`. It never sends a motor
command, so it cannot cause a slam.

## Suggested next steps

1. **Stop sending `enableDrive=false` between intra-session operations.** The
   cleanest fix is for `endMotorOperation()` to send a gentle (0,0) with
   `enableDrive=true` and reserve `enableDrive=false` for full shutdown,
   `systemStop`, and hard-fault paths. The ESP32 will ramp down naturally and a
   subsequent `beginMotorOperation` doesn't need to re-enable anything because
   `enableDrive` was never cleared.
2. **Confirm watchdog timing.** Add temporary logging on `watchdogHealthy`
   transitions in `pollMotors` and on loop-duration spikes in the sensor loop.
   A jerky drive should show `watchdogHealthy` flipping false and
   `lastLoopDurationMs` approaching or exceeding 300ms. If confirmed, raise
   `commandTimeoutMillis` (motorNodeClient) and/or `DEFAULT_TIMEOUT_MS` (ESP32)
   to e.g. 600ms.
3. **Decouple keep-alive from sensor reads.** Send the motor command at the
   start of each loop iteration, or on its own cadence, so a stalled read can't
   stall the watchdog feed.
