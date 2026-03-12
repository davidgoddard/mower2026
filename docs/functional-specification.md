# Functional Specification

## Scope

This specification defines the second-generation mower control system that runs on a Raspberry Pi and coordinates with a GNSS ESP node and a motor ESP node over a compact transport, initially I2C.

## System goals

The system shall:

- estimate mower pose, heading, speed, yaw rate, and confidence
- capture one or more mowing areas by manually driving their perimeters and obstacles
- generate deterministic coverage plans that favor long straight mowing runs and low turn counts
- begin a mowing mission from an arbitrary mower placement by selecting the best local area and lane entry
- follow straight-line route legs between planned coverage lane endpoints with bounded position and heading error
- continue operating safely through temporary GNSS degradation
- support self-calibration of turning, straight driving, and compensation parameters
- log telemetry, faults, calibration runs, and replayable test sessions
- support manually-driven capture, operator review, and autonomous execution of saved coverage plans

## Functional requirements

### FR-001 Runtime architecture

The Raspberry Pi application shall own:

- parameter storage
- telemetry and event logging
- measurement conditioning
- state estimation
- adaptive trust logic
- guidance and wheel command planning
- safety decisions above node level
- calibration supervision
- mission and mode management

### FR-002 Node responsibilities

The GNSS ESP shall own UM982 communications, RTK correction transport, GNSS decoding, heading decoding, health reporting, and compact message publication.

The motor ESP shall own PWM generation, direction control, encoder counting, wheel-speed execution, ramps, reversals, local watchdog behavior, and low-level fault reporting.

### FR-003 Transport abstraction

The Pi software shall isolate bus transport behind a common adapter so the higher layers do not depend on I2C-specific behavior.

### FR-004 Motor command boundary

The Pi shall command the motor node using explicit left and right wheel target speeds, together with command sequencing and timeout semantics.

The Pi shall not depend on vague motion verbs such as "turn left" or "go forward slowly" for normal autonomous control.

### FR-005 Motor feedback boundary

The motor node feedback shall include, at minimum:

- achieved wheel speeds
- encoder counts or deltas
- applied PWM values
- fault flags
- watchdog status

If current sensing is available, it shall be reported.

### FR-006 GNSS measurement boundary

The GNSS node shall publish compact navigation samples including, at minimum:

- position
- heading when valid
- quality or fix state
- sample freshness

The protocol shall preserve bandwidth by transmitting mower-ready values rather than verbose raw receiver messages.

### FR-007 State estimation

The Pi shall fuse GNSS, heading, IMU, and motor-derived motion into a pose estimate with uncertainty information.

### FR-008 Adaptive trust

The estimator shall adapt measurement trust according to GNSS quality, motion state, suspected slip, and innovation consistency.

### FR-009 Guidance

The guidance system shall compute line-following intent from current estimated state and route targets.

### FR-010 Control planning

The control stack shall convert vehicle intent into left/right wheel targets while applying mower-specific compensation and command limiting.

### FR-011 Self-calibration

The system shall support a supervised calibration procedure within a user-provided clear test area.

Calibration shall include:

- spin characterization
- straight-drive characterization
- forward and reverse asymmetry assessment
- validation before parameter acceptance

### FR-012 Site capture

The system shall allow an operator to manually drive the mower to capture:

- an outer perimeter polygon
- zero or more obstacle polygons
- raw capture samples for later review

Capture shall support automatic point sampling based on movement, heading change, and elapsed time so the operator does not need to mark every waypoint manually.

### FR-013 Site review and validation

The system shall allow an operator to review captured raw paths and derived polygons and shall support, at minimum:

- undoing the last captured point
- discarding the current obstacle
- rerunning polygon simplification
- surfacing validation warnings before planning

### FR-014 Coverage planning

The system shall derive a mowing plan from the captured site using a deterministic pipeline that can:

- simplify the outer perimeter and obstacle polygons
- derive free space
- evaluate candidate mowing orientations
- split strongly non-convex geometry into multiple coverage areas
- generate clipped stripe lanes
- score candidate plans using straight-run length, lane length, fragment count, and turn count

### FR-015 Mission plan representation

The mission planner output shall include, at minimum:

- coverage areas
- lane geometry
- lane endpoints
- preferred travel direction
- area transition anchors or equivalent transition metadata
- operator-inspectable export data

### FR-016 Mission start selection

When a mowing mission begins, the system shall:

- localize the mower
- determine which saved area contains the mower or is the nearest reachable area
- score valid lane-entry candidates using distance and heading-change cost
- choose a valid starting lane without assuming a fixed mission start point

The initial implementation may use nearest-lane-endpoint selection with heading-change tie-breaking.

### FR-017 Logging and replay

The system shall record sufficient telemetry and events to:

- analyze failures
- evaluate calibration quality
- replay runs offline
- compare expected and achieved behavior

### FR-018 Safety

The system shall stop or degrade behavior safely when faults, stale data, invalid state estimates, or command timeouts occur.

### FR-019 Resumability

Project progress shall be documented so future work can resume from a requirement-by-requirement status view.

## Non-functional requirements

### NFR-001 Maintainability

Modules shall have clear responsibilities and minimal coupling.

### NFR-002 Testability

Pure math, geometry, protocol codecs, and validation logic shall be unit tested.

### NFR-003 Bandwidth discipline

Message formats shall be compact and stable enough for I2C transport.

### NFR-004 Portability

Transport-independent logic shall not require redesign when the bus changes from I2C to CAN.

### NFR-005 Observability

Logging shall support fault diagnosis, calibration review, site capture review, planning review, and mission replay analysis.
