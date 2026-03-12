import type { ParameterStore } from "../config/parameterStore.js";
import type { EventLogger } from "../logging/eventLogger.js";
import type { TelemetryLogger } from "../logging/telemetryLogger.js";
import { CalibrationSupervisor } from "../calibration/calibrationSupervisor.js";
import type { CalibrationArea, CalibrationExecutor, CalibrationReport } from "../calibration/calibrationTypes.js";

export class CalibrationApp {
  private readonly supervisor: CalibrationSupervisor;

  public constructor(
    private readonly deps: {
      readonly executor: CalibrationExecutor;
      readonly telemetryLogger: TelemetryLogger;
      readonly eventLogger: EventLogger;
      readonly parameterStore: ParameterStore;
    },
  ) {
    this.supervisor = new CalibrationSupervisor(
      deps.executor,
      deps.telemetryLogger,
      deps.eventLogger,
    );
  }

  public async start(area: CalibrationArea): Promise<CalibrationReport> {
    await this.deps.parameterStore.load();
    this.deps.eventLogger.log("calibration.start_requested", {
      parameterRevision: this.deps.parameterStore.currentRevision(),
    });
    return this.supervisor.run(area);
  }
}
