import { unlink } from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../config/jsonFileStore.js";
import { LoggerScope } from "../logging/types.js";
import { MowingPlan, MowingInitialEntryPlan } from "./mowingPlanner.js";
import { PathPoint } from "./pathFollowerApi.js";
import type { MowingPhase } from "./mowingExecutor.js";

export type MowingResumeStage =
  | "initial_entry_approach"
  | "initial_boundary_trace"
  | "strip_approach"
  | "start_boundary_trace"
  | "strip_turn"
  | "strip_drive"
  | "end_boundary_trace"
  | "connector_follow"
  | "complete";

export interface MowingResumeContinuation {
  readonly stage: MowingResumeStage;
  readonly stripIndex: number;
}

export interface MowingResumeFollowOptions {
  readonly loopPath: boolean;
  readonly preserveFirstTargetAtPose?: boolean;
  readonly strictOrderedProgress?: boolean;
  readonly minimumSpeed?: number;
  readonly pivotIfInnerWheelBelow?: number;
}

export type MowingResumeOperation =
  | {
    readonly kind: "drive";
    readonly phase: MowingPhase;
    readonly stripIndex: number;
    readonly targetX: number;
    readonly targetY: number;
    readonly errorCode: string;
    readonly continuation: MowingResumeContinuation;
  }
  | {
    readonly kind: "turn";
    readonly phase: MowingPhase;
    readonly stripIndex: number;
    readonly targetHeadingDeg: number;
    readonly continuation: MowingResumeContinuation;
  }
  | {
    readonly kind: "follow_path";
    readonly phase: MowingPhase;
    readonly stripIndex: number;
    readonly pathPoints: PathPoint[];
    readonly followOptions: MowingResumeFollowOptions;
    readonly errorCode: string;
    readonly continuation: MowingResumeContinuation;
    readonly markBoundaryTraced?: string;
  };

export interface MowingResumeState {
  readonly version: 1;
  readonly areaName: string;
  readonly savedAt: number;
  readonly currentStripIndex: number;
  readonly totalStrips: number;
  readonly tracedBoundaryKeys: string[];
  readonly plan: MowingPlan;
  readonly areaPoints: PathPoint[];
  readonly obstaclePointsArray: PathPoint[][];
  readonly initialEntryPlan: MowingInitialEntryPlan | null;
  readonly activeOperation: MowingResumeOperation;
}

export interface MowingResumeStoreOptions {
  readonly filePath: string;
  readonly logger: LoggerScope;
}

export class MowingResumeStore {
  private readonly filePath: string;
  private readonly logger: LoggerScope;

  constructor(options: MowingResumeStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
  }

  async loadState(): Promise<MowingResumeState | null> {
    try {
      const value = await readJsonFile(this.filePath);
      const state = this.normalizeState(value);
      if (!state) {
        this.logger.warn("mowing_resume.invalid_state", { filePath: this.filePath });
        return null;
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        return null;
      }
      this.logger.error("mowing_resume.load_failed", { error: message, filePath: this.filePath });
      return null;
    }
  }

  async saveState(state: MowingResumeState): Promise<void> {
    await writeJsonFile(this.filePath, state);
    this.logger.info("mowing_resume.saved", {
      areaName: state.areaName,
      stripIndex: state.currentStripIndex,
      operationKind: state.activeOperation.kind,
    });
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
      this.logger.info("mowing_resume.cleared", { filePath: this.filePath });
    } catch {
      return;
    }
  }

  private normalizeState(raw: unknown): MowingResumeState | null {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const state = raw as Partial<MowingResumeState>;
    if (state.version !== 1 || typeof state.areaName !== "string") {
      return null;
    }
    if (!Array.isArray(state.areaPoints) || !Array.isArray(state.obstaclePointsArray) || !Array.isArray(state.tracedBoundaryKeys)) {
      return null;
    }
    if (typeof state.currentStripIndex !== "number" || typeof state.totalStrips !== "number") {
      return null;
    }
    if (!state.plan || !state.activeOperation) {
      return null;
    }
    return state as MowingResumeState;
  }
}
