# Hardware Data Checklist

## Purpose

This checklist captures the remaining physical and electrical facts needed to finalize the motor firmware rewrite, actuator scaling, and calibration logic.

## Base station and GNSS

- Base station fixed corner description: fixed lawn corner, treated as coordinate origin
- Base station antenna mounting height:
- Approximate base station coordinates if known: legacy config used `55.9536, -3.1886` as placeholder/example; not current lawn
- Dual-antenna spacing on mower: about `0.30 m`; legacy UM982 setup file used `CONFIG HEADING LENGTH 33.00 5.00`, so firmware should allow small tolerance around this
- Antenna forward/right offsets from mower reference point: antenna platform is angled about `20-30 degrees`; center of the front antenna dome is about `0.07 m` in front of the main axle; the rear antenna is behind it; both are roughly centered left/right and roughly central front/back, but not precisely measured
- UM982 current configured output rates:
- UM982 heading quality observed in practice:
- RTK float usability during development:

## Mower geometry

- Distance between driven wheel contact centers: legacy config uses `wheelBase = 0.52 m`
- Wheel diameter:
- Wheel circumference: legacy config uses `0.7 m`
- Distance from mower reference point to antenna baseline center:
- Distance from mower reference point to rear roller contact:
- Approximate mower mass:
- Mower base model: modified `Flymo H400`

## Motor hardware

- Left motor model:
- Right motor model:
- Motor driver model:
- Supply voltage:
- Maximum safe continuous current:
- Whether left/right motors are mechanically identical: legacy config assumes yes

## Encoder hardware

- Encoder type: current motor documentation indicates `FG` speed pulse output rather than quadrature encoder
- Electrical output type: open-collector `NPN`
- Pulses per motor revolution: motor sheet indicates `12 pulses / round`
- Any gearbox ratio between motor and wheel:
- Effective counts per wheel revolution: depends on confirmed gear ratio; legacy `1620` value should now be treated as provisional
- Whether count direction is available or only pulse count: pulse count only from `FG`; direction is inferred from commanded drive direction rather than measured directly
- Whether both feedback channels are equally reliable:
- Pull-up resistor fitted on each FG line:
- Pull-up voltage used for FG line: should be `3.3 V` for direct ESP32 input unless level shifting is added

## Electrical and sensing

- Current sensing available:
- If yes, on which channels:
- Emergency stop wiring behavior:
- Any low-level driver fault pins available:
- Any wheel slip sensing beyond encoder feedback:

## Desired control targets

- Maximum autonomous forward speed:
- Preferred maximum spin speed:
- Required stop accuracy: legacy config used `stopDistance = 0.1 m`
- Required heading accuracy after spin:
- Is reverse required in autonomous mode now:

## Development observations

- Known weaker motor:
- Known stronger motor:
- Known drift direction on straight drive:
- Known wheel slip conditions:
- Known GPS blind spots or multipath areas:
- Observed false FG pulses at zero motor power:

## Notes

- The current project assumes the fixed base station defines local coordinate origin `(0, 0)`.
- If the base station moves, saved geometry should be considered invalid and re-recorded.
- Legacy control/config values worth revisiting:
  - `cuttingWidth = 0.3 m` in `config.keep`, `0.4 m` in `keep-config.json`
  - `generalOperation.slowRadius = 0.15 m` in `config.keep`, `0.75 m` in `keep-config.json`
  - `generalOperation.minSpeed = 0.5` in `config.keep`, `0.6` in `keep-config.json`
  - turning thresholds seen in legacy config:
    - `spinEnterThreshold = 0.5` or `0.6`
    - `spinExitThreshold = 0.005` or `0.05`
    - `rampUp = 1200 ms` or `1500 ms`
    - `rampDown = 300 ms` or `1000 ms`
- Clarified by user:
  - `rampUp` was intentionally gentle to avoid a mechanical bang as the rotary cutter spins up through gearing while driving forward
  - `rampDown` can be much faster because an idler lets the cutter free-spin while the drive wheels stop
  - nominal physical cutting width is about `0.40 m`
  - `0.30 m` cutting width in legacy config was an intentional overlap margin rather than the true deck width
  - current motor documentation shows yellow `FG` feedback output with `12 pulses / round`
