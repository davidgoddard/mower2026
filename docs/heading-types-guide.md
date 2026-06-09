# Heading Types Guide

## Overview

This project uses **branded types** to prevent mixing incompatible heading representations at compile time. This eliminates a common source of bugs in navigation systems where angles in different conventions are accidentally combined.

## Type Definitions

### `FieldHeading`

GNSS/navigation heading using compass convention:
- **Range**: `[0, 360)` degrees
- **Direction**: Clockwise from North
- **Examples**:
  - `0°` = North
  - `90°` = East
  - `180°` = South
  - `270°` = West

This is the heading format provided by GNSS receivers like the UM982.

### `InternalHeading`

Internal Cartesian heading for control algorithms:
- **Range**: `(-180, 180]` degrees
- **Direction**: Counterclockwise from +X axis
- **Examples**:
  - `0°` = +X (East)
  - `90°` = +Y (North)
  - `180°` or `-180°` = -X (West)
  - `-90°` = -Y (South)

All path planning, control, and pose estimation use this convention.

### `RelativeAngle`

Signed angular difference or turn command:
- **Range**: `(-180, 180]` degrees
- **Meaning**: Positive = counterclockwise turn needed
- **Use cases**:
  - Turn commands
  - Heading errors
  - IMU yaw deltas

### `RawAngle`

Unnormalized angle value that requires normalization:
- Use as input to functions that will normalize
- Prevents using raw sensor values directly

## Creating Headings

```typescript
import { createFieldHeading, createInternalHeading, createRelativeAngle } from './geometry/headingTypes.js';

// From GNSS (compass heading)
const gnssHeading = createFieldHeading(45); // 45° clockwise from North (NE)

// For internal use
const mowerHeading = createInternalHeading(90); // Pointing North (+Y)

// Turn command
const turnLeft90 = createRelativeAngle(90); // 90° counterclockwise
```

## Converting Between Conventions

```typescript
import { fieldToInternal, internalToField } from './geometry/headingTypes.js';

// GNSS reports 90° (East) → convert to internal (0°, +X axis)
const gnssEast = createFieldHeading(90);
const internalEast = fieldToInternal(gnssEast); // 0°

// Internal heading pointing North (90°) → convert to field (0°)
const internalNorth = createInternalHeading(90);
const fieldNorth = internalToField(internalNorth); // 0°
```

## Computing Heading Differences

```typescript
import { headingDifference } from './geometry/headingTypes.js';

const current = createInternalHeading(10);
const target = createInternalHeading(30);

// How much to turn from current to reach target
const turnAngle = headingDifference(current, target); // +20° (CCW)
```

## Integrating IMU Yaw

```typescript
import { addRelativeAngle, createRelativeAngle } from './geometry/headingTypes.js';

let heading = createInternalHeading(45);

// IMU measures 5° counterclockwise rotation
const yawDelta = createRelativeAngle(5);
heading = addRelativeAngle(heading, yawDelta); // Now 50°
```

## Unwrapping for Display

When you need the raw numeric value (e.g., for logging or display):

```typescript
import { unwrapInternalHeading, unwrapFieldHeading } from './geometry/headingTypes.js';

const heading = createInternalHeading(45);
const degrees = unwrapInternalHeading(heading); // 45
console.log(`Mower heading: ${degrees}°`);
```

## Type Safety Benefits

### Prevents mixing conventions

```typescript
// ❌ TypeScript error: cannot assign FieldHeading to InternalHeading
const fieldHeading = createFieldHeading(90);
const internal: InternalHeading = fieldHeading; // ERROR!

// ✅ Explicit conversion required
const internal = fieldToInternal(fieldHeading); // OK
```

### Prevents using raw angles

```typescript
// ❌ TypeScript error: number is not assignable to InternalHeading
const heading: InternalHeading = 45; // ERROR!

// ✅ Must use constructor
const heading = createInternalHeading(45); // OK
```

### Prevents double-conversion

```typescript
const gnss = createFieldHeading(90);
const internal1 = fieldToInternal(gnss); // Correct

// ❌ TypeScript error: InternalHeading cannot be converted again
const internal2 = fieldToInternal(internal1); // ERROR!
```

## Usage in Sensor Controller

The sensor controller maintains heading as `InternalHeading`:

```typescript
class SensorController {
  private imuHeading: InternalHeading;

  getHeading(): InternalHeading {
    return this.imuHeading;
  }

  setHeading(heading: InternalHeading): void {
    this.imuHeading = heading;
  }

  private async pollGnss(): Promise<void> {
    const sample = await this.gateway.readGnss();
    
    if (sample.headingDegrees != null) {
      // GNSS provides field heading, convert to internal
      const fieldHeading = sample.headingDegrees as FieldHeading;
      const internalHeading = fieldToInternal(fieldHeading);
      
      // Now safe to use for pose updates or IMU correction
      this.setHeading(internalHeading);
    }
  }

  private async pollImu(): Promise<void> {
    const sample = await this.gateway.readImu();
    const deltaSeconds = 0.008; // ~125Hz
    
    // Project the gyro vector onto the gravity axis derived from pitch/roll,
    // then integrate the tilt-compensated yaw rate.
    const pitchRad = (sample.pitchDeg ?? 0) * Math.PI / 180;
    const rollRad = (sample.rollDeg ?? 0) * Math.PI / 180;
    const gravityX = -Math.sin(pitchRad);
    const gravityY = Math.sin(rollRad) * Math.cos(pitchRad);
    const gravityZ = Math.cos(rollRad) * Math.cos(pitchRad);
    const yawDelta = createRelativeAngle(
      (
        sample.angularVelocity.xDegreesPerSecond * gravityX +
        sample.angularVelocity.yDegreesPerSecond * gravityY +
        sample.angularVelocity.zDegreesPerSecond * gravityZ
      ) * deltaSeconds
    );
    this.imuHeading = addRelativeAngle(this.imuHeading, yawDelta);
  }
}
```

## Best Practices

1. **Always use branded types** for headings in function signatures
2. **Convert at boundaries**: Transform GNSS field headings to internal convention as soon as they enter the system
3. **Never perform arithmetic on unwrapped values**: Use `addRelativeAngle()` and `headingDifference()` instead
4. **Store internal headings**: Use `InternalHeading` for all state variables and intermediate calculations
5. **Export field headings**: Only convert back to `FieldHeading` when sending to GNSS or external displays that expect compass convention

## Common Patterns

### GNSS Heading Correction

```typescript
const gnssHeading = fieldToInternal(createFieldHeading(sample.headingDegrees));
const imuHeading = controller.getHeading();
const correction = headingDifference(imuHeading, gnssHeading);

// Apply correction if error exceeds threshold
if (Math.abs(unwrapRelativeAngle(correction)) > 5) {
  controller.setHeading(gnssHeading);
}
```

### Turn Command Generation

```typescript
const currentHeading = controller.getHeading();
const targetHeading = createInternalHeading(waypointBearing);
const turnCommand = headingDifference(currentHeading, targetHeading);

// Positive = turn left (CCW), negative = turn right (CW)
if (unwrapRelativeAngle(turnCommand) > 0) {
  console.log(`Turn left ${unwrapRelativeAngle(turnCommand)}°`);
} else {
  console.log(`Turn right ${-unwrapRelativeAngle(turnCommand)}°`);
}
```

### Path Following

```typescript
const heading = controller.getHeading();
const pathAngle = createInternalHeading(computePathBearing(position, target));
const crossTrackError = headingDifference(pathAngle, heading);

// Compute steering correction proportional to heading error
const steeringGain = 0.1;
const steeringCorrection = unwrapRelativeAngle(crossTrackError) * steeringGain;
```

## Testing

Comprehensive tests are in [test/headingTypes.test.js](../test/headingTypes.test.js), covering:

- Normalization edge cases
- Field ↔ Internal conversions
- Heading difference shortest path
- Real-world mower scenarios
- Round-trip conversion correctness

Run tests with:
```bash
npm test
```
