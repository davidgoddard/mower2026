import type { EventLogger } from "../logging/eventLogger.js";
import type { TelemetryLogger } from "../logging/telemetryLogger.js";
import {
  computeArrivalCalibrationMetrics,
  computeSpinCalibrationMetrics,
  computeStaticCalibrationMetrics,
  computeStraightCalibrationMetrics,
} from "./metrics.js";
import { fitCalibrationRecommendations } from "./parameterFitter.js";
import { summarizeCalibrationReport } from "./progressAssessment.js";
import { buildCalibrationSequence } from "./testSequences.js";
import type {
  CalibrationArea,
  CalibrationExecutor,
  CalibrationReport,
  CalibrationTrialAnalysis,
} from "./calibrationTypes.js";

export class CalibrationSupervisor {
  public constructor(
    private readonly executor: CalibrationExecutor,
    private readonly telemetryLogger: TelemetryLogger,
    private readonly eventLogger: EventLogger,
  ) {}

  public async run(area: CalibrationArea): Promise<CalibrationReport> {
    const analyses: CalibrationTrialAnalysis[] = [];
    const sequence = buildCalibrationSequence(area);

    this.eventLogger.log("calibration.sequence_started", {
      safeRadiusMeters: area.safeRadiusMeters,
      straightRunDistanceMeters: area.straightRunDistanceMeters,
      arrivalTargetDistanceMeters: area.arrivalTargetDistanceMeters,
      trialCount: sequence.length,
    });

    for (const definition of sequence) {
      this.eventLogger.log("calibration.trial_started", {
        trialId: definition.id,
        stage: definition.stage,
        motion: definition.motion,
      });

      const trial = await this.executor.runTrial(definition);
      const analysis: CalibrationTrialAnalysis = {
        trial,
        ...(definition.motion === "hold" ? { staticMetrics: computeStaticCalibrationMetrics(trial.samples) } : {}),
        ...(definition.motion === "spin" ? { spinMetrics: computeSpinCalibrationMetrics(definition, trial.samples) } : {}),
        ...(definition.motion === "drive_line" ? { straightMetrics: computeStraightCalibrationMetrics(definition, trial.samples) } : {}),
        ...(definition.motion === "arrive_target" ? { arrivalMetrics: computeArrivalCalibrationMetrics(definition, trial.samples) } : {}),
      };

      analyses.push(analysis);
      this.telemetryLogger.append("calibration.trial", {
        trialId: definition.id,
        stage: definition.stage,
        motion: definition.motion,
        completed: trial.completed,
        abortReason: trial.abortReason ?? null,
        staticMetrics: analysis.staticMetrics as unknown as Record<string, unknown> ?? null,
        spinMetrics: analysis.spinMetrics as unknown as Record<string, unknown> ?? null,
        straightMetrics: analysis.straightMetrics as unknown as Record<string, unknown> ?? null,
        arrivalMetrics: analysis.arrivalMetrics as unknown as Record<string, unknown> ?? null,
      });
      this.eventLogger.log("calibration.trial_completed", {
        trialId: definition.id,
        completed: trial.completed,
        abortReason: trial.abortReason ?? null,
      });
    }

    const recommendations = fitCalibrationRecommendations(analyses);
    const summary = summarizeCalibrationReport({
      area,
      trials: analyses,
      recommendations,
    });
    const report: CalibrationReport = {
      area,
      trials: analyses,
      recommendations,
      summary,
    };

    this.telemetryLogger.append("calibration.report", {
      trialCount: analyses.length,
      recommendations: recommendations as unknown as Record<string, unknown>,
      summary: report.summary as unknown as Record<string, unknown>,
    });
    this.eventLogger.log("calibration.sequence_completed", {
      trialCount: analyses.length,
    });

    return report;
  }
}
