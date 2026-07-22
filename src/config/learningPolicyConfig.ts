import { LoggerScope } from "../logging/types.js";
import { SessionLogger } from "../logging/index.js";
import { readJsonFile } from "./jsonFileStore.js";

export type LearningPolicyMode = "training_only" | "always";
export type LearningSource = "operation" | "training";

export interface LearningPolicy {
  allows(source?: LearningSource): boolean;
}

export class LearningPolicyConfig implements LearningPolicy {
  private readonly logger: LoggerScope;
  private readonly path: string;
  private mode: LearningPolicyMode = "training_only";

  constructor(options: { logger: SessionLogger; path?: string }) {
    this.logger = options.logger.child({ context: "config", source: "LearningPolicyConfig" });
    this.path = options.path ?? "config/learning-policy.json";
  }

  async load(): Promise<void> {
    try {
      const raw = await readJsonFile(this.path) as { mode?: unknown };
      this.mode = raw?.mode === "always" ? "always" : "training_only";
      this.logger.info("learning_policy.loaded", { path: this.path, mode: this.mode });
    } catch (error) {
      this.mode = "training_only";
      this.logger.warn("learning_policy.load_failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
        using: this.mode,
      });
    }
  }

  allows(source: LearningSource = "operation"): boolean {
    return this.mode === "always" || source === "training";
  }
}
