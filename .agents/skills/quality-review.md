---
description: Deep code quality review producing a prioritised plan of work — covers security, correctness, duplication, modularity, test coverage, performance, and logging hygiene. Does NOT apply fixes.
---

# Quality Review

You are producing a **plan of work**, not making any code changes. Read the files, identify issues, and output a structured report. Do not edit any source file.

## 0. Required reading before starting

Read these files first — they are the source of truth for intent, structure, and constraints:

1. [AGENTS.md](../../AGENTS.md) — project rules and coding constraints
2. [docs/system-map.md](../../docs/system-map.md) — file-to-concern mapping; use it to locate code efficiently
3. [docs/functional-specification.md](../../docs/functional-specification.md) — intended behaviour; issues that contradict the spec are higher priority

## 1. Scope the review

Use `git diff main...HEAD` to establish what has changed on the current branch. If there are no branch changes, the review covers the full codebase.

Gather supporting context:
- `npm run typecheck` — note any type errors
- `npm run lint` — note any lint failures
- `npm test` — note any failing tests and overall coverage gaps visible in the output

Do not stop on tooling errors; record them and continue.

## 2. Review dimensions

Work through each dimension below. For each finding record:
- **File and line reference** (e.g. `src/control/turnController.ts:142`)
- **Severity**: `critical` / `high` / `medium` / `low`
- **Dimension** (from the list below)
- **Finding**: one sentence describing the problem
- **Why it matters**: the consequence if left unfixed
- **Suggested fix direction**: what kind of change would resolve it (no code)

### 2.1 Security
- Injection risks in any string building passed to shell, I2C, or HTTP
- Secrets or credentials in source or config files
- Unvalidated external inputs (HTTP request bodies, I2C payloads, config file values) used in control flow or arithmetic
- Path traversal in file operations (e.g. config read/write, log paths)
- Denial-of-service risks from unbounded loops driven by external input

### 2.2 Correctness and spec alignment
- Behaviour that contradicts `docs/functional-specification.md`
- Off-by-one errors in angle maths, distance buckets, or array indexing
- Race conditions or shared state mutation without appropriate guards in async/event-driven paths
- Missing error handling at hardware boundaries (I2C read failures, JSON parse errors on config load)
- Silent failure: errors swallowed with no log, event, or propagated rejection
- Edge-case blind spots: empty path arrays, zero-distance drives, first-turn with no learned parameters

### 2.3 Duplication and modularity
- Copy-pasted logic blocks that could share a single implementation (compare against system-map.md to spot cross-module duplication)
- HTML/CSS/JS generated in multiple page modules that is already (or should be) in `liveSensorWidgets.ts`
- Constants defined more than once across files
- Concerns mixed in one module that the system-map separates (e.g. motor protocol details leaking into the drive controller)

### 2.4 Test coverage gaps
- Public functions or classes in `src/` with no corresponding test in `test/`
- Tests that only exercise the happy path and miss the edge cases identified in §2.2
- Tests that mock hardware so completely they could not catch a protocol regression
- Missing tests for learning model persistence (config round-trip)

### 2.5 Performance
- Work done inside the 200 Hz sensor polling loop that could be done once on change
- Object allocation (array/object literals, `.map`/`.filter` chains) inside tight loops
- Synchronous file I/O (`fs.readFileSync`, `JSON.parse` of large files) on the hot path
- Redundant distance or heading calculations repeated multiple times per control tick when the inputs have not changed
- I2C queue saturation risks: commands sent at a rate that could overflow the priority queue

### 2.6 Logging hygiene
- `console.log` / debug log statements that fire every sensor tick (200 Hz) — these will saturate the log file and degrade I/O performance on the Pi
- Log statements inside tight loops (motor command loop, pose update handler, pure-pursuit loop) that do not have a rate limiter or change-detection guard
- Redundant or near-identical log lines emitted by multiple callers for the same event
- Missing structured log entries for key state transitions (session start, stop raised/cleared, turn complete, drive complete, obstruction detected) — these are required per the spec
- Log entries that leak raw I2C buffer bytes at INFO level (should be DEBUG/TRACE or removed post-bring-up)

### 2.7 Unnecessary work in loops
- Pose recalculation or heading conversion done every tick when the underlying sensor value has not updated
- Path geometry (cross-track error, lookahead point) recomputed from scratch each tick when incremental update would suffice
- `JSON.stringify` / `JSON.parse` called in the sensor or control loop for anything other than deliberate serialisation
- Event listeners registered inside a loop body (creates accumulating listener leak)

## 3. Collate and prioritise

After all dimensions, produce a single flat list ordered by `(severity DESC, dimension)`. Deduplicate findings that are the same root cause in different files — group them into one entry with multiple file references.

## 4. Output format

Write the report using this structure:

---

## Quality Review — `<branch or "full codebase">`

### Summary

| Dimension | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | | | | |
| Correctness | | | | |
| Duplication | | | | |
| Test coverage | | | | |
| Performance | | | | |
| Logging hygiene | | | | |
| Unnecessary loop work | | | | |
| **Total** | | | | |

Tooling status:
- Typecheck: PASS / FAIL (n errors)
- Lint: PASS / FAIL (n warnings)
- Tests: PASS / FAIL (n failing, coverage note)

---

### Findings

For each finding use this format:

#### [SEVERITY] DIM-NNN — Short title
**File(s):** `src/path/file.ts:line`  
**Finding:** One sentence.  
**Why it matters:** One sentence.  
**Fix direction:** One sentence describing the type of change needed.

---

### Proposed plan of work

Group findings into logical work packages that could become discrete branches or PRs. Order packages by risk-adjusted priority (critical security/correctness first, then high-impact performance/logging, then housekeeping).

For each package:

#### WP-N — Package title
**Findings addressed:** DIM-001, DIM-007, ...  
**Effort estimate:** XS / S / M / L / XL  
**Branch name suggestion:** `fix/<slug>` or `refactor/<slug>`  
**Notes:** Any dependency on another package or external decision needed before starting.

---

*Generated by /quality-review. No files were modified.*
