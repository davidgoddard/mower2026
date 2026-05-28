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
          driveAlgorithm: 'pure_pursuit',
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
