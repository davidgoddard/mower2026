import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimitivesStore, resolveServerPort, routeServerRequest } from '../dist/index.js';

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

  const missingRoute = routeServerRequest('GET', '/missing', 'running', 'mower-core-test', primitives.snapshot());
  assert.equal(missingRoute.statusCode, 404);
  const missingPayload = JSON.parse(missingRoute.body);
  assert.equal(missingPayload.error, 'not_found');
});
