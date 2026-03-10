import type { MeasurementBundle } from "../sensing/measurementTypes.js";

export interface SafetyContext {
  readonly gnss: MeasurementBundle;
  readonly motor: MeasurementBundle;
}

export function hasCriticalFaults(context: SafetyContext): boolean {
  return context.gnss.faultFlags !== 0 || context.motor.faultFlags !== 0;
}

export function hasStaleInputs(context: SafetyContext): boolean {
  return context.gnss.stale || context.motor.stale;
}
