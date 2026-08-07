import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { unwrapInternalHeading } from "../geometry/headingTypes.js";
import { unwrapMeters, type Pose } from "../geometry/positionTypes.js";
import type { LoggerScope } from "../logging/types.js";

export interface MowingProgressPoint {
  readonly sequence: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly timestamp: number;
}

interface PoseSource {
  on(event: "poseUpdate", listener: (pose: Pose) => void): void;
  off(event: "poseUpdate", listener: (pose: Pose) => void): void;
}

export interface MowingProgressStoreOptions {
  readonly filePath?: string;
  readonly sampleIntervalMs?: number;
  readonly now?: () => number;
  readonly logger?: LoggerScope;
}

const DEFAULT_PROGRESS_FILE_PATH = "./data/mowing-progress.jsonl";
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/**
 * Persists the live mowing trail independently of the operator's browser.
 * File operations are queued through asynchronous fs calls and are never
 * awaited by the pose-update event path.
 */
export class MowingProgressStore {
  private readonly filePath: string;
  private readonly sampleIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: LoggerScope | undefined;
  private readonly onPoseUpdateBound: (pose: Pose) => void;
  private writeQueue: Promise<void> = Promise.resolve();
  private recording = false;
  private sequence = 0;
  private lastSampleAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly poseSource: PoseSource,
    options: MowingProgressStoreOptions = {},
  ) {
    this.filePath = options.filePath ?? DEFAULT_PROGRESS_FILE_PATH;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.onPoseUpdateBound = this.onPoseUpdate.bind(this);
    this.poseSource.on("poseUpdate", this.onPoseUpdateBound);
  }

  async startFresh(): Promise<void> {
    this.recording = false;
    await this.flush();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, "", "utf8");
    this.sequence = 0;
    this.lastSampleAt = Number.NEGATIVE_INFINITY;
    this.recording = true;
  }

  async continueExisting(): Promise<void> {
    const points = await this.readPoints();
    this.sequence = points.length === 0 ? 0 : points[points.length - 1].sequence + 1;
    this.lastSampleAt = Number.NEGATIVE_INFINITY;
    this.recording = true;
  }

  pause(): void {
    this.recording = false;
  }

  async readPoints(): Promise<MowingProgressPoint[]> {
    await this.flush();
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const points: MowingProgressPoint[] = [];
    for (const line of contents.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const point = JSON.parse(line) as Partial<MowingProgressPoint>;
        if (
          Number.isInteger(point.sequence)
          && Number.isFinite(point.x)
          && Number.isFinite(point.y)
          && Number.isFinite(point.heading)
          && Number.isFinite(point.timestamp)
        ) {
          points.push(point as MowingProgressPoint);
        }
      } catch (_error) {
        // A power loss can leave one partial final JSONL row. Keep prior rows.
      }
    }
    return points;
  }

  async close(): Promise<void> {
    this.pause();
    this.poseSource.off("poseUpdate", this.onPoseUpdateBound);
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private onPoseUpdate(pose: Pose): void {
    if (!this.recording) {
      return;
    }
    const timestamp = this.now();
    if (timestamp - this.lastSampleAt < this.sampleIntervalMs) {
      return;
    }

    const point: MowingProgressPoint = {
      sequence: this.sequence,
      x: unwrapMeters(pose.position.xMeters),
      y: unwrapMeters(pose.position.yMeters),
      heading: unwrapInternalHeading(pose.heading),
      timestamp,
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.heading)) {
      return;
    }

    this.sequence += 1;
    this.lastSampleAt = timestamp;
    const line = `${JSON.stringify(point)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((error) => {
        this.logger?.error("mowing_progress.append_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
