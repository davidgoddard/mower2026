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
| FR-001 Runtime architecture | PARTIALLY MET | `RuntimeApp` now performs a full control cycle using node clients, adapters, estimator, guidance, control, safety, and logging | Add multi-mode orchestration, persistent runtime entrypoints, and scheduling | Final production runtime boundary for manual drive, calibration, and autonomy |
| FR-002 Node responsibilities | PARTIALLY MET | Protocol/node boundaries plus GNSS and motor firmware specs documented | Complete GNSS and motor ESP firmware rewrites | None beyond firmware completion |
| FR-003 Transport abstraction | PARTIALLY MET | `BusAdapter`, `InMemoryBusAdapter`, `I2cBusAdapter`, `frameCodec`, and CRC utilities implemented | Validate real Pi I2C transport under sustained live polling | Whether CAN transport will be added in the next phase or later |
| FR-004 Motor command boundary | PARTIALLY MET | Motor command types, binary codec, `PollingMotorNodeClient`, and motor firmware spec define explicit wheel targets | Complete motor firmware execution path and confirm acknowledgements/watchdog behavior on hardware | Final wheel-speed controller structure and gains on the motor ESP |
| FR-005 Motor feedback boundary | PARTIALLY MET | Motor feedback types, binary codec, `PollingMotorNodeClient`, `motorFeedbackAdapter`, and motor firmware spec define encoder/speed/PWM/fault data | Complete firmware production of all feedback fields and validate scaling on hardware | Exact motor-to-wheel gear ratio, final wheel circumference, current-sense availability, final PWM feedback unit |
| FR-006 GNSS measurement boundary | PARTIALLY MET | GNSS protocol types, binary codec, protocol docs, `PollingGnssNodeClient`, and `gnssAdapter` define compact sample exchange; GNSS firmware spec fixes the local frame to base-station origin | Complete GNSS firmware production path and confirm freshness/heading behavior on hardware | Whether `UNIHEADINGB` is needed continuously, final heading-accuracy source, whether raw lat/lon should remain available for diagnostics |
| FR-007 State estimation | PARTIALLY MET | `PoseEstimator` integrates wheel odometry, GNSS position/heading, and IMU yaw-rate inputs; mixed timestamp-domain bug fixed | Add uncertainty propagation, stationary heading policy, and better live fusion behavior | Final policy for when estimator heading should hard-lock to GNSS heading |
| FR-008 Adaptive trust | PARTIALLY MET | `AdaptiveTrust` implemented and used by `PoseEstimator` | Add innovation-based trust, slip-based trust, low-speed GNSS heading gating, and motion-state awareness | Thresholds for stationary GNSS heading trust and IMU deadband |
| FR-009 Guidance | PARTIALLY MET | `lineGeometry` and `lineTracker` implemented and unit tested | Add mission/route management and route segment progression | None |
| FR-010 Control planning | PARTIALLY MET | `wheelCommandPlanner`, `motorMapping`, and asymmetric `commandLimiter` implemented with runtime integration tests | Add richer vehicle compensation and validate manual-drive dynamics on hardware | Final trim values and stop/turn tuning values from live sessions |
| FR-011 Self-calibration | PARTIALLY MET | Parameter schema/defaults distinguish provisional physical assumptions; manual-drive logging path exists | Build calibration app, test sequencing, fitting, acceptance rules, and reports | Required clear-area procedure and acceptance thresholds |
| FR-012 Manual route capture and replay | NOT MET | Live manual-drive server and controller path exist, but waypoint capture/replay logic does not | Implement waypoint marking, route storage, route replay, and operator workflow | Final button/UI flow for waypoint marking and replay |
| FR-013 Logging and replay | PARTIALLY MET | Memory loggers, array replay reader, and JSONL live manual-drive session logs exist | Add durable telemetry schema, offline analysis tooling, and replay utilities for field runs | Final on-disk telemetry schema and retention policy |
| FR-014 Safety | PARTIALLY MET | `RuleBasedSafetyManager` stops motion on stale inputs and fault flags; live drive supports arm/disarm | Expand safety rules for node faults, estimator confidence, operator mode, and watchdog/failsafe transitions | Final stop criteria and degraded-mode behavior |
| FR-015 Resumability | PARTIALLY MET | `current-context.md`, manual testing guide, and this feature matrix exist | Keep the matrix current as implementation advances | None |
| NFR-001 Maintainability | PARTIALLY MET | Clean module layout established and docs organized | Continue converting note-style docs into stable guides/specs | None |
| NFR-002 Testability | PARTIALLY MET | Unit tests cover core protocol/control/estimation paths | Add replay-driven tests and hardware-integration regression checks | None |
| NFR-003 Bandwidth discipline | PARTIALLY MET | Compact fixed-size payloads and packed frame encoding implemented | Validate payload sizing and polling rates against live bus occupancy | Final GNSS and motor polling rates under real load |
| NFR-004 Portability | PARTIALLY MET | Bus abstraction established | Add or defer concrete non-I2C transport implementations | Whether CAN portability is needed before autonomy |
| NFR-005 Observability | PARTIALLY MET | Runtime emits telemetry/events into tested loggers and live SSE dashboards exist | Add durable sinks, reports, calibration summaries, and operator-facing health views | Final operator telemetry set and alerting thresholds |

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
| DEC-008 | Controller and route UX | Manual drive works with arm/disarm controls | Decide final controller/button workflow for waypoint marking, replay, and calibration actions | live operator workflow |
| DEC-009 | Calibration acceptance | Calibration phase is planned but not implemented | Define acceptance criteria for spin, straight-line, and stop accuracy | `docs/overview.md`, `docs/functional-specification.md` |
| DEC-010 | Transport roadmap | I2C is the current transport | Decide whether CAN support is needed before autonomous execution | `docs/architecture.md` |

## Implementation Backlog By Area

| Area | Current state | Next concrete step |
| --- | --- | --- |
| Live manual drive | Working bring-up path with phone viewer and session logging | Validate combined GNSS + IMU + motor behavior under real motion |
| GNSS firmware | Specified but not completed | Implement compact sample production and verify observed rates/quality |
| Motor firmware | Specified but not completed | Implement explicit wheel-target command execution and coherent feedback snapshot |
| Estimation | Basic fusion implemented | Add stationary heading policy, uncertainty, and richer trust logic |
| Calibration | Planned only | Build calibration supervisor and first spin/straight test sequence |
| Route capture | Not implemented | Add waypoint marking and route persistence on top of live manual drive |
| Replay and autonomy | Not implemented | Add route replay runtime after manual-drive and calibration paths stabilize |
