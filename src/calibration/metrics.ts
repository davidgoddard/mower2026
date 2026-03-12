import type { Pose2D } from "../estimation/estimatorTypes.js";
import { normalizeAngleDegrees } from "../util/angles.js";
import {
  evaluateLineTrackingError,
  projectPointOntoSegment,
  targetHeadingDegrees,
} from "../guidance/lineGeometry.js";
import type {
  ArrivalCalibrationMetrics,
  CalibrationSample,
  CalibrationTrialDefinition,
  SpinCalibrationMetrics,
  StaticCalibrationMetrics,
  StraightCalibrationMetrics,
} from "./calibrationTypes.js";
import { resolveRelativeTargetPose } from "./automaticCalibrationController.js";

function durationMillis(samples: ReadonlyArray<CalibrationSample>): number {
  if (samples.length < 2) {
    return 0;
  }
  return samples[samples.length - 1]!.timestampMillis - samples[0]!.timestampMillis;
}

function basePose(samples: ReadonlyArray<CalibrationSample>): Pose2D {
  const first = samples[0]!.estimate;
  return {
    xMeters: first.xMeters,
    yMeters: first.yMeters,
    headingDegrees: first.headingDegrees,
  };
}

function unwrapHeadingDeltaDegrees(samples: ReadonlyArray<CalibrationSample>): ReadonlyArray<number> {
  const initialHeading = samples[0]!.estimate.headingDegrees;
  return samples.map((sample) => normalizeAngleDegrees(sample.estimate.headingDegrees - initialHeading));
}

function rms(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  const sumSquares = values.reduce((sum, value) => sum + (value * value), 0);
  return Math.sqrt(sumSquares / values.length);
}

function mean(values: ReadonlyArray<number>): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeStaticCalibrationMetrics(samples: ReadonlyArray<CalibrationSample>): StaticCalibrationMetrics {
  const rolls = samples.map((sample) => sample.imuRollDegrees ?? 0);
  const pitch = samples.map((sample) => sample.imuPitchDegrees ?? 0);
  const headingDeltas = unwrapHeadingDeltaDegrees(samples);

  return {
    durationMillis: durationMillis(samples),
    rollDriftDegrees: rolls.length === 0 ? 0 : Math.max(...rolls) - Math.min(...rolls),
    pitchDriftDegrees: pitch.length === 0 ? 0 : Math.max(...pitch) - Math.min(...pitch),
    headingDriftDegrees: headingDeltas.length === 0 ? 0 : Math.max(...headingDeltas) - Math.min(...headingDeltas),
  };
}

export function computeSpinCalibrationMetrics(
  definition: CalibrationTrialDefinition,
  samples: ReadonlyArray<CalibrationSample>,
): SpinCalibrationMetrics {
  const headingDeltas = unwrapHeadingDeltaDegrees(samples);
  const targetDelta = definition.targetHeadingChangeDegrees ?? 0;
  const achievedDelta = headingDeltas[headingDeltas.length - 1] ?? 0;
  const signedErrors = headingDeltas.map((delta) => normalizeAngleDegrees(delta - targetDelta));
  const peakOvershootDegrees = targetDelta >= 0
    ? Math.max(0, ...headingDeltas.map((delta) => delta - targetDelta))
    : Math.max(0, ...headingDeltas.map((delta) => targetDelta - delta));
  const initial = samples[0]!.estimate;
  const antennaPositionExcursionMeters = Math.max(
    ...samples.map((sample) => Math.hypot(
      sample.estimate.xMeters - initial.xMeters,
      sample.estimate.yMeters - initial.yMeters,
    )),
  );

  return {
    targetHeadingChangeDegrees: targetDelta,
    achievedHeadingChangeDegrees: achievedDelta,
    finalHeadingErrorDegrees: signedErrors[signedErrors.length - 1] ?? 0,
    peakOvershootDegrees,
    antennaPositionExcursionMeters,
    durationMillis: durationMillis(samples),
  };
}

export function computeStraightCalibrationMetrics(
  definition: CalibrationTrialDefinition,
  samples: ReadonlyArray<CalibrationSample>,
): StraightCalibrationMetrics {
  const initial = basePose(samples);
  const sign = definition.direction === "reverse" ? -1 : 1;
  const distance = definition.distanceMeters ?? 0;
  const headingRadians = ((initial.headingDegrees + (sign < 0 ? 180 : 0)) * Math.PI) / 180;
  const segment = {
    start: initial,
    end: {
      xMeters: initial.xMeters + Math.cos(headingRadians) * distance,
      yMeters: initial.yMeters + Math.sin(headingRadians) * distance,
      headingDegrees: normalizeAngleDegrees(initial.headingDegrees + (sign < 0 ? 180 : 0)),
    },
  };
  const errors = samples.map((sample) => evaluateLineTrackingError(sample.estimate, segment));
  const finalProjection = projectPointOntoSegment(samples[samples.length - 1]!.estimate, segment);

  return {
    targetDistanceMeters: distance,
    achievedDistanceMeters: finalProjection.clampedAlongTrackMeters,
    rmsCrossTrackErrorMeters: rms(errors.map((error) => error.crossTrackErrorMeters)),
    peakCrossTrackErrorMeters: Math.max(...errors.map((error) => Math.abs(error.crossTrackErrorMeters))),
    meanSignedCrossTrackErrorMeters: mean(errors.map((error) => error.crossTrackErrorMeters)),
    finalCrossTrackErrorMeters: errors[errors.length - 1]?.crossTrackErrorMeters ?? 0,
    headingRmsErrorDegrees: rms(errors.map((error) => error.headingErrorDegrees)),
    durationMillis: durationMillis(samples),
  };
}

export function computeArrivalCalibrationMetrics(
  definition: CalibrationTrialDefinition,
  samples: ReadonlyArray<CalibrationSample>,
): ArrivalCalibrationMetrics {
  const initial = basePose(samples);
  const target = definition.targetPose === undefined ? initial : resolveRelativeTargetPose(initial, definition.targetPose);
  const final = samples[samples.length - 1]!.estimate;
  const segment = {
    start: initial,
    end: target,
  };
  const peakCrossTrackErrorMeters = Math.max(
    ...samples.map((sample) => Math.abs(evaluateLineTrackingError(sample.estimate, segment).crossTrackErrorMeters)),
  );

  return {
    targetDistanceMeters: Math.hypot(target.xMeters - initial.xMeters, target.yMeters - initial.yMeters),
    finalPositionErrorMeters: Math.hypot(final.xMeters - target.xMeters, final.yMeters - target.yMeters),
    finalHeadingErrorDegrees: normalizeAngleDegrees(final.headingDegrees - target.headingDegrees),
    peakCrossTrackErrorMeters,
    durationMillis: durationMillis(samples),
  };
}

export function describeTargetHeading(definition: CalibrationTrialDefinition, samples: ReadonlyArray<CalibrationSample>): number {
  if (definition.motion === "drive_line") {
    const initial = basePose(samples);
    return normalizeAngleDegrees(initial.headingDegrees + (definition.direction === "reverse" ? 180 : 0));
  }
  if (definition.targetPose !== undefined) {
    return targetHeadingDegrees({
      start: basePose(samples),
      end: definition.targetPose,
    });
  }
  return samples[0]!.estimate.headingDegrees;
}
