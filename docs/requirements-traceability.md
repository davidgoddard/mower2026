# Feature Matrix

Status values:

- `NOT MET`
- `PARTIALLY MET`
- `FULLY MET`

This document is the central place to track:

- implemented capability
- remaining implementation work
- unresolved decisions
- missing hardware data

## Requirement And Feature Status

| Requirement | Status | Evidence | Remaining implementation | Open decision or missing data |
| --- | --- | --- | --- | --- |
| FR-001 Runtime architecture | PARTIALLY MET | `RuntimeApp` performs a full control cycle using node clients, adapters, estimator, guidance, control, safety, and logging; `pi-app/core_server.js` now provides a first shared operator shell with `manual`, `site_capture`, and `autonomous` modes | Move more runtime logic out of ad hoc Node scripts into typed app modules and add a stable production start-up path | Final production runtime boundary for calibration and autonomy execution |
| FR-002 Node responsibilities | PARTIALLY MET | Protocol/node boundaries plus GNSS and motor firmware specs documented | Complete GNSS and motor ESP firmware rewrites | None beyond firmware completion |
| FR-003 Transport abstraction | PARTIALLY MET | `BusAdapter`, `InMemoryBusAdapter`, `I2cBusAdapter`, `frameCodec`, and CRC utilities implemented | Validate real Pi I2C transport under sustained live polling | Whether CAN transport will be added in the next phase or later |
| FR-004 Motor command boundary | PARTIALLY MET | Motor command types, binary codec, `PollingMotorNodeClient`, and motor firmware spec define explicit wheel targets | Complete motor firmware execution path and confirm acknowledgements/watchdog behavior on hardware | Final wheel-speed controller structure and gains on the motor ESP |
| FR-005 Motor feedback boundary | PARTIALLY MET | Motor feedback types, binary codec, `PollingMotorNodeClient`, `motorFeedbackAdapter`, and motor firmware spec define encoder/speed/PWM/fault data | Complete firmware production of all feedback fields and validate scaling on hardware | Exact motor-to-wheel gear ratio, final wheel circumference, current-sense availability, final PWM feedback unit |
| FR-006 GNSS measurement boundary | PARTIALLY MET | GNSS protocol types, binary codec, protocol docs, `PollingGnssNodeClient`, and `gnssAdapter` define compact sample exchange; GNSS firmware spec fixes the local frame to base-station origin | Complete GNSS firmware production path and confirm freshness/heading behavior on hardware | Whether `UNIHEADINGB` is needed continuously, final heading-accuracy source, whether raw lat/lon should remain available for diagnostics |
| FR-007 State estimation | PARTIALLY MET | `PoseEstimator` integrates wheel odometry, GNSS position/heading, and IMU yaw-rate inputs; mixed timestamp-domain bug fixed | Add uncertainty propagation, stationary heading policy, and better live fusion behavior | Final policy for when estimator heading should hard-lock to GNSS heading |
| FR-008 Adaptive trust | PARTIALLY MET | `AdaptiveTrust` implemented and used by `PoseEstimator` | Add innovation-based trust, slip-based trust, low-speed GNSS heading gating, and motion-state awareness | Thresholds for stationary GNSS heading trust and IMU deadband |
| FR-009 Guidance | PARTIALLY MET | `lineGeometry` and `lineTracker` implemented and unit tested | Add mission/route management and route segment progression | None |
| FR-010 Control planning | PARTIALLY MET | `wheelCommandPlanner`, `motorMapping`, and asymmetric `commandLimiter` implemented with runtime integration tests | Add richer vehicle compensation and validate manual-drive dynamics on hardware | Final trim values and stop/turn tuning values from live sessions |
| FR-011 Self-calibration | PARTIALLY MET | `CalibrationApp`, `CalibrationSupervisor`, calibration trial sequences, spin/straight/arrival metrics, and first-pass recommendation fitting are implemented and unit tested | Add a real hardware executor, parameter persistence, acceptance gating, and closed-loop profile iteration | Required clear-area procedure and acceptance thresholds |
| FR-012 Site capture | PARTIALLY MET | `src/site/siteTypes.ts` and `src/site/siteCaptureRecorder.ts` implement capture session types, automatic waypoint sampling, polygon closure, simplification, and basic validation; `pi-app/core_server.js` and `pi-app/web/core_dashboard.html` provide a first app-owned live capture flow with JSON persistence; unit tests cover perimeter and obstacle flows | Move more of the live orchestration out of plain JS into typed app modules and add site review/edit support | Final capture control mapping for `Start Perimeter`, `Start Obstacle`, `Finish Obstacle`, `Undo Last Point`, `Finish Capture`, and `Discard Capture` |
| FR-013 Site review and validation | NOT MET | No review-page workflow or polygon validation layer exists in the active codebase | Implement review models, raw-vs-simplified overlays, edit actions, and validation warnings before planning | Exact operator review flow and validation thresholds |
| FR-014 Coverage planning | PARTIALLY MET | `src/planning/orientationSearch.ts` and `src/planning/coveragePlanner.ts` now generate a first deterministic one-area stripe plan from the simplified perimeter with basic obstacle-aware lane clipping, and the core app can review/generate plans from saved sites | Add non-convex decomposition, multi-area planning, and better lane ordering | Final simplification tolerances, orientation candidate scan step, decomposition strategy, and richer obstacle treatment |
| FR-015 Mission plan representation | PARTIALLY MET | `src/planning/coverageTypes.ts` now defines coverage lanes, areas, metrics, plans, and mission-start selection output; the core app persists generated plans under `pi-app/data/plans/` | Define a more stable persisted schema, add GeoJSON export, and represent multi-area transitions explicitly | Final mission-plan schema and whether area transitions are stored as anchors or full paths |
| FR-016 Mission start selection | PARTIALLY MET | `src/planning/missionStartSelector.ts` now chooses the nearest lane endpoint with heading-change tie-break, the core app surfaces that selection from the live pose, and autonomous mode can hand the selected lane into the first executor path | Add area containment/nearest-area logic, reachability/path costs, and multi-area entry handling | Final path-cost model for area/lane entry and whether boundary-approach paths need explicit planning in v1 |
| FR-017 Mission execution | PARTIALLY MET | `src/execution/laneMissionBuilder.ts` and `src/execution/laneExecutor.ts` now decompose a selected lane into turn/drive/arrive segments, drive those segments through the existing guidance/control stack, and stop after one executed lane; `tests/execution/laneExecutor.test.ts` provides a deterministic emulator test | Add multi-lane mission flow, safety gating for degraded estimates, pause/resume, and completion/return behavior | Final executor state machine for multi-lane mowing, stop/resume policy, and whether return-to-start is part of v1 |
| FR-018 Logging and replay | PARTIALLY MET | Memory loggers, array replay reader, and JSONL live manual-drive session logs exist | Add durable telemetry schema, offline analysis tooling, capture/planning review logs, and replay utilities for field runs | Final on-disk telemetry schema and retention policy |
| FR-019 Safety | PARTIALLY MET | `RuleBasedSafetyManager` stops motion on stale inputs and fault flags; live drive supports arm/disarm | Expand safety rules for node faults, estimator confidence, operator mode, and watchdog/failsafe transitions | Final stop criteria and degraded-mode behavior |
| FR-020 Resumability | PARTIALLY MET | `current-context.md`, manual testing guide, and this feature matrix exist | Keep the matrix current as implementation advances | None |
| NFR-001 Maintainability | PARTIALLY MET | Clean module layout established and docs organized | Continue converting note-style docs into stable guides/specs | None |
| NFR-002 Testability | PARTIALLY MET | Unit tests cover core protocol/control/estimation paths | Add replay-driven tests and hardware-integration regression checks | None |
| NFR-003 Bandwidth discipline | PARTIALLY MET | Compact fixed-size payloads and packed frame encoding implemented | Validate payload sizing and polling rates against live bus occupancy | Final GNSS and motor polling rates under real load |
| NFR-004 Portability | PARTIALLY MET | Bus abstraction established | Add or defer concrete non-I2C transport implementations | Whether CAN portability is needed before autonomy |
| NFR-005 Observability | PARTIALLY MET | Runtime emits telemetry/events into tested loggers and live SSE dashboards exist | Add durable sinks, calibration summaries, site/planning review artifacts, and operator-facing health views | Final operator telemetry set and alerting thresholds |

## Open Decisions And Missing Data

| ID | Area | Current position | What is still needed | Source |
| --- | --- | --- | --- | --- |
| DEC-001 | GNSS heading diagnostics | `PVTSLNB` is the primary runtime source | Decide whether `UNIHEADINGB` stays continuous or diagnostic-only | `docs/gnss-firmware-spec.md` |
| DEC-002 | GNSS heading accuracy | Heading accuracy should be preserved separately from position quality | Decide whether the canonical source is `UNIHEADINGB`, `PVTSLN`, or a fallback hierarchy | `docs/gnss-firmware-spec.md` |
| DEC-003 | GNSS debug data | Pi-facing payload is local `x/y` only | Decide whether raw lat/lon remains available for debug endpoints/logs | `docs/gnss-firmware-spec.md` |
| DEC-004 | Motor scaling | FG pulse output is treated as provisional wheel-speed feedback | Confirm motor-to-wheel gear ratio and final counts-per-wheel-revolution scaling | `docs/motor-firmware-spec.md`, `docs/hardware-data-checklist.md` |
| DEC-005 | Motor feedback units | PWM feedback exists conceptually | Decide final representation: signed percent, raw duty step, or alternative | `docs/motor-firmware-spec.md` |
| DEC-006 | Current sensing | Motor protocol supports optional motor current fields | Confirm whether current sensing exists and on which channels | `docs/motor-firmware-spec.md`, `docs/hardware-data-checklist.md` |
| DEC-007 | Estimator stationary heading policy | Estimator blends GNSS, IMU, and odometry | Decide when stationary/low-rate heading should equal GNSS heading versus remain blended | live manual-drive behavior |
| DEC-008 | Capture and review UX | Manual drive works with arm/disarm controls | Decide final phone/controller workflow for perimeter capture, obstacle capture, review edits, and save actions | live operator workflow |
| DEC-009 | Calibration acceptance | Calibration sequence and report generation now exist | Define acceptance criteria for spin, straight-line, and stop accuracy, and decide whether the app retries profiles automatically | `docs/overview.md`, `docs/functional-specification.md` |
| DEC-010 | Transport roadmap | I2C is the current transport | Decide whether CAN support is needed before autonomous execution | `docs/architecture.md` |
| DEC-011 | Coverage planner heuristics | First one-area planner exists | Fix initial polygon simplification tolerances, coarse angle scan step, and lane scoring weights for straight length versus turn count | `src/planning/coveragePlanner.ts` |
| DEC-012 | Mission entry scoring | Nearest lane endpoint with heading tie-break exists | Decide when nearest lane endpoint is enough versus when approach-path reachability must be planned explicitly | `src/planning/missionStartSelector.ts` |
| DEC-013 | First-lane executor completion | One-lane execution exists | Decide whether v1 stops after one lane, immediately chains into the next lane, or returns to a safe hold point while multi-lane flow is being built | `src/execution/laneExecutor.ts` |

## Implementation Backlog By Area

| Area | Current state | Next concrete step |
| --- | --- | --- |
| Live manual drive | Working bring-up path with phone viewer and session logging | Validate combined GNSS + IMU + motor behavior under real motion |
| GNSS firmware | Specified but not completed | Implement compact sample production and verify observed rates/quality |
| Motor firmware | Specified but not completed | Implement explicit wheel-target command execution and coherent feedback snapshot |
| Estimation | Basic fusion implemented | Add stationary heading policy, uncertainty, and richer trust logic |
| Calibration | First-pass sequence, metrics, and report implemented | Add the real hardware trial executor and parameter write-back flow |
| Site capture | Domain recorder plus first live server/page implemented | Move capture persistence and orchestration out of the manual-test boundary into a stable app layer |
| Site review | Not implemented | Add a review page with raw path, simplified polygon, obstacle editing, and validation warnings |
| Coverage planning | First deterministic one-area planner with basic obstacle clipping implemented | Add non-convex decomposition and export/review tooling |
| Mission execution | Mission-start selection and first single-lane execution implemented | Extend the executor from one selected lane to full multi-lane mission flow with completion handling |
