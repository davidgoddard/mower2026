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
- Update IMU base heading from stable GNSS heading samples
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
  ├── driveController.ts          # Main drive execution controller
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
  
  // Emits 'poseUpdate' event at sensor rate (30Hz)
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

### 3. Drive Controller (`src/control/driveController.ts`)

#### Responsibilities
- Execute point-to-point drive maneuvers
- Monitor position and CTE during drives
- Apply learned brake distance and CTE correction
- Update learning model with results
- Coordinate with turn controller for initial turn

#### State Machine

```
IDLE → TURNING → SETTLING → DRIVING → BRAKING → SETTLING → MEASURING → LEARNING → IDLE
         ↓
      STOPPED (emergency stop) → IDLE
```

**States:**
1. **IDLE** - Ready for new drive command
2. **TURNING** - Calling turn controller to face target (if needed)
3. **SETTLING** - Waiting after turn for stability
4. **DRIVING** - Motors engaged, monitoring CTE and distance
5. **BRAKING** - Motors commanded to zero, waiting for ramp-down
6. **SETTLING** - Additional settle time after braking
7. **MEASURING** - Reading final position, computing errors
8. **LEARNING** - Updating parameters based on errors
9. **STOPPED** - Emergency stop requested, motors halted immediately

**Emergency Stop Behavior:**
- User or system can call `stopCurrentDrive()` at any time
- Stop flag checked in event handler (every position update)
- Motors stopped immediately, unsubscribe from events
- No learning occurs on stopped drives
- Result returned with status="stopped"
- Controller returns to IDLE state

#### Event-Driven Execution

**Scoped subscription pattern** (matching turn controller):
```typescript
async executeDrive(request: DriveRequest): Promise<DriveResult> {
  return new Promise<DriveResult>(async (resolve) => {
    let subscribed = false;
    
    try {
      // 1. Get current pose
      const startPose = this.poseFusion.getCurrentPose();
      
      // 2. Calculate angle to target
      const angleToTarget = angleTo(startPose.position, request.targetPosition);
      const headingError = headingDifference(startPose.heading, angleToTarget);
      
      // 3. If >5 degrees, turn to face target
      if (Math.abs(unwrapRelativeAngle(headingError)) > DRIVE_INITIAL_TURN_THRESHOLD_DEG) {
        this.status = "turning";
        await this.turnController.executeTurn({
          targetAngle: headingError,
          direction: unwrapRelativeAngle(headingError) > 0 ? "ccw" : "cw",
          learningEnabled: true,
        });
      }
      
      // 4. Settle after turn
      this.status = "settling";
      await this.sleep(this.settleTimeMs);
      
      // 5. Get current pose again
      const drivingStartPose = this.poseFusion.getCurrentPose();
      this.driveStartPosition = drivingStartPose.position;
      this.driveStartHeading = drivingStartPose.heading;
      this.driveTargetPosition = request.targetPosition;
      
      // 6. Compute line to target
      this.driveLineStart = this.driveStartPosition;
      this.driveLineEnd = request.targetPosition;
      
      // 7. Subscribe to pose updates
      this.poseFusion.on('poseUpdate', this.onPoseUpdate);
      subscribed = true;
      
      // 8. Engage motors at full speed
      this.status = "driving";
      const fullSpeed = this.fullSpeedCommand; // 1.0 by default
      await this.sensorController.setMotorWheelOutputs(fullSpeed, fullSpeed);
      
      // Event handler will monitor and complete drive
      
    } catch (error) {
      // Cleanup on error
      if (subscribed) {
        this.poseFusion.off('poseUpdate', this.onPoseUpdate);
      }
      await this.sensorController.stopMotors();
      this.status = "idle";
      this.currentDrive = null;
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("drive.error", { error: errorMessage });
      
      resolve({
        startPosition: this.driveStartPosition ?? createPosition(0, 0),
        targetPosition: request.targetPosition,
        finalPosition: this.driveStartPosition ?? createPosition(0, 0),
        errorX: createMeters(0),
        errorY: createMeters(0),
        maxCteMeters: createMeters(0),
        avgCteMeters: createMeters(0),
        durationMs: 0,
        brakeDistanceUsed: createMeters(0),
        status: "error",
        errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  });
}
```

#### Position Update Event Handler

Called at 30Hz during drive:

```typescript
private async onPoseUpdate(pose: Pose): Promise<void> {
  if (this.status !== "driving" || !this.driveStartPosition || !this.driveTargetPosition) {
    return;
  }
  
  // Check for emergency stop
  if (this.stopRequested) {
    this.poseFusion.off('poseUpdate', this.onPoseUpdate);
    await this.sensorController.stopMotors();
    this.status = "stopped";
    // ... complete with stopped result
    return;
  }
  
  const currentPosition = pose.position;
  
  // Calculate CTE
  const cte = crossTrackError(currentPosition, this.driveLineStart, this.driveLineEnd);
  this.cteSamples.push(cte);
  
  // Calculate remaining distance
  const remainingDistance = distanceBetween(currentPosition, this.driveTargetPosition);
  
  // Apply CTE correction (asymmetric - keep one wheel at max, slow the other)
  await this.applyCteCorrection(cte);
  
  // Check brake condition
  const brakeDistance = this.learningModel.getBrakeDistance();
  if (unwrapMeters(remainingDistance) <= unwrapMeters(brakeDistance)) {
    // Unsubscribe BEFORE completing
    this.poseFusion.off('poseUpdate', this.onPoseUpdate);
    await this.completeDrive();
  }
  
  // Timeout check
  if (this.nowMillis() - this.driveStartTime > this.calculateTimeout()) {
    this.poseFusion.off('poseUpdate', this.onPoseUpdate);
    // ... complete with timeout result
  }
}
```

#### CTE Correction

Asymmetric wheel speed adjustment:
```typescript
private async applyCteCorrection(cte: Meters): Promise<void> {
  const cteValue = unwrapMeters(cte);
  const gain = this.learningModel.getCteGain();
  
  // Positive CTE = drifting right, need to turn left
  // Keep left wheel at full speed, slow right wheel
  // Negative CTE = drifting left, need to turn right
  // Keep right wheel at full speed, slow left wheel
  
  let leftSpeed = this.fullSpeedCommand;
  let rightSpeed = this.fullSpeedCommand;
  
  if (cteValue > 0) {
    // Drifting right - slow right wheel
    rightSpeed = this.fullSpeedCommand * (1 - gain * cteValue);
  } else {
    // Drifting left - slow left wheel
    leftSpeed = this.fullSpeedCommand * (1 + gain * cteValue); // cteValue is negative
  }
  
  // Clamp speeds to [0, fullSpeedCommand]
  leftSpeed = Math.max(0, Math.min(this.fullSpeedCommand, leftSpeed));
  rightSpeed = Math.max(0, Math.min(this.fullSpeedCommand, rightSpeed));
  
  await this.sensorController.setMotorWheelOutputs(leftSpeed, rightSpeed);
}
```

#### Drive Completion

```typescript
private async completeDrive(): Promise<void> {
  try {
    // Brake
    this.status = "braking";
    await this.sensorController.stopMotors();
    
    // Wait for ramp-down
    const rampDownTime = this.learningModel.getMotorRampDownTime();
    await this.sleep(2 * rampDownTime);
    
    // Settle
    this.status = "settling";
    await this.sleep(this.settleTimeMs);
    
    // Measure final position
    this.status = "measuring";
    const finalPose = this.poseFusion.getCurrentPose();
    const finalPosition = finalPose.position;
    
    // Calculate errors
    // X error: along line to target (positive = overshot, negative = undershot)
    // Y error: perpendicular to line (CTE at arrival)
    const errorX = this.calculateXError(finalPosition);
    const errorY = crossTrackError(finalPosition, this.driveLineStart, this.driveLineEnd);
    
    // Calculate CTE statistics
    const maxCte = this.cteSamples.reduce((max, cte) => 
      Math.abs(unwrapMeters(cte)) > Math.abs(unwrapMeters(max)) ? cte : max,
      createMeters(0)
    );
    const avgCte = createMeters(
      this.cteSamples.reduce((sum, cte) => sum + Math.abs(unwrapMeters(cte)), 0) / this.cteSamples.length
    );
    
    this.logger.info("drive.completed", {
      targetPosition: this.driveTargetPosition,
      finalPosition,
      errorX: unwrapMeters(errorX),
      errorY: unwrapMeters(errorY),
      maxCte: unwrapMeters(maxCte),
      avgCte: unwrapMeters(avgCte),
      durationMs: this.nowMillis() - this.driveStartTime,
    });
    
    // Update learning model
    if (this.currentDrive?.learningEnabled !== false) {
      this.status = "learning";
      await this.learningModel.updateFromDrive({
        startPosition: this.driveStartPosition,
        targetPosition: this.driveTargetPosition,
        finalPosition,
        errorX,
        errorY,
        maxCte,
        avgCte,
        brakeDistanceUsed: this.learningModel.getBrakeDistance(),
      });
      
      // Update encoder calibration if both poses were GNSS quality
      if (this.driveStartPoseQuality === "gnss" && finalPose.quality === "gnss") {
        const actualDistance = distanceBetween(this.driveStartPosition, finalPosition);
        const encoderTicks = this.totalEncoderTicks; // accumulated during drive
        if (encoderTicks > 0) {
          const measuredMetersPerTick = unwrapMeters(actualDistance) / encoderTicks;
          const currentCalibration = this.poseFusion.getEncoderCalibration();
          const newCalibration = 0.9 * currentCalibration + 0.1 * measuredMetersPerTick;
          this.poseFusion.setEncoderCalibration(newCalibration);
          this.logger.info("drive.encoder_calibrated", {
            actualDistance: unwrapMeters(actualDistance),
            encoderTicks,
            newCalibration,
          });
        }
      }
    }
    
    // Return to idle
    this.status = "idle";
    this.currentDrive = null;
    
    const result: DriveResult = {
      startPosition: this.driveStartPosition,
      targetPosition: this.driveTargetPosition,
      finalPosition,
      errorX,
      errorY,
      maxCteMeters: maxCte,
      avgCteMeters: avgCte,
      durationMs: this.nowMillis() - this.driveStartTime,
      brakeDistanceUsed: this.learningModel.getBrakeDistance(),
      status: "success",
      timestamp: new Date().toISOString(),
    };
    
    this.addToHistory(result);
    this.driveResolve?.(result);
    
  } catch (error) {
    // ... error handling with cleanup
  }
}
```

#### X Error Calculation

X error is distance along the line from target to final position:
```typescript
private calculateXError(finalPosition: Position): Meters {
  // Project final position onto line to target
  // X error = distance from target along line (signed)
  const dx = unwrapMeters(finalPosition.xMeters) - unwrapMeters(this.driveTargetPosition.xMeters);
  const dy = unwrapMeters(finalPosition.yMeters) - unwrapMeters(this.driveTargetPosition.yMeters);
  
  // Line direction (unit vector from start to target)
  const lineLength = unwrapMeters(distanceBetween(this.driveLineStart, this.driveLineEnd));
  const lineDx = (unwrapMeters(this.driveTargetPosition.xMeters) - unwrapMeters(this.driveLineStart.xMeters)) / lineLength;
  const lineDy = (unwrapMeters(this.driveTargetPosition.yMeters) - unwrapMeters(this.driveLineStart.yMeters)) / lineLength;
  
  // Dot product gives signed distance along line
  const xError = dx * lineDx + dy * lineDy;
  return createMeters(xError);
}
```

---

### 4. Drive Learning Model (`src/control/driveLearningModel.ts`)

#### Responsibilities
- Maintain learned parameters: brake distance, CTE gain, encoder calibration
- Update parameters after each drive based on errors
- Persist parameters to JSON file
- Load parameters on startup

#### Parameters

```typescript
export interface DriveParameters {
  version: number;
  brakeDistanceMeters: number;      // Single value for full-speed drives
  cteGain: number;                   // Proportional gain for CTE correction
  minDriveDistanceForLearning: number; // Threshold for short drives (meters)
  motorRampDownTimeMs: number;       // From hardware spec
  updatedAt: string;
}
```

#### Learning Algorithm

**Brake Distance Update:**
```typescript
updateFromDrive(result: DriveUpdateData): void {
  const errorXValue = unwrapMeters(result.errorX);
  
  // Only learn from drives that likely reached full speed
  const driveDistance = unwrapMeters(distanceBetween(result.startPosition, result.targetPosition));
  if (driveDistance < this.parameters.minDriveDistanceForLearning) {
    this.logger.info("drive.learning.skipped_short_drive", { driveDistance });
    return;
  }
  
  // Update brake distance
  const alpha = 0.1; // Learning rate
  const adjustment = -errorXValue * alpha; // Negative error = undershot, need to reduce brake distance
  this.parameters.brakeDistanceMeters += adjustment;
  
  // Clamp to reasonable range
  this.parameters.brakeDistanceMeters = Math.max(0.5, Math.min(5.0, this.parameters.brakeDistanceMeters));
  
  this.logger.info("drive.learning.brake_distance_updated", {
    errorX: errorXValue,
    adjustment,
    newBrakeDistance: this.parameters.brakeDistanceMeters,
  });
}
```

**CTE Gain Update:**
```typescript
// Update CTE gain based on max CTE achieved
const maxCteValue = Math.abs(unwrapMeters(result.maxCte));
const targetCte = 0.05; // 5cm target

if (maxCteValue > targetCte * 1.5) {
  // CTE too high - increase gain
  this.parameters.cteGain *= 1.05;
} else if (maxCteValue < targetCte * 0.5) {
  // CTE very low - could decrease gain (more efficient)
  this.parameters.cteGain *= 0.98;
}

// Clamp gain
this.parameters.cteGain = Math.max(0.1, Math.min(1.0, this.parameters.cteGain));
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
      brakeDistanceMeters: 2.0,
      cteGain: 0.3,
      minDriveDistanceForLearning: 3.0,
      motorRampDownTimeMs: 700,
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
  - **Red "STOP" button** (prominent)
- Learning parameters section
  - Display current brake distance
  - Display current CTE gain
  - Display encoder calibration
  - "Reset Learning" button
- History section
  - Table with columns: timestamp, target, final, errorX, errorY, maxCTE, status
  - Color-coded by status (green=success, red=error, yellow=stopped)
  - "Clear History" button

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
GET  /api/drive/status                # Get controller state and history
POST /api/drive/execute               # Execute single drive
POST /api/drive/test-pattern          # Run test pattern sequence
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
