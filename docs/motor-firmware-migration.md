# Motor Firmware Migration Plan

## Purpose

This document translates the legacy motor ESP interface into the second-generation interface required by the new Pi-side runtime.

It is meant to answer:

- what should change in the firmware
- what can stay
- whether polling is acceptable
- what the Pi actually needs from the motor node

## Short answer

Yes, the motor driver code should change materially.

The biggest required changes are:

1. replace `mode + speed + turn` commands with explicit left/right wheel-speed commands
2. replace pulse-only readback with richer periodic motor feedback
3. add command timeout handling as part of the protocol contract
4. preserve the existing good ramp/reversal safety behavior

Polling is acceptable over I2C for now.

What matters is not “polling vs pushing” in itself, but that the feedback is:

- fresh
- compact
- regular
- rich enough for estimation and calibration

## Legacy interface summary

The legacy motor ESP currently exposes:

- register `0x02`: motion command with abstract mode, speed, and turn
- register `0x10`: config values
- register `0x01`: pulse deltas only

Problems with that interface:

- Pi cannot command true wheel targets
- Pi cannot tell whether wheels achieved what was intended
- pulse deltas alone are too weak for debugging and calibration
- steering semantics are split ambiguously between Pi and ESP

## Recommended second-generation command model

The Pi should send one compact command containing:

- left wheel target speed
- right wheel target speed
- drive enable
- command timeout
- optional accel limit
- optional decel limit

This already exists in the TypeScript side:

- `src/protocols/motorProtocol.ts`
- `src/protocols/motorCodec.ts`

## Recommended second-generation feedback model

The motor ESP should report, at minimum:

- left wheel actual speed
- right wheel actual speed
- left encoder delta
- right encoder delta
- left PWM applied
- right PWM applied
- watchdog health
- fault flags

Optional but desirable:

- left motor current
- right motor current

## Should this be polling or interrupt/push based?

### Internal firmware behavior

Inside the ESP:

- encoder sampling should be interrupt-driven or otherwise timing-robust
- wheel-speed control should run locally at a fixed high rate
- command timeout should be checked locally without Pi involvement

### Pi-to-ESP bus behavior

Across I2C:

- polling is acceptable and probably simplest
- the Pi can poll the latest compact feedback sample at `20 Hz`
- the ESP should maintain the latest coherent feedback snapshot and return it on request

So the recommendation is:

- internal motor execution: event-driven / fixed-rate local control
- bus exchange with Pi: request/response polling

## Suggested I2C behavior during migration

If you want a staged migration rather than a full rewrite in one step:

### Stage 1

Keep the existing low-level ramping code and tach counting, but change the command register semantics.

New command register behavior:

- receive explicit wheel targets instead of abstract turn intent

New feedback register behavior:

- return a fixed-size feedback struct, not only pulse deltas

### Stage 2

Add local wheel-speed estimation and expose:

- actual wheel speed
- encoder deltas
- PWM applied

### Stage 3

Add local closed-loop wheel-speed control and optional current/fault enrichment.

## Concrete firmware changes I want

### Keep

- pin mappings if they are still electrically correct
- PWM setup
- inversion handling
- safe stop-before-reverse behavior
- asymmetric ramp up/down
- tach/encoder counting logic concept

### Change

- remove `MODE_ARC` / `MODE_SPIN` as the main command API
- remove normalized `turn` as the main command input
- stop making the ESP decide vehicle turning geometry
- return feedback richer than just pulse counts

### Add

- wheel target command decoding
- per-wheel speed estimate
- watchdog state in feedback
- fault bits in feedback
- optional command sequence echo if useful for debugging

## Recommended feedback rate

For I2C polling:

- Pi polls feedback at `20 Hz`
- motor ESP internally updates execution at `100 Hz` or more

This gives:

- adequate estimator input rate
- manageable bus use
- a clear separation between local control timing and bus timing

## Recommended firmware-side data snapshot

The ESP should maintain one coherent feedback snapshot struct.

Each snapshot should represent:

- a single reporting interval
- encoder deltas accumulated since the previous snapshot
- wheel speeds estimated for that same interval
- actuation/fault state at the snapshot time

That snapshot is what the Pi polls.

## Debugging additions worth making

These are optional but would help a lot:

- echo last accepted command timestamp
- echo last accepted command sequence
- expose whether each wheel is currently in reversal/ramp-down state
- expose a saturating fault counter for missed or noisy encoder reads

## What I would not spend time on yet

- push-based unsolicited I2C traffic
- complex multi-register command sets
- fancy dynamic packet formats
- on-ESP path-following logic

Those add complexity before the core execution boundary is clean.

## Recommended next firmware implementation order

1. preserve the existing low-level motor safety behavior
2. replace the command payload with explicit wheel targets
3. add a coherent fixed-size feedback struct
4. validate encoder direction and speed scaling
5. add local wheel-speed control if open-loop execution is not good enough
