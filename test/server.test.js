import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrimitivesStore, resolveServerPort, routeServerRequest } from '../dist/index.js';
import { getManualDrivePageHtml } from '../dist/server/manualDrivePage.js';
import { getTurnTuningPageHtml } from '../dist/server/turnTuningPage.js';
import { getDriveTuningPageHtml } from '../dist/server/driveTuningPage.js';
import { getSegmentTestingPageHtml } from '../dist/server/segmentTestingPage.js';
import { getDeadReckoningPageHtml } from '../dist/server/deadReckoningPage.js';
import { renderPathTracingPage } from '../dist/server/pathTracingPage.js';

test('resolveServerPort returns fallback for invalid values', () => {
  assert.equal(resolveServerPort(undefined, 8090), 8090);
  assert.equal(resolveServerPort('0', 8090), 8090);
  assert.equal(resolveServerPort('abc', 8090), 8090);
  assert.equal(resolveServerPort('8091', 8090), 8091);
});

test('routeServerRequest serves health and primitives payloads', () => {
  const primitives = new PrimitivesStore();

  const healthRoute = routeServerRequest('GET', '/health', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(healthRoute.statusCode, 200);
  const health = JSON.parse(healthRoute.body);
  assert.equal(health.ok, true);
  assert.equal(health.state, 'running');

  const primitivesRoute = routeServerRequest('GET', '/api/primitives', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(primitivesRoute.statusCode, 200);
  const primitivesPayload = JSON.parse(primitivesRoute.body);
  assert.equal(primitivesPayload.state, 'running');
  assert.equal(typeof primitivesPayload.primitives.sampledAt, 'string');
  assert.equal(typeof primitivesPayload.primitives.imu, 'object');
  assert.equal(typeof primitivesPayload.primitives.gnss, 'object');
  assert.equal(typeof primitivesPayload.primitives.poseFusion, 'object');
  assert.equal(typeof primitivesPayload.primitives.poseFusion.usingGnssHeading, 'boolean');
  assert.equal(typeof primitivesPayload.primitives.motors, 'object');
});

test('routeServerRequest serves tabbed home page and 404 responses', () => {
  const primitives = new PrimitivesStore();

  const homeRoute = routeServerRequest('GET', '/', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(homeRoute.statusCode, 200);
  assert.equal(homeRoute.contentType.startsWith('text/html'), true);
  assert.equal(homeRoute.body.includes('Drive &amp; Paths'), true);
  assert.equal(homeRoute.body.includes('Path Tracing'), false);
  assert.equal(homeRoute.body.includes('Manual Drive'), false);
  assert.equal(homeRoute.body.includes('Segment Testing'), true);
  assert.equal(homeRoute.body.includes('GNSS Satellites History (last hour)'), false);
  assert.equal(homeRoute.body.includes('GNSS Fix State History (last hour)'), false);
  assert.equal(homeRoute.body.includes('id="gnss-sat-warning"'), true);
  assert.equal(homeRoute.body.includes('Heading History (last hour)'), false);
  assert.equal(homeRoute.body.includes('Position Accuracy History (last hour)'), false);
  assert.equal(homeRoute.body.includes('id="gnss-accuracy"'), true);

  const manualRoute = routeServerRequest('GET', '/manual-drive', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(manualRoute.statusCode, 200);
  assert.equal(manualRoute.contentType.startsWith('text/html'), true);
  assert.equal(manualRoute.body.includes('Drive & Paths'), true);
  assert.equal(manualRoute.body.includes('id="mapCanvas"'), true);
  assert.equal(manualRoute.body.includes('id="mowingPlanArea"'), true);
  assert.equal(manualRoute.body.includes('id="mowingHeadingDeg"'), true);
  assert.equal(manualRoute.body.includes('id="startRecordingBtn"'), true);
  assert.equal(manualRoute.body.includes('id="startAreaRecordingBtn"'), true);
  assert.equal(manualRoute.body.includes('id="pathsList"'), true);
  assert.equal(manualRoute.body.includes('id="areaPerimetersList"'), true);
  assert.equal(manualRoute.body.includes('id="stopPathBtn"'), true);
  assert.equal(manualRoute.body.includes('Controller Demand'), false);
  assert.equal(manualRoute.body.includes('Motion Feedback'), false);
  assert.equal(manualRoute.body.includes('GNSS'), false);
  assert.equal(manualRoute.body.includes('IMU'), false);

  const pathRoute = routeServerRequest('GET', '/path-tracing', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(pathRoute.statusCode, 200);
  assert.equal(pathRoute.contentType.startsWith('text/html'), true);
  assert.equal(pathRoute.body, getManualDrivePageHtml());

  const missingRoute = routeServerRequest('GET', '/missing', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(missingRoute.statusCode, 404);
  const missingPayload = JSON.parse(missingRoute.body);
  assert.equal(missingPayload.error, 'not_found');
});

test('tuning pages expose the simplified drive training controls', () => {
  const turnPage = getTurnTuningPageHtml();
  assert.equal(turnPage.includes('class="page-layout"'), true);
  assert.equal(turnPage.includes('class="sidebar-column"'), true);
  assert.equal(turnPage.includes('id="imu-status"'), true);
  assert.equal(turnPage.includes('id="gnss-status"'), true);
  assert.equal(turnPage.includes('id="stopCurrentRun"'), true);
  assert.equal(turnPage.includes('class="center-row"'), true);
  assert.equal(turnPage.includes('class="single-run-panel"'), true);
  assert.equal(turnPage.includes('id="runRealPoseValidation"'), true);
  assert.equal(turnPage.includes('appDialogBackdrop'), true);
  assert.equal(turnPage.includes('Are you sure you want to clear all turn history?'), true);
  assert.equal(turnPage.includes('Are you sure you want to reset turn learning parameters to defaults?'), true);
  assert.equal(turnPage.includes('id="validationResultsTableBody"'), true);
  assert.equal(turnPage.includes('id="validationStatus"'), true);
  assert.equal(turnPage.includes('const turnActionButtons = ['), true);
  assert.equal(turnPage.includes('function syncTurnButtons()'), true);
  assert.equal(turnPage.includes("stopButton.disabled = stopRequestPending || !runActive;"), true);

  const drivePage = getDriveTuningPageHtml();
  assert.equal(drivePage.includes('class="page-layout"'), true);
  assert.equal(drivePage.includes('class="sidebar-column"'), true);
  assert.equal(drivePage.includes('id="imu-status"'), true);
  assert.equal(drivePage.includes('id="gnss-status"'), true);
  assert.equal(drivePage.includes('Distance (cm)'), true);
  assert.equal(drivePage.includes('id="startDriveTuning"'), true);
  assert.equal(drivePage.includes('id="stopDriveTuning"'), true);
  assert.equal(drivePage.includes('id="resetDriveLearning"'), true);
  assert.equal(drivePage.includes('id="startDistanceCm"'), true);
  assert.equal(drivePage.includes('start tuning'), true);
  assert.equal(drivePage.includes('Are you sure you want to reset drive learning parameters to defaults?'), true);
  assert.equal(drivePage.includes('/api/drive/reset-learning'), true);
  assert.equal(drivePage.includes('cache: "no-store"'), true);
  assert.equal(drivePage.includes('maxDistanceMeters: endAtMeters'), true);
  assert.equal(drivePage.includes('const maxDriveResultRows = 500;'), true);
  assert.equal(drivePage.includes('const driveResultRows = [];'), true);
  assert.equal(drivePage.includes('let startHandshakePending = false;'), true);
  assert.equal(drivePage.includes('function syncDriveButtons()'), true);
  assert.equal(drivePage.includes('startButton.disabled = startHandshakePending || trainingActive;'), true);
  assert.equal(drivePage.includes('stopButton.disabled = stopRequestPending || !trainingActive;'), true);
  assert.equal(drivePage.includes('appendDriveRows(history);'), true);
  assert.equal(drivePage.includes('appendDriveRows(liveResults);'), true);
  assert.equal(drivePage.includes('driveResultRows.slice(-maxDriveResultRows).reverse()'), true);
  assert.equal(drivePage.includes('Distance</th>'), true);
  assert.equal(drivePage.includes('Avg CTE</th>'), true);
  assert.equal(drivePage.includes('Max CTE</th>'), true);
  assert.equal(drivePage.includes('X Error</th>'), true);
  assert.equal(drivePage.includes('Y Error</th>'), true);

  const segmentPage = getSegmentTestingPageHtml();
  assert.equal(segmentPage.includes('class="page-layout"'), true);
  assert.equal(segmentPage.includes('class="sidebar-column"'), true);
  assert.equal(segmentPage.includes('id="imu-status"'), true);
  assert.equal(segmentPage.includes('id="gnss-status"'), true);
  assert.equal(segmentPage.includes('fetch("/api/primitives?ts=" + Date.now(), { cache: "no-store" })'), true);
  assert.equal(segmentPage.includes('primitives: primitivesPayload.primitives ?? primitivesPayload'), true);
  assert.equal(segmentPage.includes('id="startSegmentTest"'), true);
  assert.equal(segmentPage.includes('id="stopSegmentTest"'), true);
  assert.equal(segmentPage.includes('let segmentStateSnapshot = { phase: "idle", running: false };'), true);
  assert.equal(segmentPage.includes('function syncSegmentButtons()'), true);
  assert.equal(segmentPage.includes('startButton.disabled = startHandshakePending || runActive;'), true);
  assert.equal(segmentPage.includes('stopButton.disabled = stopRequestPending || !runActive;'), true);
  assert.equal(segmentPage.includes('id="segmentResultsTableBody"'), true);
  assert.equal(segmentPage.includes('Segment Results'), true);
  assert.equal(segmentPage.includes('Run Segment Test'), true);
  assert.equal(segmentPage.includes('Heading Diff</th>'), true);
  assert.equal(segmentPage.includes('formatHeadingDifference(item.requiredHeadingChangeDeg, item.achievedHeadingChangeDeg)'), true);
  assert.equal(segmentPage.includes('colspan="12"'), true);
  assert.equal(segmentPage.includes('Avg CTE (cm)</th>'), true);
  assert.equal(segmentPage.includes('Max CTE (cm)</th>'), true);
  assert.equal(segmentPage.includes('X Error (cm)</th>'), true);
  assert.equal(segmentPage.includes('Y Error (cm)</th>'), true);
  assert.equal(segmentPage.includes('formatCentimeters(item.cteMeters)'), true);

  const manualPage = getManualDrivePageHtml();
  assert.equal(manualPage.includes('Drive & Paths'), true);
  assert.equal(manualPage.includes('id="mapCanvas"'), true);
  assert.equal(manualPage.includes('id="mowingPlanArea"'), true);
  assert.equal(manualPage.includes('id="mowingHeadingDeg"'), true);
  assert.equal(manualPage.includes('id="stripSpacingCm"'), true);
  assert.equal(manualPage.includes('id="startRecordingBtn"'), true);
  assert.equal(manualPage.includes('id="startAreaRecordingBtn"'), true);
  assert.equal(manualPage.includes('id="stopPathBtn"'), true);
  assert.equal(manualPage.includes('id="pathsList"'), true);
  assert.equal(manualPage.includes('id="areaPerimetersList"'), true);
  assert.equal(manualPage.includes('Controller Demand'), false);
  assert.equal(manualPage.includes('Motion Feedback'), false);
  assert.equal(manualPage.includes('GNSS'), false);
  assert.equal(manualPage.includes('IMU'), false);
  assert.equal(manualPage.includes('appDialogBackdrop'), true);
  assert.equal(manualPage.includes('onclick="verifyPath('), true);
  assert.equal(manualPage.includes('value="\\${htmlAttribute(path.name)}"'), true);
  assert.equal(manualPage.includes('Segmented drive'), false);
  assert.equal(manualPage.includes('/api/path/algorithm'), false);
  assert.equal(manualPage.includes('/api/area-perimeter/algorithm'), false);
  assert.equal(manualPage.includes('/api/path/verify'), true);
  assert.equal(manualPage.includes('/api/area-perimeter/verify'), true);
  assert.equal(manualPage.includes('/api/area-perimeter/drive'), true);
  assert.equal(manualPage.includes('/api/mowing-plan/preview'), true);
  assert.equal(manualPage.includes('nearest point'), true);
  assert.equal(manualPage.includes('MAP_MIN_VIEW_RANGE_METERS = 5'), true);
  assert.equal(manualPage.includes('MAP_STATIONARY_POINT_SPACING_METERS = 0.03'), true);
  assert.equal(manualPage.includes('hasDrawablePathPoints(path)'), true);
  assert.equal(manualPage.includes('loadStoredPathDetail(pathInfo, endpointBase)'), true);
  assert.equal(manualPage.includes('Skipping stored path with invalid details'), true);
  assert.equal(manualPage.includes("result.failedSegment?.errorMessage"), true);
  assert.equal(manualPage.includes('confirm('), false);

  const deadReckoningPage = getDeadReckoningPageHtml();
  assert.equal(deadReckoningPage.includes('id="lineDistanceMeters"'), true);
  assert.equal(deadReckoningPage.includes('Straight distance'), true);
  assert.equal(deadReckoningPage.includes('body: JSON.stringify({ lineDistanceMeters })'), true);

  const pathPage = renderPathTracingPage();
  assert.equal(pathPage, manualPage);
});

test('launcher and systemd unit pin logs to the repo logs folder', async () => {
  const repoRoot = process.cwd();
  const launcher = await readFile(join(repoRoot, 'scripts/mower-launch.sh'), 'utf8');
  assert.equal(launcher.includes('export MOWER_LOG_DIR="${MOWER_LOG_DIR:-$REPO_DIR/logs}"'), true);

  const serviceTemplate = await readFile(join(repoRoot, 'systemd/mower.service.template'), 'utf8');
  assert.equal(serviceTemplate.includes('Environment=MOWER_LOG_DIR=__MOWER_REPO_DIR__/logs'), true);
});
