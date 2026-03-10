# Requirements Traceability

Status values:

- `NOT MET`
- `PARTIALLY MET`
- `FULLY MET`

| Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- |
| FR-001 Runtime architecture | PARTIALLY MET | `RuntimeApp` now performs a full control cycle using node clients, adapters, estimator, guidance, control, safety, and logging | Still lacks multi-mode orchestration and scheduling |
| FR-002 Node responsibilities | PARTIALLY MET | Protocol/node boundaries plus GNSS and motor firmware specs documented | ESP firmware redesign not started |
| FR-003 Transport abstraction | PARTIALLY MET | `BusAdapter`, `InMemoryBusAdapter`, `I2cBusAdapter`, `frameCodec`, and CRC utilities implemented | Real hardware I2C port integration still pending |
| FR-004 Motor command boundary | PARTIALLY MET | Motor command types, binary codec, `PollingMotorNodeClient`, and motor firmware spec define explicit wheel targets | Firmware execution and acknowledgements pending |
| FR-005 Motor feedback boundary | PARTIALLY MET | Motor feedback types, binary codec, `PollingMotorNodeClient`, `motorFeedbackAdapter`, and motor firmware spec define encoder/speed/PWM/fault data | Firmware production of these fields pending |
| FR-006 GNSS measurement boundary | PARTIALLY MET | GNSS protocol types, binary codec, protocol docs, `PollingGnssNodeClient`, and `gnssAdapter` define compact sample exchange; GNSS firmware spec now fixes the local frame to base-station origin | Firmware production and freshness rules pending |
| FR-007 State estimation | PARTIALLY MET | `PoseEstimator` now integrates wheel odometry and blends GNSS position/heading inputs | Still a simplified estimator without uncertainty propagation |
| FR-008 Adaptive trust | PARTIALLY MET | `AdaptiveTrust` implemented and used by `PoseEstimator` | Needs richer innovation/slip-based trust logic |
| FR-009 Guidance | PARTIALLY MET | `lineGeometry` and `lineTracker` implemented and unit tested | Mission/route management still pending |
| FR-010 Control planning | PARTIALLY MET | `wheelCommandPlanner` and `commandLimiter` implemented with runtime integration tests | Vehicle compensation and richer limiting still pending |
| FR-011 Self-calibration | PARTIALLY MET | Parameter schema/defaults now distinguish several physical assumptions that calibration will later refine | Calibration execution and fitting still pending |
| FR-012 Manual route capture and replay | NOT MET | None | Pending |
| FR-013 Logging and replay | PARTIALLY MET | Memory event/telemetry loggers and array replay reader implemented and tested | File-backed telemetry and offline analysis tooling pending |
| FR-014 Safety | PARTIALLY MET | `RuleBasedSafetyManager` now stops motion on stale inputs and fault flags, with runtime tests | Rules remain simple and need expansion |
| FR-015 Resumability | PARTIALLY MET | Functional spec and traceability documents created | Must be kept current during implementation |
| NFR-001 Maintainability | PARTIALLY MET | Clean module layout established | Needs enforcement through continued discipline |
| NFR-002 Testability | PARTIALLY MET | Initial unit tests added for pure modules | Broader test suite pending |
| NFR-003 Bandwidth discipline | PARTIALLY MET | Compact fixed-size payloads and packed frame encoding implemented | Field sizes still need validation against live telemetry |
| NFR-004 Portability | PARTIALLY MET | Bus abstraction established | Concrete transports pending |
| NFR-005 Observability | PARTIALLY MET | Runtime emits telemetry/events into tested memory loggers | Durable sinks and reports pending |
