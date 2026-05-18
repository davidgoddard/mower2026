# Pull Request: Add IMU pitch/roll tilt sensing and motor current VU meters

## Summary

This PR adds comprehensive tilt sensing to the IMU and enhances the web dashboard with visual monitoring displays:

### IMU Pitch & Roll Tilt Sensing
- **Accelerometer integration**: Extended BMI160 driver to read 3-axis accelerometer data
- **Tilt calculation**: Pitch (front-to-back) and roll (side-to-side) derived from gravity vector
- **Startup calibration**: Automatically zeros pitch/roll offsets during initialization, allowing level reference on uneven ground
- **Full 6-DOF orientation**: Heading (gyro integration) + pitch + roll (accelerometer)

### Motor Current VU Meters
- **Visual monitoring**: Professional audio-meter style displays for left/right motor current
- **Peak tracking**: Holds maximum current value for 2 seconds to catch transient spikes
- **Color-coded gradient**: Green → yellow → red (0-10A scale)
- **Dual display**: Shows both instantaneous and peak values (e.g., "1.25A / 3.47A")

### Dashboard Visual Enhancements
- **IMU widget**: Added circular level indicators for pitch and roll below the compass
- **GNSS widget**: Added compass display matching IMU style
- **Heading convention fix**: All compass displays now use navigation convention (0° = north, clockwise positive)
- **Improved layout**: Motor widget reorganized with VU meters prominently displayed

## Technical Details

### Hardware Layer Changes
**[src/imu/bmi160Registers.ts](src/imu/bmi160Registers.ts)**
- Added accelerometer register addresses: `accXLsb` (0x12), `accYLsb` (0x14), `accZLsb` (0x16)
- Added accelerometer range register: `accRange` (0x41)
- Added accelerometer normal mode command: `accNormalMode` (0x11)
- Added accelerometer scale constant: `accLsbPerGAt2g` (16384)

**[src/imu/bmi160ImuSensor.ts](src/imu/bmi160ImuSensor.ts)**
- Initialize accelerometer alongside gyroscope in `initialise()`
- Extended `calibrateGyro()` to also calibrate pitch/roll zero offsets
- Added `readAccelerometerRaw()` method to read all 3 axes
- Added `calculatePitchDeg()` and `calculateRollDeg()` helper methods
- Updated `read()` to include acceleration and calculated pitch/roll
- Track pitch/roll offsets: `pitchOffsetDeg`, `rollOffsetDeg`

### Type System
**[src/imu/types.ts](src/imu/types.ts)**
- Extended `ImuSample` interface with `acceleration` field containing x, y, z in m/s²

### Sensor Events
**[src/sensing/sensorEvents.ts](src/sensing/sensorEvents.ts)**
- Added `pitchDeg` and `rollDeg` to `ImuHeadingUpdateEvent`

### Sensor Controller
**[src/sensing/sensorController.ts](src/sensing/sensorController.ts)**
- Modified `pollImu()` to calculate pitch/roll from accelerometer data
- Updated primitives store with pitch and roll values
- Emit pitch/roll in heading update events
- Initialize pitch/roll fields in `start()` method

### Primitives Store
**[src/server/primitivesStore.ts](src/server/primitivesStore.ts)**
- Added `pitchDeg: number | null` to IMU primitives interface
- Added `rollDeg: number | null` to IMU primitives interface
- Initialize both fields to `null` in default snapshot

### Application Server
**[src/server/appServer.ts](src/server/appServer.ts)**
- Added pitch/roll fields to IMU error state initialization

### Web Dashboard
**[src/server/homePage.ts](src/server/homePage.ts)**

**CSS Additions:**
- `.tilt-indicators`, `.tilt-indicator`, `.tilt-circle`, `.tilt-line`, `.tilt-center`, `.tilt-label`, `.tilt-value` - Styles for pitch/roll level indicators
- `.vu-meter-container`, `.vu-meter-label`, `.vu-meter-track`, `.vu-meter-bar`, `.vu-meter-peak`, `.vu-meter-scale`, `.vu-meter-tick` - VU meter component styles

**HTML Changes:**
- IMU widget: Added pitch and roll circular level indicators with rotating lines
- GNSS widget: Added compass display matching IMU compass
- Motors widget: Replaced current text fields with VU meter displays showing current bar and peak line

**JavaScript Changes:**
- Added `internalToNavigationHeading()` conversion function (formula: `90 - internalHeading`)
- Added VU meter tracking variables: `leftMotorPeakAmps`, `rightMotorPeakAmps`, peak timestamps
- Added `updateVUMeter()` function with peak hold logic (2-second hold time)
- Updated IMU compass to use navigation heading
- Updated GNSS compass to use navigation heading
- Updated motor current display to drive VU meters with peak tracking

## Documentation Updates

**[docs/sensors.md](docs/sensors.md)**
- Added `pitchDeg` and `rollDeg` to IMU primitives JSON example
- Added "Data Sources" section explaining gyro and accelerometer usage
- Added "Pitch and Roll Calculation" section with formulas
- Added "Calibration and Zeroing" section explaining startup process

**[docs/functional-specification.md](docs/functional-specification.md)**
- Replaced "Primitives Viewer" section with detailed "Dashboard Home Page" section
- Added descriptions of IMU, GNSS, and Motors widgets
- Added "Heading Display Convention" explanation
- Renamed section to "Primitives API" for clarity
- Expanded "IMU interface" section with:
  - BMI160 sensor details
  - Pitch and roll calculation formulas
  - Calibration and zeroing process
  - Internal vs navigation heading convention

**[README.md](README.md)**
- Enhanced "Development Infrastructure" section with web dashboard details:
  - Visual sensor displays (compass headings, pitch/roll level indicators)
  - Motor current VU meters with peak hold
  - Turn and drive tuning interfaces

## Files Changed (11)
- `README.md`
- `docs/functional-specification.md`
- `docs/sensors.md`
- `src/imu/bmi160ImuSensor.ts`
- `src/imu/bmi160Registers.ts`
- `src/imu/types.ts`
- `src/sensing/sensorController.ts`
- `src/sensing/sensorEvents.ts`
- `src/server/appServer.ts`
- `src/server/homePage.ts`
- `src/server/primitivesStore.ts`

## Test Plan
- [x] Build completes without errors
- [ ] Verify pitch/roll indicators respond to mower tilt on hardware
- [ ] Verify VU meters show motor current draw accurately
- [ ] Verify peak indicators hold for 2 seconds
- [ ] Verify compass headings display correctly (north = 0°)
- [ ] Verify all three widgets fit on laptop screen

## Screenshots
*(To be added after testing on hardware)*

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## GitHub PR Creation

To create the PR manually, visit:
https://github.com/davidgoddard/mower2026/pull/new/feature/imu-tilt-motor-vu-meters

Or use this command if GitHub CLI is installed:
```bash
gh pr create --title "Add IMU pitch/roll tilt sensing and motor current VU meters" --body-file PR_SUMMARY.md
```
