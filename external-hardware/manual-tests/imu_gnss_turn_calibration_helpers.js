const NORMALIZED_ANGLE_MIN = -180;
const NORMALIZED_ANGLE_MAX = 180;
const FULL_CIRCLE_DEGREES = 360;
const FIELD_TO_INTERNAL_OFFSET_DEGREES = 90;

export function normalizeInternalHeadingDegrees(degrees) {
  let normalized = degrees;
  while (normalized <= NORMALIZED_ANGLE_MIN) {
    normalized += FULL_CIRCLE_DEGREES;
  }
  while (normalized > NORMALIZED_ANGLE_MAX) {
    normalized -= FULL_CIRCLE_DEGREES;
  }
  return normalized;
}

export function normalizeFieldHeadingDegrees(degrees) {
  let normalized = degrees % FULL_CIRCLE_DEGREES;
  if (normalized < 0) {
    normalized += FULL_CIRCLE_DEGREES;
  }
  return normalized;
}

export function fieldHeadingToInternalDegrees(fieldHeadingDegrees) {
  return normalizeInternalHeadingDegrees(FIELD_TO_INTERNAL_OFFSET_DEGREES - fieldHeadingDegrees);
}

export function internalHeadingToFieldDegrees(internalHeadingDegrees) {
  return normalizeFieldHeadingDegrees(FIELD_TO_INTERNAL_OFFSET_DEGREES - internalHeadingDegrees);
}

export function headingDeltaDegrees(startHeadingDegrees, endHeadingDegrees) {
  return normalizeInternalHeadingDegrees(endHeadingDegrees - startHeadingDegrees);
}

export function isGnssHeadingReady(sample, options = {}) {
  const maxHeadingAccuracyDegrees = options.maxHeadingAccuracyDegrees ?? 1;
  const maxSampleAgeMillis = options.maxSampleAgeMillis ?? 1_000;

  return Boolean(
    sample &&
      sample.fixType === "fixed" &&
      typeof sample.headingDegrees === "number" &&
      Number.isFinite(sample.headingDegrees) &&
      typeof sample.headingAccuracyDegrees === "number" &&
      Number.isFinite(sample.headingAccuracyDegrees) &&
      sample.headingAccuracyDegrees <= maxHeadingAccuracyDegrees &&
      typeof sample.sampleAgeMillis === "number" &&
      Number.isFinite(sample.sampleAgeMillis) &&
      sample.sampleAgeMillis <= maxSampleAgeMillis,
  );
}

export function buildTurnCalibrationSummary(run) {
  const startAlignedImuHeadingInternalDeg = normalizeInternalHeadingDegrees(
    run.startRawImuHeadingInternalDeg + run.startOffsetInternalDeg,
  );
  const endAlignedImuHeadingInternalDeg = normalizeInternalHeadingDegrees(
    run.endRawImuHeadingInternalDeg + run.startOffsetInternalDeg,
  );
  const imuTurnInternalDeg = headingDeltaDegrees(
    run.startRawImuHeadingInternalDeg,
    run.endRawImuHeadingInternalDeg,
  );
  const gnssTurnInternalDeg = headingDeltaDegrees(
    run.startGnssHeadingInternalDeg,
    run.endGnssHeadingInternalDeg,
  );
  const startAlignmentErrorInternalDeg = headingDeltaDegrees(
    startAlignedImuHeadingInternalDeg,
    run.startGnssHeadingInternalDeg,
  );
  const endAlignmentErrorInternalDeg = headingDeltaDegrees(
    endAlignedImuHeadingInternalDeg,
    run.endGnssHeadingInternalDeg,
  );
  const scaleCorrection = Math.abs(imuTurnInternalDeg) < 1e-9
    ? null
    : Math.abs(gnssTurnInternalDeg) / Math.abs(imuTurnInternalDeg);

  return {
    startAlignedImuHeadingInternalDeg,
    endAlignedImuHeadingInternalDeg,
    imuTurnInternalDeg,
    gnssTurnInternalDeg,
    startAlignmentErrorInternalDeg,
    endAlignmentErrorInternalDeg,
    scaleCorrection,
  };
}
