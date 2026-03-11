# Firmware Integration Notes

## Purpose

This document translates the Pi-side protocol and adapter expectations into concrete firmware behavior for the GNSS ESP and motor ESP.

## GNSS node expectations

The GNSS node shall publish a compact `GnssSample` response payload.

It should:

- timestamp each sample in node time milliseconds
- publish mower-local `xMeters` and `yMeters`
- publish heading only when the receiver considers it valid
- publish `sampleAgeMillis` so the Pi can distinguish stale transport from stale sensor data
- use `fixType` values consistently: `none`, `single`, `float`, `fixed`

The Pi currently interprets:

- `fixType = none` as no usable position measurement
- missing heading as `HeadingUnavailable`
- excessive sample age as `StaleSample`

## Recommended UM982 receiver logs

Based on the legacy implementation and the UM982 command manual in `/Volumes/mower/legacy/mower/Unicore Reference Commands Manual For N4 High Precision Products_V2_EN_R1.4.pdf`, the preferred receiver logs are:

### Primary log: `PVTSLNB`

Recommended as the main GNSS/heading source.

Manual references:

- Section `7.3.24 PVTSLN — Position and Heading Information`
- PDF pages `211` to `213`
- Message ID `1021`

Why this is the best primary source:

- It combines best position, velocity, and heading in one log.
- It contains both solution type and heading type.
- It includes latitude, longitude, height, standard deviations, heading, pitch, heading baseline length, satellite counts, and DOP values.

Important fields from the manual:

- `bestpos_type`
- `bestpos_lat`
- `bestpos_lon`
- `bestpos_hgt`
- `bestpos_hgtstd`
- `bestpos_latstd`
- `bestpos_lonstd`
- `bestpos_svs`
- `bestpos_solnsvs`
- `psrvel_north`
- `psrvel_east`
- `psrvel_ground`
- `heading_type`
- `heading_length`
- `heading_degree`
- `heading_pitch`
- `heading_trackedsvs`
- `heading_solnsvs`
- `gdop`
- `pdop`
- `hdop`

Design note:

The legacy rover ESP only parsed a small subset of `PVTSLNA` and discarded many useful fields. The new GNSS ESP should either parse the full ASCII message correctly or, preferably, use the binary `PVTSLNB` form and map only the needed fields into the compact Pi-facing payload.

### Time source: `RECTIMEB`

Recommended as an auxiliary time/status source.

Manual references:

- Section `7.3.47 RECTIME — Time Information`
- PDF pages `268` to `270`
- Message ID `102`

Why it is useful:

- It provides receiver clock offset, UTC offset, UTC date/time fields, and UTC validity.
- It is useful if we want better timestamp discipline in the GNSS ESP or to expose GNSS time quality to the Pi.

Important fields:

- `clock status`
- `offset`
- `offset std`
- `utc offset`
- `utc year`
- `utc month`
- `utc day`
- `utc hour`
- `utc min`
- `utc ms`
- `utc status`

### Heading diagnostic source: `UNIHEADINGB`

Recommended as a diagnostic and heading-validation source, not necessarily as the only normal runtime feed.

Manual references:

- Section `7.3.48 UNIHEADING — Heading Information`
- PDF pages `270` to `272`
- Message ID `972`

Why it is useful:

- It provides heading-specific quality fields that are richer than the minimal subset currently used by the legacy code.
- It includes heading and pitch standard deviation plus counts of tracked and solution satellites.

Important fields:

- `sol stat`
- `pos type`
- `length`
- `heading`
- `pitch`
- `hdgstddev`
- `ptchstddev`
- `#SVs`
- `#solnSVs`
- `#obs`
- `#multi`
- `ext sol stat`

Design note:

If bandwidth is tight, the GNSS ESP does not need to forward the full UNIHEADING payload to the Pi every cycle. It can use it internally to validate heading and populate compact Pi-facing fields such as heading, heading accuracy, heading validity, and satellite counts.

## UM982 logs not recommended as the primary Pi-facing source

These are useful for debugging or compatibility, but they are not the preferred main source for the new architecture:

- `GPGGA` / `GPGGAH`
  Useful for human-readable position/fix inspection, but too limited and text-heavy for the Pi bus.
- `GPTHS`
  Gives heading plus a simple validity mode, but `PVTSLN` and `UNIHEADING` carry richer status.
- `GPGSTH`
  Useful for pseudorange error statistics, but likely secondary once `PVTSLN` and `UNIHEADING` are available.
- `GPRMC`, `GPVTG`, `GPROT2`, `GPTRA2`, `GPHPD`
  Potentially useful for debug or niche diagnostics, but not needed for the first compact mower-ready interface.

## Recommended receiver output strategy

Inside the GNSS ESP:

- consume `PVTSLNB` as the main runtime source
- optionally consume `UNIHEADINGB` for heading-specific diagnostics and confidence
- optionally consume `RECTIMEB` for time validity and timestamp discipline

From GNSS ESP to Pi:

- send one compact binary navigation sample per update cycle
- include only mower-relevant fields:
  - local position or lat/lon converted to local position
  - heading when valid
  - fix type
  - position accuracy
  - heading accuracy
  - sample age
  - satellite count

Local frame decision:

- the fixed base station is the local origin
- the base station is `(0, 0)` in mower coordinates
- moving the base invalidates previously recorded routes and calibration geometry

## Motor node expectations

The motor node shall accept explicit wheel-speed commands and report execution feedback.

It should:

- accept left and right wheel target speeds in metres per second
- enforce command timeout locally
- report actual wheel speeds
- report encoder deltas for the sample interval
- report applied PWM output values
- report watchdog health
- report fault bits using the shared motor fault bitfield

See [motor-firmware-spec.md](/Volumes/mower/mower/docs/motor-firmware-spec.md).

## Shared fault bits

### GNSS fault bits

- bit 0: stale sample
- bit 1: invalid fix
- bit 2: heading unavailable
- bit 3: receiver warning

### Motor fault bits

- bit 0: watchdog expired
- bit 1: left encoder fault
- bit 2: right encoder fault
- bit 3: left driver fault
- bit 4: right driver fault
- bit 5: over-current

## Sampling guidance

Initial target guidance for development:

- GNSS node output: `10 Hz`
- Motor feedback output: `20 Hz` or greater
- Pi runtime loop: `20 Hz`

These values are starting points. Final rates should be validated against I2C bus occupancy and estimator quality.
