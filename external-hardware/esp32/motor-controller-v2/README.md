# Motor Controller V2

## Purpose

This folder contains a self-contained ESP32 motor controller sketch for the second-generation mower protocol.

File:

- `motor-controller-v2.ino`

## What it does

- runs as I2C slave at address `0x66`
- accepts explicit left/right wheel-speed commands
- enforces watchdog timeout
- preserves asymmetric ramp-up / ramp-down behavior
- preserves stop-before-reverse behavior
- counts FG/tach pulses
- returns a coherent fixed-size feedback snapshot

## Important note

This firmware already uses the current wire protocol and feedback contract, but the wheel-speed execution is still intentionally simple:

- feed-forward plus proportional speed assist
- no hardware-tuned closed-loop controller yet

That is good enough for manual bring-up and feedback validation, but not yet final precision control.

## Pin assumptions

Inherited from the legacy build:

- SDA `16`
- SCL `17`
- left PWM `5`
- left DIR `18`
- right PWM `14`
- right DIR `19`
- left tach `21`
- right tach `22`

## ESP32 wiring reference

The current motor controller sketch targets an ESP32-WROOM-32 dev board pinout.

![ESP32-WROOM-32 pin reference](../../../docs/images/esp32-wroom-d32.png)

Motor controller signal mapping for the current sketch:

| Function | GPIO | Note |
| --- | --- | --- |
| I2C SDA | `GPIO16` | Pi-to-motor command and feedback bus |
| I2C SCL | `GPIO17` | Pi-to-motor command and feedback bus |
| Left motor PWM | `GPIO5` | PWM-capable output |
| Left motor direction | `GPIO18` | Digital output |
| Right motor PWM | `GPIO14` | PWM-capable output |
| Right motor direction | `GPIO19` | Digital output |
| Left motor FG/tach | `GPIO21` | Input with `3.3 V` pull-up |
| Right motor FG/tach | `GPIO22` | Input with `3.3 V` pull-up |

Wiring constraints:

- common ground between the ESP32, motor driver, and motor feedback wiring is required
- the `FG` lines are treated as `3.3 V` logic inputs on the ESP32 side
- use an external `4.7k-10k` pull-up to `3.3 V` on each `FG` line for mower installation
- do not feed `5 V` directly into the ESP32 GPIO pins

## FG feedback note

The current motors appear to provide `FG` speed feedback rather than a full quadrature encoder.

Known characteristics from the motor documentation:

- yellow wire = `FG`
- output type = open-collector `NPN`
- pulse rate = `12 pulses / round`

That means:

- the ESP input needs a pull-up
- an external pull-up to `3.3 V` is preferred over relying only on the ESP32 internal pull-up
- direction is currently inferred from commanded motor direction, not measured from the feedback line itself

If the mower reports motion while motor power is off, inspect FG wiring and the pull-up arrangement first.

## Manual test support

Use the companion host-side script:

- `../manual-tests/motor_manual_test.js`
- `../manual-tests/motor_mode_test.js`
- `../manual-tests/motor_idle_noise_test.js`

That script is intended to run on the Pi and exercise:

- spin one way
- spin the other way
- forward
- backward
- direction swaps
- gentle arcs

The idle/noise script is intended to run on the Pi with zero command and the mower stationary. Use it to verify that the FG lines do not produce false pulse counts when the motors are unpowered or idle.

The direct mode script is intended for confirming left/right inversion and mirrored motor mounting. It accepts physical wheel modes such as:

- `FF` = both wheels forward
- `FR` = left forward, right reverse
- `F0` = left forward only
- `0F` = right forward only

Expected result for a healthy idle run:

- `PASS`
- zero wheel speeds and zero encoder deltas for the full run
- `watchdogHealthy: false` and watchdog `faultFlags` may still appear while idle if the firmware is simply timing out at zero command

## Before flashing

Check and adjust in the sketch if needed:

- inversion flags for left/right motors
- wheel circumference
- FG pulses-per-revolution scaling and gear ratio assumptions
- max wheel speed estimate
- PWM pins and tach pins
