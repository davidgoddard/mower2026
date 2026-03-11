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
- FG pulse counting
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
- pulse counting
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
6. sample FG feedback pulses
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

- open-loop PWM execution with FG pulse reporting

But this should be treated as an intermediate step, not the final interface.

## Required internal measurements

The motor ESP should internally maintain:

- accumulated FG pulse counts per wheel
- FG pulse delta counts per reporting interval
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

For the current FG-based hardware, the left/right encoder fault bits should also be used when:

- a wheel is commanded to move but no FG activity is observed, or
- meaningful FG activity is observed while the wheel is idle / not allowed to drive

## Motor feedback electrical reality

The current brushless motors appear to expose an `FG` speed output rather than a quadrature encoder.

Known characteristics from the motor documentation:

- yellow wire = `FG`
- output type = open-collector `NPN`
- pulse rate = `12 pulses / round`

This has three important consequences:

- the ESP input must have a valid pull-up
- the signal should be interpreted as speed pulses, not full phase encoder data
- wheel-speed scaling must include the motor-to-wheel gear ratio

Recommended wiring guidance:

- share ground between motor and ESP
- connect the yellow `FG` line to an ESP GPIO input
- pull that line up to `3.3 V`
- prefer an external pull-up resistor in the `4.7k-10k` range for field use

Current board-level pin mapping and the ESP32-WROOM-32 pin reference image are documented in `external-hardware/esp32/motor-controller-v2/README.md`.

Do not pull the `FG` line directly to `5 V` into an ESP32 GPIO.

The ESP32 internal `INPUT_PULLUP` may be acceptable for bench testing, but an external pull-up is the safer design assumption for the mower.

## Wheel-speed scaling note

Current motor feedback should be treated as FG pulse feedback rather than conventional encoder counts.

If the `12 pulses / round` value is correct and refers to motor revolution, then:

- `motorRevsPerSecond = fgPulsesPerSecond / 12`
- `wheelRevsPerSecond = motorRevsPerSecond / gearRatio`
- `wheelSpeedMetersPerSecond = wheelRevsPerSecond * wheelCircumference`

Until the gear ratio is confirmed, absolute wheel-speed scaling should be treated as provisional.

## Command timeout rule

If no valid command is received within `commandTimeoutMillis`:

- requested wheel speeds shall be treated as zero
- outputs shall ramp down safely
- watchdog fault shall be set

When watchdog is unhealthy or drive is disabled, the firmware should not try to "correct" spurious FG activity with compensating PWM. Zero command should remain zero command.

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

## Remaining hardware-dependent decisions

The remaining motor hardware decisions and final firmware data gaps are tracked centrally in [requirements-traceability.md](requirements-traceability.md).

## Recommended next implementation step

When the motor ESP rewrite starts:

1. keep the low-level pin and ramping structure from the legacy design where still valid
2. replace the command interface with explicit wheel-speed targets
3. add real feedback publication at a fixed rate
4. validate FG pull-up wiring, noise immunity, and scaling
5. only then tune local wheel-speed control
