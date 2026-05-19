# Project Instructions

## Agents

- Stay within `/Volumes/Mower/mower` and its subdirectories unless the task explicitly says otherwise.
- Check whether the session actually has the needed toolchain before attempting builds or package-manager commands.
- If `node`, `npm`, or the repo build command is unavailable in this session, do not keep retrying those commands.
- When tooling is unavailable, switch to source inspection, code edits, and a clear note that build/test verification could not be run here.
- Do not assume a missing command will become available later in the same session.
- Never edit files in the dist folder.  Request the user does a "npm run build".


## Goal
- Develop a control system using Typescript and NodeJS runtime to operate an autonomous lawn mower. 



## Hardware
- GNSS
    - um982 with dual antenna
    - serial connection to an ESP32 WROOM Development module
    - ESP32:
        - receives RTCM updates from a base station
        - forwards RTCM updates to um982
        - receives messages from um982 containing heading and position and fix quality information
        - acts as an i2c client

- IMU
    - i2c client connected BM160 module providing Yaw integration

- Motors
    - two 185 rpm 12v motors operated through PWM and Direction plus provide a pulse output for rotation measurement
    - ESP32 handles PWM and direction control to maintain smooth ramp-up and ramp-down 
    - ESP32 handles slow down through zero when changing direction
    - ESP32 monitors motor current and makes this available
    - ESP32 monitors the motor feedback and makes this available
    - ESP32 maintains a i2c command watchdog to detect stale commands and safely stop motor.

- i2c required which limits node version to 20.

## Rules
- Use the docs/system-map.md to target source code when requested to change code and if no such target is documented yet, update the system-map.md to provide such a mapping to avoid the source searching again.
- Follow docs/development-guide.md for coding guidance and project code structure
- Do not perform broad refactors unless explicitly requested.
- Preserve existing working behaviour.
- Prefer small, reviewable diffs.
- Do not introduce new dependencies without approval.
- If requirements are ambiguous, prompt for clarification and if requested document the ambiguity before coding.
- Every code change must include or update tests where practical.
- After changes, run the relevant test, lint, and type-check commands.
- Summarize exactly what changed and what was not changed.
- Remove junk as the project progresses such as logging statements added to dig deep into problems once the problem has been solved - logging is a resource consumer when bloated that the system cannot support
- For each new feature, create a branch, make the changes and when asked to submit the repo, push all code with suitable documentation of changes and create a PR

## Required checks
- npm test
- npm run lint
- npm run typecheck

## Documentation
- Treat docs/functional-specification.md as the source of truth.
- If code and spec disagree, ask before changing behaviour unless the task explicitly says to align code to spec.
- Always extend, update or write suitable documentation files for each component and software layer as the project evolves