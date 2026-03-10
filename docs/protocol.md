# Wire Protocol

## Goals

- stay compact enough for I2C
- be simple to parse on ESP firmware
- be transport-neutral above the framing layer
- expose enough detail for estimation, calibration, and fault diagnosis

## Frame format

All transport messages use the same binary frame:

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 1 | start-of-frame | fixed `0x4D` |
| 1 | 1 | version | protocol version |
| 2 | 1 | nodeId | sender or logical destination |
| 3 | 1 | messageType | payload discriminator |
| 4 | 1 | flags | reserved for ACK/error bits later |
| 5 | 2 | sequence | little-endian |
| 7 | 2 | payloadLength | little-endian |
| 9 | N | payload | fixed-size per message for current messages |
| 9 + N | 2 | crc16 | CRC-16/CCITT over bytes `1..(8+N)` |

## Node identifiers

- `0x10`: GNSS node
- `0x20`: Motor node

## Message identifiers

- `0x01`: GNSS sample
- `0x21`: motor wheel-speed command
- `0x22`: motor feedback sample

## GNSS sample payload

Fixed length: `26` bytes

| Field | Type | Scale |
| --- | --- | --- |
| timestampMillis | `uint32` | milliseconds |
| xMeters | `int32` | millimetres |
| yMeters | `int32` | millimetres |
| headingDegrees | `int16` optional | centi-degrees |
| pitchDegrees | `int16` optional | centi-degrees |
| groundSpeedMetersPerSecond | `uint16` optional | millimetres/sec |
| positionAccuracyMeters | `uint16` | millimetres |
| headingAccuracyDegrees | `uint16` optional | centi-degrees |
| fixType | `uint8` | enum |
| satellitesInUse | `uint8` | count |
| sampleAgeMillis | `uint16` | milliseconds |

Recommended source on the GNSS ESP:

- primary: UM982 `PVTSLNB`
- auxiliary: UM982 `RECTIMEB`
- optional heading diagnostic enrichment: UM982 `UNIHEADINGB`

See [gnss-firmware-spec.md](/Volumes/mower/mower/docs/gnss-firmware-spec.md).

Optional integer sentinel values:

- `int16`: `32767`
- `uint16`: `65535`

## Motor wheel-speed command payload

Fixed length: `15` bytes

| Field | Type | Scale |
| --- | --- | --- |
| timestampMillis | `uint32` | milliseconds |
| leftWheelTargetMetersPerSecond | `int16` | millimetres/sec |
| rightWheelTargetMetersPerSecond | `int16` | millimetres/sec |
| enableDrive | `uint8` | `0` or `1` |
| commandTimeoutMillis | `uint16` | milliseconds |
| maxAccelerationMetersPerSecondSquared | `uint16` optional | millimetres/sec² |
| maxDecelerationMetersPerSecondSquared | `uint16` optional | millimetres/sec² |

## Motor feedback payload

Fixed length: `26` bytes

| Field | Type | Scale |
| --- | --- | --- |
| timestampMillis | `uint32` | milliseconds |
| leftWheelActualMetersPerSecond | `int16` | millimetres/sec |
| rightWheelActualMetersPerSecond | `int16` | millimetres/sec |
| leftEncoderDelta | `int32` | counts |
| rightEncoderDelta | `int32` | counts |
| leftPwmApplied | `int8` | signed percent or controller output step |
| rightPwmApplied | `int8` | signed percent or controller output step |
| leftMotorCurrentAmps | `uint16` optional | deci-amps |
| rightMotorCurrentAmps | `uint16` optional | deci-amps |
| watchdogHealthy | `uint8` | `0` or `1` |
| faultFlags | `uint16` | bitfield |
| reserved | `uint8` | for future use |

## Design notes

- Integer-scaled fields avoid floating-point traffic on the bus.
- Fixed payload sizes simplify firmware parsing.
- The motor protocol now carries explicit wheel targets and encoder deltas, which is necessary for the second-generation estimator and calibration pipeline.
