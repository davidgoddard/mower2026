import type { EventLogger } from "../logging/eventLogger.js";

export class CalibrationApp {
  public constructor(private readonly eventLogger: EventLogger) {}

  public start(): void {
    this.eventLogger.log("calibration.start_requested", {});
  }
}
