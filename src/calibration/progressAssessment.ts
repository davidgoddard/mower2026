import type {
  CalibrationGoalQuality,
  CalibrationGoalStatus,
  CalibrationProgressSummary,
  CalibrationReport,
  CalibrationTrialAnalysis,
} from "./calibrationTypes.js";

function average(values: ReadonlyArray<number>): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: ReadonlyArray<number>): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function classify(value: number, greenThreshold: number, orangeThreshold: number): CalibrationGoalQuality {
  if (value <= greenThreshold) {
    return "green";
  }
  if (value <= orangeThreshold) {
    return "orange";
  }
  return "red";
}

function goal(label: string, value: number, target: number, orangeThreshold: number): CalibrationGoalStatus {
  return {
    label,
    value: Number(value.toFixed(3)),
    target,
    quality: classify(value, target, orangeThreshold),
  };
}

function turnValue(analyses: ReadonlyArray<CalibrationTrialAnalysis>): number {
  const spins = analyses.flatMap((analysis) => analysis.spinMetrics === undefined ? [] : [analysis.spinMetrics]);
  return max(spins.map((metric) => Math.max(Math.abs(metric.finalHeadingErrorDegrees), metric.peakOvershootDegrees)));
}

function lineValue(analyses: ReadonlyArray<CalibrationTrialAnalysis>): number {
  const straights = analyses.flatMap((analysis) => analysis.straightMetrics === undefined ? [] : [analysis.straightMetrics]);
  return max(straights.map((metric) => Math.max(metric.peakCrossTrackErrorMeters, Math.abs(metric.finalCrossTrackErrorMeters))));
}

function arrivalValue(analyses: ReadonlyArray<CalibrationTrialAnalysis>): number {
  const arrivals = analyses.flatMap((analysis) => analysis.arrivalMetrics === undefined ? [] : [analysis.arrivalMetrics]);
  return average(arrivals.map((metric) => metric.finalPositionErrorMeters));
}

export function summarizeCalibrationReport(report: CalibrationReport): CalibrationProgressSummary {
  return {
    turn: goal("Turning accuracy", turnValue(report.trials), 0.5, 2.0),
    line: goal("Straight-line tracking", lineValue(report.trials), 0.02, 0.06),
    arrival: goal("Arrival distance", arrivalValue(report.trials), 0.05, 0.12),
  };
}
