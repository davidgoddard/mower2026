import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathStore } from '../dist/pathfollowing/pathStore.js';

const logger = { info() {}, warn() {}, debug() {}, error() {} };

test('PathStore resolves a display name containing spaces when checking existence', async () => {
  const storageDirectory = await mkdtemp(join(tmpdir(), 'area-path-store-'));
  const store = new PathStore({ storageDirectory, filenameSuffix: '.area.path.json', logger });
  await store.savePath('East Lawn', [
    { xMeters: 0, yMeters: 0 },
    { xMeters: 1, yMeters: 0 },
  ]);

  assert.equal(await store.pathExists('East Lawn'), true);
  assert.deepEqual(await store.listPaths(), ['East_Lawn']);
});

test('PathStore invalidates sanitized-name cache aliases when a display name is updated', async () => {
  const storageDirectory = await mkdtemp(join(tmpdir(), 'area-path-store-'));
  const store = new PathStore({ storageDirectory, filenameSuffix: '.area.path.json', logger });
  const original = [
    { xMeters: 0, yMeters: 0 },
    { xMeters: 1, yMeters: 0 },
    { xMeters: 1, yMeters: 1 },
  ];
  const corrected = [
    { xMeters: 0, yMeters: 0 },
    { xMeters: 2, yMeters: 0 },
    { xMeters: 1, yMeters: 1 },
  ];

  await store.savePath('East Lawn', original);
  assert.deepEqual((await store.loadPath('East_Lawn')).points, original);

  await store.savePath('East Lawn', corrected);

  assert.deepEqual((await store.loadPath('East_Lawn')).points, corrected);
});
