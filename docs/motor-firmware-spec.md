# Motor ESP Firmware Specification

## Purpose

This document defines the second-generation motor ESP responsibilities, control boundary, and Pi-facing feedback contract.

It is derived from:

- the legacy motor firmware in `/Volumes/mower/legacy/mower/arduino/motor-controller-basic/motor-controller-basic.ino`
- the legacy note in `/Volumes/mower/legacy/mower/documentation/Refactored Motor Driver for Rover Navi.md`
- the current second-generation architecture in `docs/overview.md`

## Key change from the legacy design

The legacy motor ESP accepted abstract motion intent:

- mode
- normalized speed
- normalized turn

and internally decided how to convert that into left/right wheel behavior.

That boundary is no longer acceptable for the new architecture because it makes:

- calibration harder
- estimation less observable
- debugging more ambiguous
- slip and asymmetry diagnosis weaker

The new design shall make the Pi responsible for vehicle intent and the motor ESP responsible for wheel execution.

## Motor ESP responsibilities

The motor ESP shall own:

- PWM generation
- motor direction output
- wheel encoder counting
- wheel-speed execution
- acceleration and deceleration limiting
- safe reversal handling
- command timeout fail-safe
- low-level fault detection
- feedback publication to the Pi

The motor ESP shall not own:

- path tracking
- line following
- heading control policy
- turn geometry decisions
- mission logic
- calibration supervision

## Pi-to-motor command contract

The Pi shall send explicit wheel targets, not abstract steering commands.

Current compact payload:

- `leftWheelTargetMetersPerSecond`
- `rightWheelTargetMetersPerSecond`
- `enableDrive`
- `commandTimeoutMillis`
- optional acceleration and deceleration limits

See:

- `src/protocols/motorProtocol.ts`
- `src/protocols/motorCodec.ts`
- `docs/protocol.md`
- `docs/motor-firmware-migration.md`

## Required motor feedback contract

The motor ESP shall publish:

- `leftWheelActualMetersPerSecond`
- `rightWheelActualMetersPerSecond`
- `leftEncoderDelta`
- `rightEncoderDelta`
- `leftPwmApplied`
- `rightPwmApplied`
- `watchdogHealthy`
- `faultFlags`

If available, also publish:

- `leftMotorCurrentAmps`
- `rightMotorCurrentAmps`

## Legacy design summary

The legacy firmware:

- ran as I2C slave at address `0x66`
- accepted config via register `0x10`
- accepted motion commands via register `0x02`
- returned pulse deltas via register `0x01`
- translated Pi-provided arc/spin commands into PWM targets
- counted tach pulses but did not provide a closed-loop wheel-speed contract

Useful legacy features worth preserving:

- safe stop-before-reverse behavior
- configurable ramp-up and ramp-down
- direction inversion support
- encoder pulse counting
- watchdog-style command freshness logic

Features to retire:

- `MODE_ARC` / `MODE_SPIN` command boundary
- normalized “turn” command as the primary control interface
- Pi dependence on the ESP for steering semantics

## Recommended internal motor control model

The new motor ESP should use this layered design:

1. receive wheel-speed command from Pi
2. validate freshness and command enable state
3. convert wheel-speed targets into internal wheel controllers
4. enforce ramp and reversal safety
5. drive PWM and direction outputs
6. sample encoders
7. estimate actual wheel speed
8. publish feedback to Pi

## Wheel-speed controller recommendation

Preferred target design:

- local closed-loop speed control per wheel on the ESP

Reason:

- the ESP is closer to the hardware timing
- wheel-speed execution becomes more repeatable
- the Pi gets a cleaner actuator abstraction
- calibration and estimator logic can compare commanded vs actual wheel speed directly

Fallback design if needed during bring-up:

- open-loop PWM execution with encoder reporting

But this should be treated as an intermediate step, not the final interface.

## Required internal measurements

The motor ESP should internally maintain:

- accumulated encoder counts per wheel
- encoder delta counts per reporting interval
- estimated wheel speed in meters per second
- currently applied PWM output
- current direction state
- last valid command timestamp
- watchdog state
- low-level motor or driver fault flags

## Fault flag expectations

Use the shared motor fault bitfield defined in `src/protocols/faultFlags.ts`.

Current bits:

- bit 0: watchdog expired
- bit 1: left encoder fault
- bit 2: right encoder fault
- bit 3: left driver fault
- bit 4: right driver fault
- bit 5: over-current

## Command timeout rule

If no valid command is received within `commandTimeoutMillis`:

- requested wheel speeds shall be treated as zero
- outputs shall ramp down safely
- watchdog fault shall be set

The ESP must fail safe without requiring the Pi to explicitly send stop repeatedly.

## Reversal rule

When a wheel target changes sign:

- ramp that wheel toward zero first
- change direction only after speed has reached zero or a configured near-zero threshold
- then ramp toward the new target

This preserves the useful safety behavior from the legacy firmware.

## Ramp behavior guidance

Ramp-up and ramp-down should remain asymmetric.

Reason from the existing hardware:

- accelerating too hard causes a mechanical bang because the rotary cutter is spun up through gearing as the mower starts moving forward
- stopping can be much faster because an idler allows the cutter to free-spin while the drive wheels decelerate

Current practical guidance from legacy tuning:

- stop in roughly `300 ms`
- accelerate to strong drive over roughly `1000-1500 ms`

These values are still tuning parameters, but the asymmetry is a real hardware requirement rather than a stylistic choice.

## Reporting rate recommendation

Initial development targets:

- wheel execution control loop: `100 Hz` or higher
- feedback publication to Pi: `20 Hz`

These are starting targets and should be validated against encoder resolution, CPU headroom, and I2C occupancy.

For I2C specifically, Pi-side polling at `20 Hz` is acceptable. The firmware should keep a coherent latest feedback snapshot ready for each poll.

## Motor-to-Pi field mapping notes

### `leftWheelActualMetersPerSecond` / `rightWheelActualMetersPerSecond`

Should represent measured or estimated wheel speed after local execution, not merely copied command targets.

### `leftEncoderDelta` / `rightEncoderDelta`

Should be the count delta since the previous published feedback sample.

This is important because the Pi estimator expects interval-local odometry, not absolute counts disguised as deltas.

### `leftPwmApplied` / `rightPwmApplied`

Should represent the signed or direction-aware actuation level actually driven at the reporting instant.

### `watchdogHealthy`

Should be false whenever command freshness has expired or local execution is no longer trustworthy.

## Open hardware-dependent decisions

These block the final motor firmware implementation details:

- exact encoder type and counts per wheel revolution
- exact wheel circumference
- whether current sensing exists
- whether the PWM output should be represented as signed percent, raw duty step, or another unit in feedback
- the final wheel-speed controller structure and gains

## Recommended next implementation step

When the motor ESP rewrite starts:

1. keep the low-level pin and ramping structure from the legacy design where still valid
2. replace the command interface with explicit wheel-speed targets
3. add real feedback publication at a fixed rate
4. validate encoder count direction and scaling
5. only then tune local wheel-speed control
