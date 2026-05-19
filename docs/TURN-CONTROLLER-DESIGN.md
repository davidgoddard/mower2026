# Turn Controller Design

## Overview

The Turn Controller is a supervised self-learning component responsible for executing precise on-the-spot turns using IMU feedback and adaptive brake-point tuning.

## Requirements (from Functional Spec)

### Core Functionality
- Execute turns on the spot using counter-rotating wheels at full speed
- Use **IMU heading only** (not GNSS) for feedback
- Learn optimal brake points to minimize arrival error
- Handle both large turns (180°) and small turns (10°)
- Every turn improves future accuracy through parameter adaptation

### Learning Behavior
- Monitor heading during turn execution
- Predict when to brake based on learned brake distance
- Measure arrival error after motor ramp-down
- Adjust brake angle parameters to reduce future errors
- Persist learned parameters for next turn

### Special Considerations
- **Small angle challenge**: For turns <~20°, brake distance may exceed turn angle
- **Motor engagement**: Even for small angles, motors must engage to initiate movement
- **Ramp-down time**: Motors have asymmetric ramp rates (460ms up, 700ms down per hardware docs)

---

## Architecture

### Component Structure

```
src/control/
  ├── turnController.ts          # Main turn execution controller
  ├── turnControllerTypes.ts     # Type definitions
  └── turnLearningModel.ts       # Adaptive parameter learning

test/
  └── turnController.test.js     # Unit tests

docs/
  └── TURN-CONTROLLER-DESIGN.md  # This document
```

### Dependencies

```typescript
import { SensorController } from "../sensing/sensorController.js";
import { SessionLogger } from "../logging/index.js";
import {
  InternalHeading,
  RelativeAngle,
  createRelativeAngle,
  headingDifference,
  addRelativeAngle,
  unwrapRelativeAngle,
} from "../geometry/headingTypes.js";
```

---

## Detailed Design

### 1. Turn Controller (`src/control/turnController.ts`)

#### Responsibilities
- Execute turn maneuvers
- Monitor IMU heading during turns
- Apply learned brake points
- Update learning model with results

#### State Machine

```
IDLE → STARTING → TURNING → BRAKING → SETTLING → MEASURING → IDLE
                     ↓
                  STOPPED (emergency stop) → IDLE
```

**States:**
1. **IDLE** - Ready for new turn command
2. **STARTING** - Recording initial heading, engaging motors
3. **TURNING** - Monitoring heading, waiting for brake point
4. **BRAKING** - Motors commanded to zero, waiting for ramp-down
5. **SETTLING** - Additional settle time for vibrations to stop
6. **MEASURING** - Reading final heading, computing error
7. **LEARNING** (sub-state) - Updating parameters based on error
8. **STOPPED** - Emergency stop requested, motors halted immediately

**Emergency Stop Behavior:**
- User or system can call `stopCurrentTurn()` at any time
- Stop is checked during polling loop in TURNING state (every 33ms)
- Motors stopped immediately, no learning occurs
- Result returned with status="stopped"
- Controller returns to IDLE state

#### Interface

```typescript
interface TurnControllerOptions {
  sensorController: SensorController;
  logger: SessionLogger;
  learningModel: TurnLearningModel;
  maxWheelOutputPercent?: number;
  pollingIntervalMs?: number;
  settleTimeMs?: number;
  nowMillis?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

interface TurnRequest {
  targetAngle: RelativeAngle;  // Desired turn angle
  direction: "ccw" | "cw";      // Counter-clockwise or clockwise
  learningEnabled?: boolean;    // Default true
}

interface TurnResult {
  requestedAngle: RelativeAngle;
  achievedAngle: RelativeAngle;
  errorAngle: RelativeAngle;
  durationMs: number;
  brakeAngleUsed: RelativeAngle;
  motorEngaged: boolean;
  status: "success" | "timeout" | "error";
  errorMessage?: string;
}

export class TurnController {
  async executeTurn(request: TurnRequest): Promise<TurnResult>;
  async runTuningSequence(iterations?: number): Promise<TurnResult[]>;
  async stopCurrentTurn(): Promise<void>;  // Emergency stop
  getState(): TurnControllerState;
  getTurnHistory(): TurnResult[];
  clearHistory(): void;
}
```

#### Algorithm

```typescript
async executeTurn(request: TurnRequest): Promise<TurnResult> {
  // 1. STARTING - Record initial state
  this.currentTurn = request;
  this.status = "starting";
  const startHeading = this.sensorController.getHeading();
  const startTime = this.nowMillis();
  
  // 2. Get predicted brake angle from learning model
  const absAngle = Math.abs(unwrapRelativeAngle(request.targetAngle));
  const brakeAngle = this.learningModel.getBrakeAngle(absAngle, request.direction);
  
  // 3. Check if this is a "small angle" case
  const isSmallAngle = absAngle < this.learningModel.getSmallAngleThreshold();
  
  // 4. TURNING - Engage motors at full speed
  this.status = "turning";
  const wheelSpeed = this.maxWheelSpeed;
  if (request.direction === "ccw") {
    await this.sensorController.setMotorWheelOutputs(-wheelSpeed, wheelSpeed);
  } else {
    await this.sensorController.setMotorWheelOutputs(wheelSpeed, -wheelSpeed);
  }
  
  // 5. Monitor heading until brake point
  let currentHeading = startHeading;
  let angularProgress = createRelativeAngle(0);
  
  while (this.running) {
    await this.sleep(this.pollingIntervalMs);
    
    // Check for emergency stop
    if (this.stopRequested) {
      await this.sensorController.stopMotors();
      this.status = "stopped";
      this.currentTurn = null;
      this.stopRequested = false;
      return {
        requestedAngle: request.targetAngle,
        achievedAngle: createRelativeAngle(0),
        errorAngle: createRelativeAngle(0),
        durationMs: this.nowMillis() - startTime,
        brakeAngleUsed: brakeAngle,
        motorEngaged: false,
        status: "stopped",
        errorMessage: "Turn stopped by user request",
        timestamp: new Date().toISOString(),
      };
    }
    
    currentHeading = this.sensorController.getHeading();
    angularProgress = headingDifference(startHeading, currentHeading);
    
    const absProgress = Math.abs(unwrapRelativeAngle(angularProgress));
    
    // For small angles, engage motors briefly even if brake angle is large
    if (isSmallAngle && absProgress >= absAngle * 0.5) {
      break; // Brake at halfway point for small angles
    }
    
    // Normal case: brake when we reach the brake angle
    if (absProgress >= unwrapRelativeAngle(brakeAngle)) {
      break;
    }
    
    // Safety: timeout after reasonable duration
    if (this.nowMillis() - startTime > this.calculateTimeout(absAngle)) {
      this.status = "idle";
      this.currentTurn = null;
      return this.createTimeoutResult(request, startTime);
    }
  }
  
  // 6. BRAKING - Command motors to zero
  this.status = "braking";
  await this.sensorController.stopMotors();
  const brakeTime = this.nowMillis();
  
  // 7. Wait for motor ramp-down (2x ramp-down time per spec)
  const rampDownTime = this.learningModel.getMotorRampDownTime();
  await this.sleep(2 * rampDownTime);
  
  // 8. SETTLING - Additional settle for stability
  this.status = "settling";
  await this.sleep(this.settleTimeMs);
  
  // 9. MEASURING - Read final heading
  this.status = "measuring";
  const finalHeading = this.sensorController.getHeading();
  const achievedAngle = headingDifference(startHeading, finalHeading);
  const errorAngle = headingDifference(achievedAngle, request.targetAngle);
  
  // 10. LEARNING - Update model if enabled
  if (request.learningEnabled !== false) {
    this.status = "learning";
    await this.learningModel.updateFromTurn({
      requestedAngle: request.targetAngle,
      achievedAngle,
      errorAngle,
      brakeAngleUsed: brakeAngle,
      direction: request.direction,
    });
  }
  
  // 11. Return to idle and return result
  this.status = "idle";
  this.currentTurn = null;
  return {
    requestedAngle: request.targetAngle,
    achievedAngle,
    errorAngle,
    durationMs: this.nowMillis() - startTime,
    brakeAngleUsed: brakeAngle,
    motorEngaged: true,
    status: "success",
    timestamp: new Date().toISOString(),
  };
}

async stopCurrentTurn(): Promise<void> {
  // Set stop flag - will be checked in next polling iteration
  if (this.currentTurn) {
    this.stopRequested = true;
    this.logger.warn("turn.stop_requested", { 
      currentTurn: this.currentTurn 
    });
  }
}
```

**Internal State Variables:**
```typescript
private status: TurnStatus = "idle";
private currentTurn: TurnRequest | null = null;
private stopRequested = false;
private running = true;
```

---

### 2. Turn Learning Model (`src/control/turnLearningModel.ts`)

#### Responsibilities
- Store and persist learned brake angles for different turn magnitudes
- Adapt parameters based on turn results
- Handle direction-specific learning (CCW vs CW may differ due to hardware)
- Provide brake angle predictions

#### Data Structure

```typescript
interface TurnParameterEntry {
  requestedAngleDeg: number;       // Bin center (10, 20, 30...)
  brakeAngleCcwDeg: number;        // Learned brake angle for CCW
  brakeAngleCwDeg: number;         // Learned brake angle for CW
  sampleCountCcw: number;          // Number of CCW turns used for learning
  sampleCountCw: number;           // Number of CW turns used for learning
  lastErrorCcwDeg: number;         // Most recent error for diagnostics
  lastErrorCwDeg: number;          // Most recent error for diagnostics
  lastUpdated: string;             // ISO timestamp
}

interface TurnLearningParameters {
  version: number;
  motorRampDownTimeMs: number;     // From hardware (700ms)
  motorRampUpTimeMs: number;       // From hardware (460ms)
  smallAngleThresholdDeg: number;  // Below this, use special handling
  learningRate: number;            // How aggressively to adapt (0-1)
  parameters: TurnParameterEntry[];
}
```

#### Angle Binning Strategy

Bin turn angles into discrete values for learning:
```typescript
const TURN_ANGLE_BINS = [
  10, 20, 30, 40, 50, 60, 70, 80, 90,
  100, 110, 120, 130, 140, 150, 160, 170, 180
];

// Map requested angle to nearest bin
function getBinForAngle(angleDeg: number): number {
  return TURN_ANGLE_BINS.reduce((prev, curr) =>
    Math.abs(curr - angleDeg) < Math.abs(prev - angleDeg) ? curr : prev
  );
}
```

#### Learning Algorithm

**Adaptive Brake Angle Update:**

```typescript
updateFromTurn(result: TurnLearningInput): void {
  const absAngle = Math.abs(unwrapRelativeAngle(result.requestedAngle));
  const bin = this.getBinForAngle(absAngle);
  const entry = this.getOrCreateEntry(bin);
  
  const errorDeg = unwrapRelativeAngle(result.errorAngle);
  const currentBrake = result.direction === "ccw" 
    ? entry.brakeAngleCcwDeg 
    : entry.brakeAngleCwDeg;
  
  // Adaptive update: reduce brake angle if we overshot, increase if undershot
  // Error > 0 means we went too far → reduce brake angle
  // Error < 0 means we didn't go far enough → increase brake angle
  const adjustment = -errorDeg * this.learningRate;
  const newBrake = currentBrake + adjustment;
  
  // Clamp brake angle to reasonable bounds
  const minBrake = bin * 0.3;  // At least 30% of turn angle
  const maxBrake = bin * 0.95; // At most 95% of turn angle
  const clampedBrake = Math.max(minBrake, Math.min(maxBrake, newBrake));
  
  // Update parameters
  if (result.direction === "ccw") {
    entry.brakeAngleCcwDeg = clampedBrake;
    entry.sampleCountCcw++;
    entry.lastErrorCcwDeg = errorDeg;
  } else {
    entry.brakeAngleCwDeg = clampedBrake;
    entry.sampleCountCw++;
    entry.lastErrorCwDeg = errorDeg;
  }
  
  entry.lastUpdated = new Date().toISOString();
  
  // Persist to disk
  this.saveParameters();
}
```

#### Initialization

```typescript
// Initial conservative brake angles (will be learned)
function createDefaultParameters(): TurnLearningParameters {
  return {
    version: 1,
    motorRampDownTimeMs: 700,    // From hardware spec
    motorRampUpTimeMs: 460,      // From hardware spec
    smallAngleThresholdDeg: 20,  // Tunable
    learningRate: 0.3,           // Conservative initial rate
    parameters: TURN_ANGLE_BINS.map(angle => ({
      requestedAngleDeg: angle,
      // Start conservatively - brake earlier than target
      brakeAngleCcwDeg: angle * 0.70,  
      brakeAngleCwDeg: angle * 0.70,
      sampleCountCcw: 0,
      sampleCountCw: 0,
      lastErrorCcwDeg: 0,
      lastErrorCwDeg: 0,
      lastUpdated: new Date().toISOString(),
    })),
  };
}
```

#### Persistence

```typescript
// Location: config/turn-learning-parameters.json
async saveParameters(): Promise<void> {
  const json = JSON.stringify(this.parameters, null, 2);
  await fs.writeFile(this.parametersPath, json, "utf-8");
}

async loadParameters(): Promise<void> {
  try {
    const json = await fs.readFile(this.parametersPath, "utf-8");
    this.parameters = JSON.parse(json);
    this.logger.info("turn.learning.loaded", { 
      bins: this.parameters.parameters.length 
    });
  } catch (error) {
    this.logger.warn("turn.learning.load_failed", { 
      error: String(error) 
    });
    this.parameters = createDefaultParameters();
  }
}
```

---

### 3. Type Definitions (`src/control/turnControllerTypes.ts`)

```typescript
export type TurnDirection = "ccw" | "cw";

export type TurnStatus = 
  | "idle" 
  | "starting" 
  | "turning" 
  | "braking" 
  | "settling" 
  | "measuring" 
  | "learning"
  | "stopped";  // Emergency stop state

export interface TurnRequest {
  readonly targetAngle: RelativeAngle;
  readonly direction: TurnDirection;
  readonly learningEnabled?: boolean;
}

export interface TurnResult {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly durationMs: number;
  readonly brakeAngleUsed: RelativeAngle;
  readonly motorEngaged: boolean;
  readonly status: "success" | "timeout" | "error" | "stopped";
  readonly errorMessage?: string;
  readonly timestamp: string;
}

export interface TurnControllerState {
  readonly status: TurnStatus;
  readonly currentTurn: TurnRequest | null;
  readonly turnsCompleted: number;
  readonly averageErrorDeg: number;
}

export interface TurnLearningInput {
  readonly requestedAngle: RelativeAngle;
  readonly achievedAngle: RelativeAngle;
  readonly errorAngle: RelativeAngle;
  readonly brakeAngleUsed: RelativeAngle;
  readonly direction: TurnDirection;
}
```

---

## Design Constants

Add to `src/constants.ts`:

```typescript
// =============================================================================
// TURN CONTROLLER PARAMETERS - Design decisions
// =============================================================================

/**
 * Turn controller polling interval in milliseconds
 * How often to check heading during turn execution
 * Matches sensor polling rate - no benefit to polling faster than sensor updates
 */
export const TURN_POLLING_INTERVAL_MS = 33; // 30Hz

/**
 * Settle time after motor ramp-down before reading final heading
 */
export const TURN_SETTLE_TIME_MS = 200;

/**
 * Motor ramp-down time from hardware spec (milliseconds)
 */
export const MOTOR_RAMP_DOWN_TIME_MS = 700;

/**
 * Motor ramp-up time from hardware spec (milliseconds)
 */
export const MOTOR_RAMP_UP_TIME_MS = 460;

/**
 * Small angle threshold - below this, use special handling (degrees)
 */
export const TURN_SMALL_ANGLE_THRESHOLD_DEG = 20;

/**
 * Learning rate for brake angle adaptation (0-1)
 * Higher = faster learning but less stable
 */
export const TURN_LEARNING_RATE = 0.3;

/**
 * Turn timeout safety multiplier
 * Timeout = (angle / expected_rotation_rate) * multiplier
 */
export const TURN_TIMEOUT_MULTIPLIER = 3.0;

/**
 * Default angle bins for turn learning (degrees)
 */
export const TURN_ANGLE_BINS = [
  10, 20, 30, 40, 50, 60, 70, 80, 90,
  100, 110, 120, 130, 140, 150, 160, 170, 180
];
```

---

## Web Interface

### API Endpoints

```typescript
// GET /api/turn/status
interface TurnStatusResponse {
  state: TurnControllerState;
  history: TurnResult[];      // Recent turns
  learningParams: {
    version: number;
    parameters: TurnParameterEntry[];
  };
}

// POST /api/turn/execute
interface TurnExecuteRequest {
  angleDeg: number;  // Signed: positive=CCW, negative=CW
  enableLearning?: boolean;
}

// POST /api/turn/tune
interface TurnTuneRequest {
  iterations?: number;  // Default 1
  anglesToTest?: number[];  // Default: all bins
}

// POST /api/turn/stop
// Immediately stops current turn if one is executing
// Returns: { stopped: boolean }

// POST /api/turn/reset-learning
// Resets learned parameters to defaults

// GET /api/turn/parameters
// Returns current learning parameters
```

### UI Components

**Turn Tuning Tab** (`src/server/turnTuningPage.ts`):

```html
<div id="turn-tuning">
  <!-- Control Panel -->
  <div class="controls">
    <button id="run-tuning">Run Tuning Sequence</button>
    <input type="number" id="iterations" value="1" min="1" max="10">
    <button id="stop-turn" class="danger">STOP</button>
    <button id="reset-learning">Reset Learning</button>
  </div>
  
  <!-- Results Table -->
  <table id="turn-results">
    <thead>
      <tr>
        <th>Direction</th>
        <th>10°</th>
        <th>20°</th>
        <th>30°</th>
        <!-- ... up to 180° -->
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>CCW</td>
        <td class="result" data-angle="10" data-dir="ccw">
          <div class="requested">10.0°</div>
          <div class="achieved">-</div>
          <div class="error">-</div>
        </td>
        <!-- ... -->
      </tr>
      <tr>
        <td>CW</td>
        <td class="result" data-angle="10" data-dir="cw">
          <div class="requested">-10.0°</div>
          <div class="achieved">-</div>
          <div class="error">-</div>
        </td>
        <!-- ... -->
      </tr>
    </tbody>
  </table>
  
  <!-- Learning Parameters Visualization -->
  <div id="learning-params">
    <h3>Learned Brake Angles</h3>
    <canvas id="brake-angle-chart"></canvas>
  </div>
</div>
```

**JavaScript** (client-side):

```typescript
async function runTuningSequence() {
  const iterations = document.getElementById("iterations").value;
  const response = await fetch("/api/turn/tune", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iterations: parseInt(iterations) }),
  });
  
  const results = await response.json();
  updateResultsTable(results);
}

function updateResultsTable(results: TurnResult[]) {
  results.forEach(result => {
    const angle = Math.abs(unwrapRelativeAngle(result.requestedAngle));
    const dir = unwrapRelativeAngle(result.requestedAngle) > 0 ? "ccw" : "cw";
    const cell = document.querySelector(
      `.result[data-angle="${angle}"][data-dir="${dir}"]`
    );
    
    if (cell) {
      const achieved = unwrapRelativeAngle(result.achievedAngle).toFixed(1);
      const error = unwrapRelativeAngle(result.errorAngle).toFixed(1);
      
      cell.querySelector(".achieved").textContent = `${achieved}°`;
      cell.querySelector(".error").textContent = `${error}°`;
      
      // Color code based on error magnitude
      const absError = Math.abs(parseFloat(error));
      cell.className = "result " + (
        absError < 1 ? "excellent" :
        absError < 3 ? "good" :
        absError < 5 ? "fair" : "poor"
      );
    }
  });
}
```

**CSS**:

```css
.result.excellent { background-color: #d4edda; }
.result.good { background-color: #d1ecf1; }
.result.fair { background-color: #fff3cd; }
.result.poor { background-color: #f8d7da; }

.result .achieved { font-weight: bold; }
.result .error { font-size: 0.9em; color: #666; }
```

---

## Testing Strategy

### Unit Tests (`test/turnController.test.js`)

```javascript
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TurnController } from "../dist/control/turnController.js";

describe("TurnController", () => {
  it("executes a 90° CCW turn successfully", async () => {
    const mockSensor = createMockSensorController();
    const controller = new TurnController({ sensorController: mockSensor });
    
    const result = await controller.executeTurn({
      targetAngle: createRelativeAngle(90),
      direction: "ccw",
    });
    
    assert.equal(result.status, "success");
    assert.equal(Math.abs(unwrapRelativeAngle(result.errorAngle)) < 5, true);
  });
  
  it("handles small angle turns (10°)", async () => {
    // Test that motors engage even for small angles
  });
  
  it("learns from turn errors", async () => {
    // Verify brake angle adaptation
  });
  
  it("persists and loads learning parameters", async () => {
    // Test persistence
  });
  
  it("stops turn immediately on stopCurrentTurn()", async () => {
    const mockSensor = createMockSensorController();
    const controller = new TurnController({ sensorController: mockSensor });
    
    const turnPromise = controller.executeTurn({
      targetAngle: createRelativeAngle(180),
      direction: "ccw",
    });
    
    // Stop after 100ms
    setTimeout(() => controller.stopCurrentTurn(), 100);
    
    const result = await turnPromise;
    assert.equal(result.status, "stopped");
    assert.equal(result.errorMessage, "Turn stopped by user request");
  });
});
```

### Integration Tests

1. **Hardware-in-loop**: Run tuning sequence on physical mower
2. **Simulation**: Mock IMU with realistic dynamics
3. **Regression**: Verify learning doesn't degrade over iterations
4. **Emergency stop**: Verify stop works during all turn phases

---

## File Structure Summary

```
src/
  control/
    turnController.ts           # Main controller (300-400 lines)
    turnLearningModel.ts        # Learning model (200-300 lines)
    turnControllerTypes.ts      # Type definitions (100 lines)
  server/
    appServer.ts               # Add turn endpoints
    turnTuningPage.ts          # Turn tuning UI (new)
  constants.ts                 # Add turn constants

test/
  turnController.test.js       # Unit tests (200-300 lines)

config/
  turn-learning-parameters.json # Persisted learning data

docs/
  TURN-CONTROLLER-DESIGN.md    # This document
  system-map.md                # Update with turn controller section
```

---

## Implementation Phases

### Phase 1: Core Execution (MVP)
- ✅ Basic turn execution with fixed brake angles
- ✅ IMU heading monitoring
- ✅ Motor command integration
- ✅ Simple result logging

### Phase 2: Learning System
- ✅ Adaptive brake angle learning
- ✅ Parameter persistence
- ✅ Direction-specific tuning
- ✅ Small angle handling

### Phase 3: Web Interface
- ✅ Tuning sequence runner
- ✅ Results table visualization
- ✅ Learning parameter display
- ✅ Reset and configuration

### Phase 4: Refinement
- ✅ Extensive testing and tuning
- ✅ Documentation
- ✅ Performance optimization
- ✅ Error handling and recovery

---

## Safety Considerations

### Emergency Stop
- **User-initiated**: Via web UI "STOP" button or system failure condition
- **API endpoint**: `POST /api/turn/stop` triggers immediate halt
- **Response time**: Checked every polling interval (20ms = 50Hz)
- **Motor behavior**: Immediate stop command sent to motor controller
- **No learning**: Stopped turns don't update learning parameters
- **Safe state**: Controller returns to IDLE, ready for next command

### Timeout Protection
- Every turn has maximum duration based on angle and expected rotation rate
- Timeout multiplier (3.0x) provides safety margin
- Timeout returns error status and stops motors

### State Consistency
- `currentTurn` and `status` always reflect true controller state
- Stop flag (`stopRequested`) cleared after processing
- Motor stop commands use highest I2C bus priority (1)

### Failure Recovery
- Sensor read errors don't crash controller
- Timeout prevents infinite loops
- All errors logged with full context

---

## Open Questions for Review

1. **Learning rate**: Is 0.3 appropriate, or should it start higher and decay?
2. **Small angle threshold**: Should 20° be configurable per-mower?
3. **Direction asymmetry**: Should we assume CCW/CW differ, or start symmetric?
4. **Persistence location**: `config/` or `data/`?
5. **Timeout calculation**: Current formula reasonable for safety?

---

## Next Steps

1. Review this design document
2. Implement Phase 1 (core execution)
3. Add unit tests
4. Integrate with sensor controller
5. Test on hardware
6. Iterate based on real-world performance

This design provides a solid foundation for a self-learning turn controller that will improve over time while maintaining safety and reliability.
