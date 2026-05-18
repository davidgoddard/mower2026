# Constants Architecture

## Philosophy

Constants are divided into two categories:

### 1. **Design Constants** (Global - in `src/constants.ts`)

System-wide configuration and tuning parameters that represent **design decisions**:
- Control loop frequencies (30Hz sensor polling)
- Manual drive response curves
- Hardware addresses (configurable system topology)
- Retry policies and timeouts
- Physical system limits

These affect behavior across multiple components and are **tunable parameters** that operators or developers might want to adjust.

### 2. **Implementation Constants** (Local - in their modules)

Module-internal details that support specific implementations:
- Protocol frame sizes and byte offsets
- Scaling factors for unit conversions
- Register values and hardware-specific timings
- Internal buffer sizes and sentinels

These are **implementation details** that should never be referenced outside their module.

---

## Design Constants (src/constants.ts)

### Timing Constants (Design Decisions)
```typescript
export const SENSOR_POLL_INTERVAL_MS = 33; // 30Hz - tunable system performance
export const MANUAL_DRIVE_LOOP_INTERVAL_MS = 100; // User responsiveness
export const IMU_DEFAULT_CALIBRATION_SAMPLES = 60; // Accuracy vs speed tradeoff
export const GNSS_RETRY_DELAY_MS = 20; // Retry policy
export const GNSS_DEFAULT_MAX_ATTEMPTS = 3; // Reliability policy
```

**Why global:** These affect system-wide behavior and performance characteristics.

### I2C Hardware Addresses
```typescript
export const I2C_ADDRESS_GNSS_DEFAULT = 0x52;
export const I2C_ADDRESS_MOTOR_DEFAULT = 0x66;
export const I2C_ADDRESS_BMI160_DEFAULT = 0x69;
export const I2C_BUS_NUMBER_DEFAULT = 1;
```

**Why global:** System topology configuration - multiple components need these.

### Manual Drive Parameters (Tuning)
```typescript
export const MANUAL_TURN_DEADBAND_DEGREES = 6;
export const MANUAL_TURN_FULL_LOCK_DEGREES = 84;
export const MANUAL_DRIVE_SPIN_THRESHOLD = 0.995;
// ... 12 total manual drive tuning parameters
```

**Why global:** User experience tuning - operator feel adjustments.

### Motor Configuration
```typescript
export const MOTOR_LEFT_FORWARD_SIGN_DEFAULT = -1;
export const MOTOR_RIGHT_FORWARD_SIGN_DEFAULT = -1;
export const MAX_WHEEL_SPEED_MPS_DEFAULT = 0.75;
```

**Why global:** Hardware configuration and physical limits.

### Network Defaults
```typescript
export const HTTP_SERVER_PORT_DEFAULT = 8090;
export const HTTP_SERVER_HOST_DEFAULT = "0.0.0.0";
export const MAX_PORT_NUMBER = 65535;
```

**Why global:** System-wide network configuration.

---

## Implementation Constants (Local to Modules)

### Protocol Frame Format (`src/bus/frameCodec.ts`)
```typescript
// Implementation details - never referenced outside this module
const START_OF_FRAME = 0x4d;
const HEADER_SIZE = 9;
const CRC_SIZE = 2;
```

**Why local:** Protocol implementation detail. If we change frame format, only this module changes.

### GNSS Codec (`src/gnss/gnssCodec.ts`)
```typescript
// Implementation details of GNSS payload format
const GNSS_PAYLOAD_LENGTH_V1 = 36;
const GNSS_PAYLOAD_LENGTH_V2 = 38;
const POSITION_SCALE_MM_TO_M = 1000;
const HEADING_SCALE_CENTIDEG_TO_DEG = 100;
```

**Why local:** Codec implementation. External code doesn't need to know about payload sizes or internal scaling.

### GNSS Client (`src/gnss/gnssNodeClient.ts`)
```typescript
// Protocol sequence handling - implementation detail
const PROTOCOL_SEQUENCE_MASK = 0xffff;
```

**Why local:** Internal to how this client tracks requests. No other module cares.

### Motor Codec (`src/motors/motorCodec.ts`)
```typescript
// Protocol payload sizes - implementation details
const WHEEL_SPEED_COMMAND_LENGTH = 15;
const MOTOR_FEEDBACK_SAMPLE_LENGTH = 26;
const VELOCITY_SCALE_MMS_TO_MS = 1000;
const ACCELERATION_SCALE_MILLI_TO_UNIT = 1000;
const CURRENT_SCALE_DECIAMP_TO_AMP = 10;
const OPTIONAL_UINT16_SENTINEL = 0xffff;
const OPTIONAL_UINT16_MAX_VALUE = 0xfffe;
```

**Why local:** Codec implementation details. External code just calls `encodeWheelSpeedCommand()`.

### BMI160 IMU Sensor (`src/imu/bmi160ImuSensor.ts`)
```typescript
// Hardware-specific timing from datasheet
const IMU_GYRO_INIT_DELAY_MS = 80;
const IMU_GYRO_RANGE_DELAY_MS = 10;
const IMU_CALIBRATION_SAMPLE_DELAY_MS = 4;
const BMI160_GYRO_RANGE_2000DPS = 0x00;
const INT16_MAX = 0x7fff;
const UINT16_WRAP = 0x10000;
```

**Why local:** Hardware-specific implementation. Register values and datasheet timings.

### Logging (`src/logging/sessionLogger.ts`)
```typescript
// Log formatting implementation details
const LEVEL_PRIORITY = { debug: 10, info: 20, warn: 30, error: 40 };
// String padding is done with literal 2 and 3, not constants
```

**Why local:** Internal logging implementation. External code just calls `.info()` etc.

### Heading Types (`src/geometry/headingTypes.ts`)
```typescript
// Angle normalization implementation
const NORMALIZED_ANGLE_MIN = -180;
const NORMALIZED_ANGLE_MAX = 180;
const FIELD_ANGLE_MIN = 0;
const FIELD_ANGLE_MAX = 360;
const DEGREES_PER_CIRCLE = 360;
const FIELD_TO_INTERNAL_OFFSET_DEGREES = 90;
```

**Why local:** Internal to heading type normalization. External code uses `createInternalHeading()`.

### Manual Drive Profile (`src/control/manualDriveProfile.ts`)
```typescript
// Clamping range constants - implementation detail
const NORMALIZED_MIN = 0;
const NORMALIZED_MAX = 1;
const SIGNED_NORMALIZED_MIN = -1;
const SIGNED_NORMALIZED_MAX = 1;
```

**Why local:** Internal helper constants for the profile calculation.

### Sensor Controller (`src/sensing/sensorController.ts`)
```typescript
// Time conversion - implementation detail
const MS_PER_SECOND = 1000;
```

**Why local:** Simple conversion used only in this module.

---

## Guidelines for Adding New Constants

### Ask: "Is this a design decision or implementation detail?"

**Design Decision → Global (`src/constants.ts`)**
- ✅ Affects multiple components
- ✅ Tunable parameter (operator might adjust)
- ✅ System-wide policy (retry counts, timeouts)
- ✅ Hardware topology (addresses, bus numbers)
- ✅ Physical limits (max speed, sensor rates)
- ✅ User experience tuning (deadbands, response curves)

**Implementation Detail → Local (in the module)**
- ✅ Protocol frame format details
- ✅ Buffer sizes and byte offsets
- ✅ Internal scaling factors
- ✅ Register values and hardware timings
- ✅ Sentinel values and magic numbers
- ✅ Used only within one module
- ✅ Would change if implementation changes

### Examples

#### ✅ Correct: Design Decision (Global)
```typescript
// src/constants.ts
export const SENSOR_POLL_INTERVAL_MS = 33; // System performance decision
```
Used by: `sensorController.ts`, potentially referenced in docs, might be tuned.

#### ✅ Correct: Implementation Detail (Local)
```typescript
// src/gnss/gnssCodec.ts
const GNSS_PAYLOAD_LENGTH_V1 = 36; // Protocol implementation
```
Used only in: This codec. If protocol changes, only this file changes.

#### ❌ Wrong: Implementation Detail in Global
```typescript
// src/constants.ts - DON'T DO THIS
export const PROTOCOL_HEADER_SIZE = 9; // Too specific!
```
Only used by `frameCodec.ts`. Should be local.

#### ❌ Wrong: Design Decision Scattered
```typescript
// Multiple files defining same policy - DON'T DO THIS
const MAX_RETRIES = 3; // In file A
const RETRY_ATTEMPTS = 3; // In file B
const NUM_TRIES = 3; // In file C
```
Should be one global constant: `GNSS_DEFAULT_MAX_ATTEMPTS`.

---

## Benefits of This Architecture

### 1. Clear Module Boundaries
Implementation details stay encapsulated. Protocol changes don't ripple through the codebase.

### 2. Easy Tuning
All tunable parameters in one place (`constants.ts`). Operators can adjust system behavior.

### 3. Reduced Coupling
Modules don't depend on implementation details of other modules.

### 4. Better Testability
Can change internal implementations without affecting external interfaces.

### 5. Documentation
`constants.ts` serves as a **system configuration reference** showing all tunable parameters.

---

## Real-World Example

### Changing GNSS Protocol (Good Architecture)

**Scenario:** Need to support GNSS payload V3 with 40 bytes.

**Changes needed:**
```typescript
// src/gnss/gnssCodec.ts - ONLY THIS FILE CHANGES
const GNSS_PAYLOAD_LENGTH_V1 = 36;
const GNSS_PAYLOAD_LENGTH_V2 = 38;
const GNSS_PAYLOAD_LENGTH_V3 = 40; // Add new version

// Update decoding logic...
```

**No changes needed to:**
- ✅ `constants.ts` - Design decisions unchanged
- ✅ `sensorController.ts` - Uses public API
- ✅ `server/main.ts` - Configuration unchanged
- ✅ Other modules - Implementation detail isolated

### Changing System Poll Rate (Good Architecture)

**Scenario:** Want to run sensors at 50Hz instead of 30Hz.

**Changes needed:**
```typescript
// src/constants.ts - ONLY THIS VALUE CHANGES
export const SENSOR_POLL_INTERVAL_MS = 20; // Was 33 (30Hz), now 20 (50Hz)
```

**Automatically affects:**
- ✅ `sensorController.ts` - Picks up new default
- ✅ Documentation - Clear what changed
- ✅ All components using sensor data

---

## Migration Guide

If you find implementation constants in `src/constants.ts`:

1. **Identify if it's really a design decision**
   - Is it used in multiple modules?
   - Is it something an operator would tune?
   - Is it a system-wide policy?

2. **If NO, move it local**
   ```typescript
   // Remove from src/constants.ts
   // Add at top of the module that uses it
   const INTERNAL_BUFFER_SIZE = 256; // Implementation detail
   ```

3. **Update imports**
   ```typescript
   // Before
   import { INTERNAL_BUFFER_SIZE } from "../constants.js";
   
   // After
   // (Defined locally, no import needed)
   const INTERNAL_BUFFER_SIZE = 256;
   ```

4. **Add comment explaining why it's local**
   ```typescript
   // Protocol frame size - implementation detail, not a design decision
   const FRAME_SIZE = 42;
   ```

---

## Summary

**Global constants (`src/constants.ts`):** System design decisions
- Tunable parameters
- Cross-component configuration
- Hardware topology
- System policies

**Local constants (in modules):** Implementation details
- Protocol formats
- Scaling factors
- Register values
- Buffer sizes
- Sentinel values

This architecture **balances** maintainability (easy to tune system) with **encapsulation** (implementation details stay local).
