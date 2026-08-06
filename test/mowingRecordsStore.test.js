import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MowingRecordsStore } from '../dist/config/mowingRecordsStore.js';
import { calculateBladeTravelMeters } from '../dist/maintenance/bladeUsageTracker.js';

test('MowingRecordsStore persists history, presets, and blade maintenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mowing-records-'));
  const path = join(directory, 'records.json');
  const store = new MowingRecordsStore(path);
  await store.load();
  await store.recordMowing('Front Lawn', 45, 0.3, '2026-07-30T10:00:00.000Z');
  const preset = await store.savePreset({ name: 'Front diagonal', areaName: 'Front Lawn', headingDeg: 45, stripWidthMeters: 0.3 });
  await store.savePreset({ id: preset.id, name: 'East', areaName: 'Front Lawn', headingDeg: 0, stripWidthMeters: 0.28 });
  await store.updateBladeMaintenance('2026-07-01', 6000);
  await store.addBladeTravelMeters(125.5);

  const reloaded = new MowingRecordsStore(path);
  await reloaded.load();
  const snapshot = reloaded.snapshot();
  assert.equal(snapshot.history[0].areaName, 'Front Lawn');
  assert.equal(snapshot.presets[0].id, preset.id);
  assert.equal(snapshot.presets[0].name, 'East');
  assert.equal(snapshot.presets[0].stripWidthMeters, 0.28);
  assert.deepEqual(snapshot.bladeMaintenance, { lastSharpenedAt: '2026-07-01', sharpeningIntervalMeters: 6000, metersSinceSharpening: 125.5 });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);

  await reloaded.deletePreset(preset.id);
  assert.equal(reloaded.snapshot().presets.length, 0);
});

test('MowingRecordsStore rejects unsafe mowing values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mowing-records-invalid-'));
  const store = new MowingRecordsStore(join(directory, 'records.json'));
  await store.load();
  await assert.rejects(() => store.savePreset({ name: 'Bad', areaName: 'Lawn', headingDeg: 180, stripWidthMeters: 0.3 }), /heading_invalid/);
  await assert.rejects(() => store.updateBladeMaintenance('not-a-date', 5), /last_sharpened_at_invalid/);
});

test('blade travel uses only the faster forward-moving wheel', () => {
  const calibration = {
    forwardLeftMetersPerTick: 0.01,
    forwardRightMetersPerTick: 0.02,
  };
  assert.equal(calculateBladeTravelMeters(5, 4, calibration), 0.08);
  assert.equal(calculateBladeTravelMeters(-20, 3, calibration), 0.06);
  assert.equal(calculateBladeTravelMeters(-20, -30, calibration), 0);
});

test('changing the sharpening date resets blade travel but changing only the interval preserves it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blade-maintenance-'));
  const store = new MowingRecordsStore(join(directory, 'records.json'));
  await store.load();
  await store.updateBladeMaintenance('2026-07-01', 5000);
  await store.addBladeTravelMeters(250);
  await store.updateBladeMaintenance('2026-07-01', 6000);
  assert.equal(store.snapshot().bladeMaintenance.metersSinceSharpening, 250);
  await store.updateBladeMaintenance('2026-08-01', 6000);
  assert.equal(store.snapshot().bladeMaintenance.metersSinceSharpening, 0);
});
