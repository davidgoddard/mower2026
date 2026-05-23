import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrimitivesStore, resolveServerPort, routeServerRequest } from '../dist/index.js';
import { getTurnTuningPageHtml } from '../dist/server/turnTuningPage.js';
import { getDriveTuningPageHtml } from '../dist/server/driveTuningPage.js';
import { getSegmentTestingPageHtml } from '../dist/server/segmentTestingPage.js';
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
  assert.equal(typeof primitivesPayload.primitives.motors, 'object');
});

test('routeServerRequest serves tabbed home page and 404 responses', () => {
  const primitives = new PrimitivesStore();

  const homeRoute = routeServerRequest('GET', '/', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(homeRoute.statusCode, 200);
  assert.equal(homeRoute.contentType.startsWith('text/html'), true);
  assert.equal(homeRoute.body.includes('Primitives'), true);
  assert.equal(homeRoute.body.includes('Segment Testing'), true);

  const segmentRoute = routeServerRequest('GET', '/segment-testing', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(segmentRoute.statusCode, 200);
  assert.equal(segmentRoute.contentType.startsWith('text/html'), true);
  assert.equal(segmentRoute.body.includes('Run Segment Test'), true);

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
  assert.equal(turnPage.includes('Are you sure you want to clear all turn history?'), true);
  assert.equal(turnPage.includes('Are you sure you want to reset turn learning parameters to defaults?'), true);
  assert.equal(turnPage.includes('id="validationResultsTableBody"'), true);
  assert.equal(turnPage.includes('id="validationStatus"'), true);

  const drivePage = getDriveTuningPageHtml();
  assert.equal(drivePage.includes('class="page-layout"'), true);
  assert.equal(drivePage.includes('class="sidebar-column"'), true);
  assert.equal(drivePage.includes('id="imu-status"'), true);
  assert.equal(drivePage.includes('id="gnss-status"'), true);
  assert.equal(drivePage.includes('Distance (cm)'), true);
  assert.equal(drivePage.includes('id="startDriveTuning"'), true);
  assert.equal(drivePage.includes('id="stopDriveTuning"'), true);
  assert.equal(drivePage.includes('id="startDistanceCm"'), true);
  assert.equal(drivePage.includes('start tuning'), true);
  assert.equal(drivePage.includes('cache: "no-store"'), true);
  assert.equal(drivePage.includes('maxDistanceMeters: endAtMeters'), true);
  assert.equal(drivePage.includes('const maxDriveResultRows = 500;'), true);
  assert.equal(drivePage.includes('const driveResultRows = [];'), true);
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
  assert.equal(segmentPage.includes('id="segmentResultsTableBody"'), true);
  assert.equal(segmentPage.includes('Segment Results'), true);
  assert.equal(segmentPage.includes('Run Segment Test'), true);
  assert.equal(segmentPage.includes('Avg CTE</th>'), true);
  assert.equal(segmentPage.includes('Max CTE</th>'), true);

  const pathPage = renderPathTracingPage();
  assert.equal(pathPage.includes('Path Tracing'), true);
  assert.equal(pathPage.includes('id="startRecordingBtn"'), true);
  assert.equal(pathPage.includes('id="stopPathBtn"'), true);
  assert.equal(pathPage.includes('onclick="verifyPath('), true);
  assert.equal(pathPage.includes('/api/path/verify'), true);
  assert.equal(pathPage.includes('nearest point'), true);
});

test('launcher and systemd unit pin logs to the repo logs folder', async () => {
  const repoRoot = process.cwd();
  const launcher = await readFile(join(repoRoot, 'scripts/mower-launch.sh'), 'utf8');
  assert.equal(launcher.includes('export MOWER_LOG_DIR="${MOWER_LOG_DIR:-$REPO_DIR/logs}"'), true);

  const serviceTemplate = await readFile(join(repoRoot, 'systemd/mower.service.template'), 'utf8');
  assert.equal(serviceTemplate.includes('Environment=MOWER_LOG_DIR=__MOWER_REPO_DIR__/logs'), true);
});
