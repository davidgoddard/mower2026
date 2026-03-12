import test from "node:test";
import assert from "node:assert/strict";
import { SiteCaptureRecorder } from "../../src/site/siteCaptureRecorder.js";
import type { SiteCaptureSample } from "../../src/site/siteTypes.js";

function sample(
  xMeters: number,
  yMeters: number,
  headingDegrees: number,
  timestampMillis: number,
): SiteCaptureSample {
  return {
    xMeters,
    yMeters,
    headingDegrees,
    timestampMillis,
  };
}

test("SiteCaptureRecorder records the first point immediately and then uses distance threshold sampling", () => {
  const recorder = new SiteCaptureRecorder();
  recorder.startPerimeter();

  const first = recorder.recordSample(sample(0, 0, 0, 0));
  const near = recorder.recordSample(sample(0.1, 0, 0, 500));
  const far = recorder.recordSample(sample(0.2, 0, 0, 900));

  assert.equal(first.recorded, true);
  assert.equal(first.reason, "first_point");
  assert.equal(near.recorded, false);
  assert.equal(near.reason, "threshold_not_met");
  assert.equal(far.recorded, true);
  assert.equal(far.reason, "distance");
  assert.equal(far.activeCapture?.points.length, 2);
});

test("SiteCaptureRecorder records heading-driven and timeout-driven samples", () => {
  const recorder = new SiteCaptureRecorder();
  recorder.startPerimeter();

  recorder.recordSample(sample(0, 0, 0, 0));
  const headingSample = recorder.recordSample(sample(0.01, 0, 9, 300));
  const timeoutSample = recorder.recordSample(sample(0.02, 0, 10, 2_600));

  assert.equal(headingSample.recorded, true);
  assert.equal(headingSample.reason, "heading");
  assert.equal(timeoutSample.recorded, true);
  assert.equal(timeoutSample.reason, "timeout");
});

test("SiteCaptureRecorder closes and simplifies the perimeter polygon on finish", () => {
  const recorder = new SiteCaptureRecorder({
    polygonSimplificationToleranceMeters: 0.05,
    minimumPolygonAreaSquareMeters: 0.1,
  });
  recorder.startPerimeter();

  recorder.recordSample(sample(0, 0, 0, 0));
  recorder.recordSample(sample(1, 0, 0, 1_000));
  recorder.recordSample(sample(2, 0, 0, 2_000));
  recorder.recordSample(sample(2, 1, 90, 3_000));
  recorder.recordSample(sample(0, 1, 180, 4_000));

  const site = recorder.finishCapture(5_000);

  assert.equal(site.perimeter.rawPoints.length, 6);
  assert.deepEqual(site.perimeter.rawPoints[0], site.perimeter.rawPoints[site.perimeter.rawPoints.length - 1]);
  assert.equal(site.perimeter.simplifiedPoints.length, 5);
  assert.equal(site.warnings.length, 0);
});

test("SiteCaptureRecorder manages obstacle capture separately from the perimeter", () => {
  const recorder = new SiteCaptureRecorder({
    minimumPolygonAreaSquareMeters: 0.1,
  });

  recorder.startPerimeter();
  recorder.recordSample(sample(0, 0, 0, 0));
  recorder.recordSample(sample(2, 0, 0, 1_000));
  recorder.recordSample(sample(2, 2, 90, 2_000));
  recorder.recordSample(sample(0, 2, 180, 3_000));
  recorder.finishPerimeter();

  recorder.startObstacle();
  recorder.recordSample(sample(0.5, 0.5, 0, 5_000));
  recorder.recordSample(sample(0.8, 0.5, 0, 6_000));
  recorder.recordSample(sample(0.8, 0.8, 90, 7_000));
  recorder.recordSample(sample(0.5, 0.8, 180, 8_000));

  const obstacle = recorder.finishObstacle();
  const site = recorder.finishCapture(9_000);

  assert.equal(obstacle.kind, "obstacle");
  assert.equal(site.obstacles.length, 1);
});

test("SiteCaptureRecorder undoLastPoint removes the latest active-capture point", () => {
  const recorder = new SiteCaptureRecorder();
  recorder.startPerimeter();
  recorder.recordSample(sample(0, 0, 0, 0));
  recorder.recordSample(sample(1, 0, 0, 1_000));

  const active = recorder.undoLastPoint();

  assert.equal(active?.points.length, 1);
  assert.deepEqual(active?.points[0], sample(0, 0, 0, 0));
});

test("SiteCaptureRecorder emits warnings for underspecified polygons", () => {
  const recorder = new SiteCaptureRecorder({
    minimumPolygonAreaSquareMeters: 1,
  });
  recorder.startPerimeter();
  recorder.recordSample(sample(0, 0, 0, 0));
  recorder.recordSample(sample(0.2, 0, 0, 1_000));
  recorder.recordSample(sample(0.2, 0.1, 90, 2_000));

  const site = recorder.finishCapture(3_000);

  assert.deepEqual(
    site.warnings.map((warning) => warning.code),
    ["PERIMETER_TOO_SMALL"],
  );
});
