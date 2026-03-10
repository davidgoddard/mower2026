# Default Parameters

## Purpose

This document records the current default parameter assumptions encoded in the TypeScript project.

The source of truth is:

- `src/config/defaults.ts`
- `src/config/parameterSchema.ts`
- `src/config/parameterValidator.ts`

## Current defaults

### Mowing geometry

- physical cutting width: `0.40 m`
- effective planning stripe width: `0.30 m`
- estimated lawn area: `500 m²`

Reason:

- the deck is about `40 cm`
- the planning stripe is intentionally narrower so overlap hides straight-line errors

Important implication:

- better straight-line control and lower cross-track error should allow the effective planning stripe width to move closer to the true `0.40 m`
- that directly reduces mowing time on the `~500 m²` lawn

### Vehicle geometry

- wheel base: `0.52 m`
- wheel circumference: `0.70 m`
- encoder counts per wheel revolution: `1620`
- antenna baseline: `0.30 m`
- front antenna forward offset from axle: `0.07 m`

These are currently legacy-derived or user-provided approximations and remain calibratable.

### Drive execution

- control loop: `20 Hz`
- max wheel speed: `0.75 m/s`
- max wheel acceleration: `0.5 m/s²`
- motor ramp-up: `1200 ms`
- motor ramp-down: `300 ms`

Asymmetric ramping is intentional because the mower cutter free-spins on deceleration but shocks the drivetrain when accelerated too abruptly.

### Arrival tolerances

- waypoint arrival tolerance: `0.05 m`
- heading arrival tolerance: `2°`

These are precision targets, not guaranteed achieved performance.

## Validation rules

The current validator enforces:

- all geometric and timing values must be positive
- effective planning stripe width must not exceed physical cutting width
- front antenna forward offset must not be negative
- heading tolerance must stay reasonably tight for precision mowing

## Next likely parameter work

- split provisional versus calibrated values formally
- add wheel-speed controller defaults for the motor ESP
- add slip and trust tuning parameters once replay data exists
