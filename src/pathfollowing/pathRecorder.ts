/**
 * Path Recorder - Records paths during manual driving or dragging
 */

import { IPathRecorder, PathRecorderOptions, PathPoint, StoredPath, IPathStore } from "./pathFollowerApi.js";
import { Pose } from "../geometry/positionTypes.js";
import { unwrapMeters } from "../geometry/positionTypes.js";
import { LoggerScope } from "../logging/types.js";

export interface PathRecorderDependencies {
  pathStore: IPathStore;
  poseFusion: {
    on(event: "poseUpdate", listener: (pose: Pose) => void): void;
    off(event: "poseUpdate", listener: (pose: Pose) => void): void;
  };
}

export class PathRecorder implements IPathRecorder {
  private readonly distanceThreshold: number;
  private readonly logger: LoggerScope;
  private readonly deps: PathRecorderDependencies;

  private recording: boolean = false;
  private currentPath: PathPoint[] = [];
  private currentPathName: string = "";
  private lastRecordedPosition: { xMeters: number; yMeters: number } | null = null;
  private boundOnPoseUpdate: ((pose: Pose) => void) | null = null;

  constructor(options: PathRecorderOptions, dependencies: PathRecorderDependencies) {
    this.distanceThreshold = options.distanceThreshold;
    this.logger = options.logger;
    this.deps = dependencies;
  }

  startRecording(pathName: string): void {
    if (this.recording) {
      this.logger.warn("path_recorder.already_recording", { currentPath: this.currentPathName });
      return;
    }

    this.recording = true;
    this.currentPath = [];
    this.currentPathName = pathName;
    this.lastRecordedPosition = null;

    // Subscribe to pose updates
    this.boundOnPoseUpdate = this.onPoseUpdate.bind(this);
    this.deps.poseFusion.on("poseUpdate", this.boundOnPoseUpdate);

    this.logger.info("path_recorder.started", {
      pathName,
      distanceThreshold: this.distanceThreshold,
    });
  }

  async stopAndSave(): Promise<StoredPath> {
    if (!this.recording) {
      throw new Error("Not currently recording");
    }

    this.recording = false;

    // Unsubscribe from pose updates
    if (this.boundOnPoseUpdate) {
      this.deps.poseFusion.off("poseUpdate", this.boundOnPoseUpdate);
      this.boundOnPoseUpdate = null;
    }

    const pointCount = this.currentPath.length;

    this.logger.info("path_recorder.stopping", {
      pathName: this.currentPathName,
      pointCount,
    });

    // Save path
    await this.deps.pathStore.savePath(this.currentPathName, this.currentPath);

    // Load and return the saved path
    const savedPath = await this.deps.pathStore.loadPath(this.currentPathName);

    this.logger.info("path_recorder.saved", {
      pathName: this.currentPathName,
      pointCount,
    });

    // Clear state
    this.currentPath = [];
    this.currentPathName = "";
    this.lastRecordedPosition = null;

    return savedPath;
  }

  cancel(): void {
    if (!this.recording) {
      this.logger.warn("path_recorder.cancel_not_recording");
      return;
    }

    this.recording = false;

    // Unsubscribe from pose updates
    if (this.boundOnPoseUpdate) {
      this.deps.poseFusion.off("poseUpdate", this.boundOnPoseUpdate);
      this.boundOnPoseUpdate = null;
    }

    this.logger.info("path_recorder.cancelled", {
      pathName: this.currentPathName,
      pointsDiscarded: this.currentPath.length,
    });

    // Clear state
    this.currentPath = [];
    this.currentPathName = "";
    this.lastRecordedPosition = null;
  }

  isRecording(): boolean {
    return this.recording;
  }

  getPointCount(): number {
    return this.currentPath.length;
  }

  /**
   * Handle pose updates from pose fusion
   */
  private onPoseUpdate(pose: Pose): void {
    if (!this.recording) {
      return;
    }

    const position = {
      xMeters: unwrapMeters(pose.position.xMeters),
      yMeters: unwrapMeters(pose.position.yMeters),
    };

    // First point - always record
    if (this.lastRecordedPosition === null) {
      this.recordPoint(position);
      return;
    }

    // Only record if moved more than threshold
    const distance = this.distanceBetween(position, this.lastRecordedPosition);
    if (distance >= this.distanceThreshold) {
      this.recordPoint(position);
    }
  }

  /**
   * Record a point to the current path
   */
  private recordPoint(position: { xMeters: number; yMeters: number }): void {
    const point: PathPoint = {
      xMeters: position.xMeters,
      yMeters: position.yMeters,
      capturedAt: Date.now(),
    };

    this.currentPath.push(point);
    this.lastRecordedPosition = position;

    this.logger.debug("path_recorder.point_recorded", {
      pathName: this.currentPathName,
      pointCount: this.currentPath.length,
      x: position.xMeters,
      y: position.yMeters,
    });
  }

  /**
   * Calculate distance between two positions
   */
  private distanceBetween(
    p1: { xMeters: number; yMeters: number },
    p2: { xMeters: number; yMeters: number }
  ): number {
    const dx = p2.xMeters - p1.xMeters;
    const dy = p2.yMeters - p1.yMeters;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
