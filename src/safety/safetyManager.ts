import { hasCriticalFaults, hasStaleInputs, type SafetyContext } from "./faultRules.js";

export interface SafetyDecision {
  readonly allowMotion: boolean;
  readonly reason?: string;
}

export interface SafetyManager {
  evaluate(context: SafetyContext): SafetyDecision;
}

export class PermissiveSafetyManager implements SafetyManager {
  public evaluate(): SafetyDecision {
    return { allowMotion: true };
  }
}

export class RuleBasedSafetyManager implements SafetyManager {
  public evaluate(context: SafetyContext): SafetyDecision {
    if (hasCriticalFaults(context)) {
      return {
        allowMotion: false,
        reason: "critical_fault",
      };
    }

    if (hasStaleInputs(context)) {
      return {
        allowMotion: false,
        reason: "stale_input",
      };
    }

    return { allowMotion: true };
  }
}
