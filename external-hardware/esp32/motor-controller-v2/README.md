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
- counts encoder/tach pulses
- returns a coherent fixed-size feedback snapshot

## Important note

This firmware is designed as a practical migration step.

It already uses the new wire protocol and feedback contract, but the wheel-speed execution is still intentionally simple:

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

## Manual test support

Use the companion host-side script:

- `../manual-tests/motor_manual_test.js`

That script is intended to run on the Pi and exercise:

- spin one way
- spin the other way
- forward
- backward
- direction swaps
- gentle arcs

## Before flashing

Check and adjust in the sketch if needed:

- inversion flags for left/right motors
- wheel circumference
- encoder counts per wheel revolution
- max wheel speed estimate
- PWM pins and tach pins
