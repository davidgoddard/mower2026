import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PathRecorder } from '../dist/pathfollowing/pathRecorder.js';
import { createInternalHeading } from '../dist/geometry/headingTypes.js';
import { createPose } from '../dist/geometry/positionTypes.js';

function createLogger() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  };
}

function createRecorder(options = {}) {
  const poseFusion = new EventEmitter();
  let saved = null;
  const pathStore = {
    async savePath(name, points) {
      saved = { name, points };
    },
    async loadPath(name) {
      return {
        name,
        points: saved?.points ?? [],
        createdAt: Date.now(),
        metadata: {
          totalDistance: 0,
          pointCount: saved?.points.length ?? 0,
        },
      };
    },
  };

  return {
    poseFusion,
    getSaved: () => saved,
    recorder: new PathRecorder({
      distanceThreshold: 0.1,
      maxSegmentDistanceMeters: 1,
      ...options,
      logger: createLogger(),
    }, {
      pathStore,
      poseFusion,
    }),
  };
}

function pose(x, y, quality = 'gnss') {
  return createPose(x, y, createInternalHeading(0), quality);
}

test('path recorder records fused dead-reckoning poses while ignoring unknown poses', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder();

  recorder.startRecording('Boundary');
  poseFusion.emit('poseUpdate', pose(0, 0, 'dead-reckoning'));
  poseFusion.emit('poseUpdate', pose(0.2, 0, 'unknown'));
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(0.2, 0));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [0, 0],
    [0.2, 0],
  ]);
});

test('path recorder can be configured to require GNSS-quality poses', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder({ requireGnssQuality: true });

  recorder.startRecording('Boundary');
  poseFusion.emit('poseUpdate', pose(0, 0, 'dead-reckoning'));
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(0.2, 0));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [0, 0],
    [0.2, 0],
  ]);
});

test('path recorder rejects implausible jumps and resumes when pose returns near the path', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder();

  recorder.startRecording('Boundary');
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(0.2, 0));
  poseFusion.emit('poseUpdate', pose(12, 0));
  poseFusion.emit('poseUpdate', pose(0.4, 0));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [0, 0],
    [0.2, 0],
    [0.4, 0],
  ]);
});

test('path recorder recovers when the first captured point is from a stale origin', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder();

  recorder.startRecording('Boundary');
  poseFusion.emit('poseUpdate', pose(-313321, 2147483));
  poseFusion.emit('poseUpdate', pose(8, 5));
  poseFusion.emit('poseUpdate', pose(8.2, 5));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [8, 5],
    [8.2, 5],
  ]);
});

test('path recorder saves raw obstacle recordings even when save processing is requested', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder({
    saveProcessing: 'obstacle_safe_smoothed',
    maxSegmentDistanceMeters: 5,
  });

  recorder.startRecording('Obstacle 1');
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(1, 0.1));
  poseFusion.emit('poseUpdate', pose(1.1, 0.9));
  poseFusion.emit('poseUpdate', pose(0.2, 1));
  poseFusion.emit('poseUpdate', pose(-0.1, 0.5));
  poseFusion.emit('poseUpdate', pose(0, 0));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [0, 0],
    [1, 0.1],
    [1.1, 0.9],
    [0.2, 1],
    [-0.1, 0.5],
    [0, 0],
  ]);
});

test('path recorder saves raw area recordings even when save processing is requested', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder({
    saveProcessing: 'area_safe_smoothed',
    maxSegmentDistanceMeters: 5,
  });

  recorder.startRecording('Area 1');
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(2, 0.2));
  poseFusion.emit('poseUpdate', pose(2.1, 1.8));
  poseFusion.emit('poseUpdate', pose(0.3, 2));
  poseFusion.emit('poseUpdate', pose(-0.1, 1));
  poseFusion.emit('poseUpdate', pose(0, 0));

  await recorder.stopAndSave();

  assert.deepEqual(getSaved().points.map((point) => [point.xMeters, point.yMeters]), [
    [0, 0],
    [2, 0.2],
    [2.1, 1.8],
    [0.3, 2],
    [-0.1, 1],
    [0, 0],
  ]);
});

test('path recorder preserves stepped mowing-area edges when using area save processing', async () => {
  const { recorder, poseFusion, getSaved } = createRecorder({
    saveProcessing: 'area_safe_smoothed',
    maxSegmentDistanceMeters: 10,
  });

  recorder.startRecording('Area stepped');
  poseFusion.emit('poseUpdate', pose(0, 0));
  poseFusion.emit('poseUpdate', pose(0, 4));
  poseFusion.emit('poseUpdate', pose(3, 4));
  poseFusion.emit('poseUpdate', pose(3, 1));
  poseFusion.emit('poseUpdate', pose(5, 1));
  poseFusion.emit('poseUpdate', pose(5, 3));
  poseFusion.emit('poseUpdate', pose(8, 3));
  poseFusion.emit('poseUpdate', pose(8, 0));
  poseFusion.emit('poseUpdate', pose(0, 0));

  await recorder.stopAndSave();

  const saved = getSaved().points;
  assert.equal(saved.length, 9);
  assert.equal(saved[0].xMeters, saved.at(-1).xMeters);
  assert.equal(saved[0].yMeters, saved.at(-1).yMeters);
  assert.equal(saved.some((point) => point.yMeters < 0.5), true);
  assert.equal(saved.some((point) => point.xMeters > 4.5 && point.yMeters < 1.5), true);
  assert.equal(saved.some((point) => point.xMeters > 4.5 && point.yMeters > 2.5), true);
});
