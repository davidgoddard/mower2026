import type { ParameterSet } from "./parameterSchema.js";
import { defaultParameters } from "./defaults.js";
import { validateParameters } from "./parameterValidator.js";

export interface ParameterStore {
  load(): Promise<void>;
  get(): ParameterSet;
  currentRevision(): string;
}

export class InMemoryParameterStore implements ParameterStore {
  private parameters: ParameterSet = defaultParameters;

  public async load(): Promise<void> {
    const issues = validateParameters(this.parameters);
    if (issues.length > 0) {
      throw new Error(`Invalid default parameters: ${issues.map((issue) => `${String(issue.field)} ${issue.message}`).join("; ")}`);
    }
    return Promise.resolve();
  }

  public get(): ParameterSet {
    return this.parameters;
  }

  public currentRevision(): string {
    return "defaults";
  }
}
