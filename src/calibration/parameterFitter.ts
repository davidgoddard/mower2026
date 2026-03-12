import type {
  ArrivalCalibrationMetrics,
  CalibrationRecommendations,
  CalibrationTrialAnalysis,
  SpinCalibrationMetrics,
  StraightCalibrationMetrics,
} from "./calibrationTypes.js";

function average(values: ReadonlyArray<number>): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function spinMetrics(analyses: ReadonlyArray<CalibrationTrialAnalysis>): ReadonlyArray<SpinCalibrationMetrics> {
  return analyses.flatMap((analysis) => analysis.spinMetrics === undefined ? [] : [analysis.spinMetrics]);
}

function straightMetrics(analyses: ReadonlyArray<CalibrationTrialAnalysis>): ReadonlyArray<StraightCalibrationMetrics> {
  return analyses.flatMap((analysis) => analysis.straightMetrics === undefined ? [] : [analysis.straightMetrics]);
}

function arrivalMetrics(analyses: ReadonlyArray<CalibrationTrialAnalysis>): ReadonlyArray<ArrivalCalibrationMetrics> {
  return analyses.flatMap((analysis) => analysis.arrivalMetrics === undefined ? [] : [analysis.arrivalMetrics]);
}

export function fitCalibrationRecommendations(
  analyses: ReadonlyArray<CalibrationTrialAnalysis>,
): CalibrationRecommendations {
  const spins = spinMetrics(analyses);
  const straights = straightMetrics(analyses);
  const arrivals = arrivalMetrics(analyses);

  const averageExcursion = average(spins.map((metric) => metric.antennaPositionExcursionMeters));
  const averageOvershoot = average(spins.map((metric) => metric.peakOvershootDegrees));
  const averageStraightBias = average(straights.map((metric) => Math.abs(metric.meanSignedCrossTrackErrorMeters)));
  const averageStraightOscillation = average(straights.map((metric) => metric.rmsCrossTrackErrorMeters));
  const averageStraightPeakError = average(straights.map((metric) => metric.peakCrossTrackErrorMeters));
  const averageArrivalError = average(arrivals.map((metric) => metric.finalPositionErrorMeters));

  return {
    pivotAntennaExcursionMeters: Number(averageExcursion.toFixed(3)),
    recommendedTurnScale: Number(clamp(1 - (averageOvershoot / 45), 0.35, 1.0).toFixed(3)),
    recommendedLineGainScale: Number(clamp(1 - ((averageStraightBias * 0.8) + (averageStraightOscillation * 0.8) + (averageStraightPeakError * 0.4)), 0.5, 1.25).toFixed(3)),
    recommendedArrivalToleranceMeters: Number(clamp(Math.max(0.03, averageArrivalError * 1.25), 0.03, 0.25).toFixed(3)),
  };
}
