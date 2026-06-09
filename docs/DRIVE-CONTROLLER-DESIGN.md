# Drive Controller Design

## Overview

The Drive Controller is a supervised self-learning component responsible for executing precise point-to-point drives using GNSS position feedback, IMU heading, encoder dead-reckoning, and adaptive parameter tuning.

## Requirements (from Functional Spec)

### Core Functionality
- Drive from current position to target position in X/Y plane
- Turn to face target (if >5° off) before driving
- Drive straight line with cross-track error (CTE) correction
- Use full speed (motor command = 1.0) for all drives
- Learn optimal brake distance and CTE correction gain
- Every drive improves future accuracy through parameter adaptation

### Learning Behavior
- Monitor position during drive execution
- Predict when to brake based on learned brake distance
- Measure arrival error (X/Y) after motor ramp-down
- Adjust brake distance and CTE gain to reduce future errors
- Persist learned parameters for next drive

### Sensor Fusion
- Use GNSS position when fix quality is good
- Fall back to IMU heading + encoder dead-reckoning when GNSS lost
- Update IMU base heading from stable GNSS heading samples when the GNSS heading is already close to the current IMU heading
- Calibrate encoder-to-distance conversion from successful drives
- Encapsulate fusion logic in separate PoseFusion component

### Special Considerations
- **Braking distance**: Once at full speed, brake distance is constant (level ground)
- **Short drives**: May not reach full speed, may need different handling
- **Terrain slope**: Future enhancement to adjust brake distance based on IMU pitch
- **CTE correction**: Asymmetric - keep one wheel at max speed, slow the other

---

## Architecture

### Component Structure

```
src/control/
  ├── driveController.ts          # Segment drive controller (turn then line drive)
  ├── driveLineController.ts      # Straight-line drive controller with CTE/brake learning
  ├── driveControllerTypes.ts     # Type definitions
  └── driveLearningModel.ts       # Adaptive parameter learning

src/sensing/
  └── poseFusion.ts               # GNSS/IMU/encoder sensor fusion

src/geometry/
  └── positionTypes.ts            # Position and distance branded types

test/
  └── driveController.test.js     # Unit tests

docs/
  └── DRIVE-CONTROLLER-DESIGN.md  # This document
```

### Dependencies

```typescript
import { SensorController } from "../sensing/sensorController.js";
import { PoseFusion } from "../sensing/poseFusion.js";
import { TurnController } from "./turnController.js";
import { DriveLineController } from "./driveLineController.js";
import { SessionLogger } from "../logging/index.js";
import {
  InternalHeading,
  RelativeAngle,
  createRelativeAngle,
  headingDifference,
  unwrapRelativeAngle,
  unwrapInternalHeading,
} from "../geometry/headingTypes.js";
import {
  Position,
  Meters,
  MetersPerSecond,
  createPosition,
  createMeters,
  distanceBetween,
  angleTo,
  crossTrackError,
  unwrapMeters,
} from "../geometry/positionTypes.js";
```

---

## Detailed Design

### 1. Position Types (`src/geometry/positionTypes.ts`)

#### Branded Types

```typescript
export type Meters = number & { readonly __brand: "Meters" };

export interface Position {
  readonly xMeters: Meters;
  readonly yMeters: Meters;
}

export interface Pose {
  readonly position: Position;
  readonly heading: InternalHeading;
  readonly quality: "gnss" | "dead-reckoning" | "unknown";
}
```

#### Geometry Functions

```typescript
export function createPosition(x: number, y: number): Position;
export function createMeters(value: number): Meters;
export function unwrapMeters(m: Meters): number;

// Distance between two positions (Pythagorean)
export function distanceBetween(a: Position, b: Position): Meters;

// Angle from position A to position B
export function angleTo(from: Position, to: Position): InternalHeading;

// Cross-track error: perpendicular distance from point to line
export function crossTrackError(
  point: Position,
  lineStart: Position,
  lineEnd: Position
): Meters;

// Point along line at given distance from start
export function pointAlongLine(
  start: Position,
  end: Position,
  distanceFromStart: Meters
): Position;
```

---

### 2. Pose Fusion (`src/sensing/poseFusion.ts`)

#### Responsibilities
- Subscribe to sensor events: `gnssPositionUpdate`, `imuHeadingUpdate`, `motorFeedbackUpdate`
- Maintain best-estimate pose at all times
- Track pose quality (GNSS vs dead-reckoning)
- Update IMU base heading from stable GNSS samples
- Dead-reckon position using encoder feedback when GNSS lost
- Calibrate encoder-to-distance factor from successful drives

#### State Machine

```
IDLE → STARTING → RUNNING → STOPPED
```

**Running behavior:**
- Always subscribed to sensor events (not scoped like controllers)
- Continuously updates internal pose estimate
- Exposes `getCurrentPose()` synchronously

#### Interface

```typescript
export interface PoseFusionOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  encoderMetersPerTick?: number;
}

export class PoseFusion extends EventEmitter {
  constructor(options: PoseFusionOptions);
  
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  // Get current best-estimate pose
  getCurrentPose(): Pose;
  
  // Set absolute position (e.g., from user-defined waypoint)
  setPosition(position: Position): void;
  
  // Update encoder calibration from external source
  setEncoderCalibration(metersPerTick: number): void;
  getEncoderCalibration(): number;
  
  // Emits 'poseUpdate' event at sensor rate (200Hz)
  on(event: 'poseUpdate', listener: (pose: Pose) => void): this;
  off(event: 'poseUpdate', listener: (pose: Pose) => void): this;
}
```

#### GNSS Fusion Logic

When `gnssPositionUpdate` event received:
- Check fix quality (`fixType === "rtk-fixed"` or `"rtk-float"`)
- Check position accuracy (`< 0.1 meters`)
- If quality good:
  - Update position directly from GNSS
  - Mark pose quality as `"gnss"`
  - If heading available and stable, update IMU base heading via `sensorController.setHeading()`
- If quality poor:
  - Continue dead-reckoning (don't update position)
  - Mark pose quality as `"dead-reckoning"`

#### Dead-Reckoning Logic

When `motorFeedbackUpdate` event received:
- Calculate distance traveled: `(leftEncoderDelta + rightEncoderDelta) / 2 * encoderMetersPerTick`
- Get current heading from IMU
- Update position: `x += distance * cos(heading)`, `y += distance * sin(heading)`
- Only used when GNSS quality is poor

#### IMU Heading Update

When GNSS heading is stable (quality check):
- `sensorController.setHeading(gnssHeading)` - resets IMU integration baseline
- Prevents IMU drift during long GNSS outages

#### Encoder Calibration

After successful drive with good GNSS at start and end:
- Calculate actual distance: `distanceBetween(startPos, endPos)`
- Sum encoder ticks over drive
- Update calibration: `metersPerTick = actualDistance / totalTicks`
- Smooth update with exponential filter: `newValue = 0.9 * old + 0.1 * measured`

---

### 3. Segment Drive Controller (`src/control/driveController.ts`)

#### Responsibilities
- Execute point-to-point segment drives
- Turn to face the target before the line drive phase
- Delegate straight-line motion to `DriveLineController`
- Keep the segment orchestration isolated from the straight-line braking and learning logic
- Return a completed or stopped segment result to the app without exposing internal line-drive state

#### Execution Flow

- Get the current pose at the start of the segment
- Turn to face the target if the heading error exceeds the initial threshold
- Delegate the straight-line phase to `DriveLineController`
- Record successful line-drive results in the segment history
- Return `stopped` or `error` immediately if the turn or delegated line drive is interrupted

**Emergency Stop Behavior:**
- User or system can call `stopCurrentDrive()` at any time
- Stop is propagated to the delegated line-drive controller during the straight-line phase
- No learning occurs on stopped segment drives
- Result returned with `status="stopped"`

#### Straight-Line Ownership

The straight-line pose update, cross-track correction, arrival stop, braking, and learning logic live in `src/control/driveLineController.ts`.
That controller uses separate forward and reverse steering branches so reverse travel can compare the mower heading against the reverse travel direction instead of treating the target line as if it were a forward-only drive.
Short-distance training legs are generated from the anchor pose heading so the mower can train forward and reverse in its current local frame rather than wandering on an absolute X axis.

The segment controller is responsible only for:
- turning to face the target
- settling after turn
- delegating the straight-line phase
- returning the resulting segment status and history to the app

---

### 4. Drive Learning Model (`src/control/driveLearningModel.ts`)

#### Responsibilities
- Maintain learned parameters: long-drive brake distance, short-drive brake fractions, CTE gain, encoder calibration
- Update parameters after each drive based on errors
- Persist parameters to JSON file
- Load parameters on startup

#### Parameters

```typescript
export interface DriveParameters {
  version: number;
  longDriveBrakeDistanceMeters: number;
  forwardCteGain: number;
  reverseCteGain: number;
  longDriveMinDistanceMeters: number;
  shortDriveBucketStepMeters: number;
  shortDriveMaxDistanceMeters: number;
  shortDriveBrakeFractionsPositive: number[];
  shortDriveBrakeFractionsNegative: number[];
  shortDriveSampleCountsPositive: number[];
  shortDriveSampleCountsNegative: number[];
  shortDriveLastErrorPositiveMeters: number[];
  shortDriveLastErrorNegativeMeters: number[];
  updatedAt: string;
}
```

#### Learning Algorithm

**Brake Distance Update:**
```typescript
updateFromDrive(result: DriveUpdateData): void {
  const errorXValue = unwrapMeters(result.errorX);
  
  const driveDistance = unwrapMeters(distanceBetween(result.startPosition, result.targetPosition));
  if (driveDistance <= this.parameters.shortDriveMaxDistanceMeters) {
    // Bucketed short-drive learning: 5cm buckets from 5cm to 1m
    // plus one additional 1.05m bucket for longer straight runs.
    // Separate positive/negative variants are used for field X direction.
    return;
  }

  // Long-drive learning keeps a single brake distance for full-speed runs
  const alpha = 0.1;
  const adjustment = errorXValue * alpha;
  this.parameters.longDriveBrakeDistanceMeters += adjustment;
  this.parameters.longDriveBrakeDistanceMeters = Math.max(0.1, Math.min(5.0, this.parameters.longDriveBrakeDistanceMeters));

  this.logger.info("drive.learning.brake_distance_updated", {
    errorX: errorXValue,
    adjustment,
    newBrakeDistance: this.parameters.longDriveBrakeDistanceMeters,
  });
}
```

Short-drive buckets are keyed by 5cm distance bands from 5cm to 1m plus one additional 1.05m bucket for longer straight runs, and split into positive and negative X-direction variants using the sign of the target X displacement relative to the start pose.

The short-distance tuning sequence should sample the mower's current pose and heading immediately before each leg, pause briefly so the operator can see progress, clear any stale stop latch at the start of a new run, and then drive straight forward or straight back from that live heading.  If either leg in a forward/reverse pair misses the target tolerance, the whole pair is retried from a fresh pose sample so the mower keeps learning from the current local frame.

Short-distance legs should stop early if cross-track error grows beyond the requested run distance so a bad run cannot drift far away from the training area.

Segment-drive tuning should keep a fixed line from the mower's starting pose and heading, then train 105cm to 6m segments in 20cm steps on that line using the full segment controller. Each segment leg should turn to face its target, drive to it, and repeat the forward/reverse pair until the absolute X error is within the chosen tolerance.

**CTE Gain Update:**
```typescript
// Update direction-specific CTE gain based on max CTE achieved
const maxCteValue = Math.abs(unwrapMeters(result.maxCte));
const targetCte = 0.05; // 5cm target
const direction = result.driveDirectionSign ?? 1;

if (maxCteValue > targetCte * 1.5) {
  // CTE too high - increase gain
  if (direction > 0) {
    this.parameters.forwardCteGain *= 1.05;
  } else {
    this.parameters.reverseCteGain *= 1.05;
  }
} else if (maxCteValue < targetCte * 0.5) {
  // CTE very low - could decrease gain (more efficient)
  if (direction > 0) {
    this.parameters.forwardCteGain *= 0.98;
  } else {
    this.parameters.reverseCteGain *= 0.98;
  }
}

// Clamp gain
// Keep the gain bounded, but allow it to rise well above unity so the mower
// can become much more assertive when the drift is genuinely large.
this.parameters.forwardCteGain = Math.max(0.1, Math.min(2.5, this.parameters.forwardCteGain));
this.parameters.reverseCteGain = Math.max(0.1, Math.min(2.5, this.parameters.reverseCteGain));
```

#### Persistence

```typescript
async saveParameters(): Promise<void> {
  const parametersPath = path.join(DATA_DIR, "drive-learning-params.json");
  await fs.writeFile(parametersPath, JSON.stringify(this.parameters, null, 2), "utf8");
}

async loadParameters(): Promise<void> {
  try {
    const parametersPath = path.join(DATA_DIR, "drive-learning-params.json");
    const content = await fs.readFile(parametersPath, "utf8");
    this.parameters = JSON.parse(content);
  } catch (error) {
    // Use defaults
    this.parameters = {
      version: 1,
      longDriveBrakeDistanceMeters: 2.0,
      forwardCteGain: 0.3,
      reverseCteGain: 0.3,
      longDriveMinDistanceMeters: 1.0,
      shortDriveBucketStepMeters: 0.05,
      shortDriveMaxDistanceMeters: 1.0,
      shortDriveBrakeFractionsPositive: Array(20).fill(0.5),
      shortDriveBrakeFractionsNegative: Array(20).fill(0.5),
      shortDriveSampleCountsPositive: Array(20).fill(0),
      shortDriveSampleCountsNegative: Array(20).fill(0),
      shortDriveLastErrorPositiveMeters: Array(20).fill(0),
      shortDriveLastErrorNegativeMeters: Array(20).fill(0),
      updatedAt: new Date().toISOString(),
    };
  }
}
```

---

### 5. Type Definitions (`src/control/driveControllerTypes.ts`)

```typescript
import { Position, Meters } from "../geometry/positionTypes.js";

export interface DriveRequest {
  readonly targetPosition: Position;
  readonly learningEnabled?: boolean; // Default true
}

export interface DriveResult {
  readonly startPosition: Position;
  readonly targetPosition: Position;
  readonly finalPosition: Position;
  readonly errorX: Meters;              // Along-track error (positive = overshot)
  readonly errorY: Meters;              // Cross-track error at arrival
  readonly maxCteMeters: Meters;        // Maximum CTE during drive
  readonly avgCteMeters: Meters;        // Average absolute CTE
  readonly durationMs: number;
  readonly brakeDistanceUsed: Meters;
  readonly status: "success" | "error" | "stopped" | "timeout";
  readonly errorMessage?: string;
  readonly timestamp: string;
}

export type DriveStatus = 
  | "idle" 
  | "turning" 
  | "settling" 
  | "driving" 
  | "braking" 
  | "measuring" 
  | "learning" 
  | "stopped";

export interface DriveControllerState {
  readonly status: DriveStatus;
  readonly currentDrive: DriveRequest | null;
  readonly drivesCompleted: number;
  readonly averageErrorXMeters: number;
  readonly averageErrorYMeters: number;
}
```

---

## Web UI

### Drive Tuning Page (`/drive-tuning`)

**Layout:**
- Navigation bar (consistent with other pages)
- Status section (real-time updates)
  - Current status
  - Current target position (if driving)
  - Drives completed
  - Average errors (X, Y)
- Control section
  - Target X input (meters)
  - Target Y input (meters)
  - "Execute Single Drive" button
  - "Run Test Pattern" button (grid of test points)
  - "Train Short Distances Forward/Reverse" button for straight-line learning at 5,10,15,20,25,30,35,40,45,50,55,60,70,80,90,100cm plus longer shared-brake sample runs at 2m, 3m, and 4m
  - "Train Segments Forward/Reverse" button for 105cm to 6m segment learning from a fixed start line
  - **Red "STOP" button** (prominent)
- Learning parameters section
  - Display current brake distance
  - Display current CTE gain
  - Display encoder calibration
  - "Reset Learning" button
- Segment learning results section
  - Live progress feed while the segment learner is running
  - Results table for each segment run showing distance, direction, error and status
- History section
  - Table with columns: timestamp, target, final, errorX, errorY, maxCTE, status
  - Color-coded by status (green=success, red=error, yellow=stopped)
  - "Clear History" button

### Segment Testing Page (`/segment-testing`)

**Layout:**
- Navigation bar (consistent with other pages)
- Live IMU and GNSS widgets in a left sidebar, pinned while scrolling
- Control section
  - "Run Segment Test" button
  - Red "STOP" button
- Status section
  - Current phase
  - Waypoints collected
  - Segment runs completed
  - Current target label
- Results section
  - Table with columns: time, type, waypoint, distance, required heading change, achieved heading change, drive quality, CTE, X error, Y error
  - Live results while the test harness is running

**Test flow:**
- Collect 7 rough waypoints by taking a live pose, driving forward for about 3 seconds, stopping, settling, and then sampling the next pose along the line
- Drive first back to the earliest waypoint using the segment controller
- Then run 10 further test segments to random non-nearest waypoints using the same segment controller
- Preserve the existing turn and drive controllers; the page is only a harness around them

**Test Pattern:**
- Grid of target positions at 5m, 10m, 20m distances
- Multiple angles: 0°, 45°, 90°, 135°, 180°, etc.
- Example: (5,0), (0,5), (-5,0), (0,-5), (10,0), etc.

**Real-time updates:**
- Poll `/api/drive/status` at 1Hz
- Update status display, history table

---

## API Endpoints

```
GET  /drive-tuning                    # Serve drive tuning web page
GET  /segment-testing                 # Serve segment testing web page
GET  /api/drive/status                # Get controller state and history
GET  /api/segment/status              # Get segment test state and history
POST /api/drive/execute               # Execute single drive
POST /api/drive/test-pattern          # Run test pattern sequence
POST /api/drive/train-short           # Run short-drive learning sequence
POST /api/drive/train-segment         # Run segment-drive learning sequence
POST /api/segment/start               # Run segment testing harness
POST /api/segment/stop                # Stop current segment test
POST /api/drive/stop                  # Emergency stop current drive
POST /api/drive/clear-history         # Clear drive history
POST /api/drive/reset-learning        # Reset learning parameters to defaults
```

**Request/Response formats:**

```typescript
// POST /api/drive/execute
{
  targetX: number;
  targetY: number;
}
// Response: DriveResult

// GET /api/drive/status
{
  state: DriveControllerState;
  history: DriveResult[];
  parameters: DriveParameters;
}
```

---

## Constants

Add to `src/constants.ts`:

```typescript
// Drive controller
export const DRIVE_SETTLE_TIME_MS = 200;
export const DRIVE_INITIAL_TURN_THRESHOLD_DEG = 5;
export const DRIVE_TIMEOUT_MULTIPLIER = 3;
export const DRIVE_HISTORY_MAX_SIZE = 50;
export const DRIVE_FULL_SPEED_COMMAND_DEFAULT = 1.0; // Motor command (dimensionless)

// Drive learning defaults
export const DRIVE_BRAKE_DISTANCE_DEFAULT_METERS = 2.0;
export const DRIVE_CTE_GAIN_DEFAULT = 0.3;
export const DRIVE_MIN_DISTANCE_FOR_LEARNING_METERS = 3.0;
export const ENCODER_METERS_PER_TICK_DEFAULT = 0.001;

// Drive target CTE for tuning
export const DRIVE_TARGET_CTE_METERS = 0.05; // 5cm
```

---

## Testing Strategy

### Unit Tests (`test/driveController.test.js`)

**Test cases:**
1. Execute 5m straight drive successfully
2. Execute drive with initial turn (>5° off)
3. Emergency stop during drive
4. CTE correction when pushed off line
5. Track drive history
6. Event subscription cleanup on error paths
7. Timeout handling
8. Short drive skips learning

**Mock pattern:**
```javascript
function createMockPoseFusion() {
  const emitter = new EventEmitter();
  let currentPose = { position: { xMeters: 0, yMeters: 0 }, heading: 0, quality: "gnss" };
  
  return {
    getCurrentPose: () => currentPose,
    setPosition: (pos) => { currentPose.position = pos; },
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    _testEmitPoseUpdate: (pose) => emitter.emit('poseUpdate', pose),
  };
}
```

### Integration Tests

**Hardware test sequence:**
1. Place mower at known position
2. Set 5m target north
3. Execute drive
4. Verify arrival within 10cm (X and Y)
5. Repeat 10 times, verify learning improves accuracy

---

## Error Handling

**All error paths must:**
1. Unsubscribe from pose events (prevent memory leaks)
2. Stop motors (safety)
3. Return to idle state
4. Log error with context
5. Resolve promise with error result

**Pattern:**
```typescript
let subscribed = false;
try {
  this.poseFusion.on('poseUpdate', this.onPoseUpdate);
  subscribed = true;
  // ... operation
} catch (error) {
  if (subscribed) {
    this.poseFusion.off('poseUpdate', this.onPoseUpdate);
  }
  await this.sensorController.stopMotors();
  this.status = "idle";
  this.currentDrive = null;
  resolve(errorResult);
}
```

---

## Future Enhancements

1. **Terrain slope compensation**: Use IMU pitch angle to adjust brake distance dynamically
2. **Path planning**: Multi-waypoint paths with continuous driving
3. **Obstacle avoidance**: Integrate with future obstacle detection
4. **Short drive optimization**: Separate control strategy for drives <3m
5. **Speed profiles**: Ramp up/down instead of full speed for smoother operation
6. **Advanced CTE correction**: PID controller instead of P-only
7. **Predictive braking**: Use velocity feedback to predict stopping point more accurately

---

## References

- Functional Specification: `docs/functional-specification.md` (lines 262-330)
- Turn Controller Design: `docs/TURN-CONTROLLER-DESIGN.md`
- System Map: `docs/system-map.md`
- Sensor Events: `src/sensing/sensorEvents.ts`
- Heading Types: `src/geometry/headingTypes.ts`
