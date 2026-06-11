/**
 * Path Store - Persistent storage for recorded paths
 */

import { readFile, readdir, unlink, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { IPathStore, PathPoint, StoredPath } from "./pathFollowerApi.js";
import { LoggerScope } from "../logging/types.js";
import { writeJsonFile } from "../config/jsonFileStore.js";

const SANITIZED_NAME_MAX_LEN = 64;

export interface PathStoreOptions {
  storageDirectory: string;
  logger: LoggerScope;
  filenameSuffix?: string;
}

export class PathStore implements IPathStore {
  private readonly storageDirectory: string;
  private readonly logger: LoggerScope;
  private readonly filenameSuffix: string;
  private readonly pathCache: Map<string, StoredPath> = new Map();

  constructor(options: PathStoreOptions) {
    this.storageDirectory = options.storageDirectory;
    this.logger = options.logger;
    this.filenameSuffix = options.filenameSuffix ?? ".path.json";
  }

  private async ensureStorageDirectory(): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
  }

  async savePath(name: string, points: PathPoint[]): Promise<void> {
    // Defensive copy: caller may continue to mutate the passed array (the
    // recorder appends new points after stop), and the cached value would
    // otherwise alias their state.
    const snapshotPoints = points.slice();
    const path: StoredPath = {
      name,
      points: snapshotPoints,
      createdAt: Date.now(),
      metadata: {
        totalDistance: this.calculateTotalDistance(snapshotPoints),
        pointCount: snapshotPoints.length,
      },
    };

    await this.ensureStorageDirectory();

    // Update cache
    this.pathCache.set(name, path);

    // Persist to disk via atomic write (tmp file + rename)
    const filename = this.getFilename(name);
    const filepath = join(this.storageDirectory, filename);

    try {
      await writeJsonFile(filepath, path);

      this.logger.info("path_store.saved", {
        name,
        pointCount: snapshotPoints.length,
        totalDistance: path.metadata.totalDistance,
        filepath,
      });
    } catch (error) {
      this.logger.error("path_store.save_failed", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async loadPath(name: string): Promise<StoredPath> {
    // Check cache first
    if (this.pathCache.has(name)) {
      this.logger.debug("path_store.loaded_from_cache", { name });
      return this.pathCache.get(name)!;
    }

    // Load from disk
    const filename = this.getFilename(name);
    const filepath = join(this.storageDirectory, filename);

    try {
      await this.ensureStorageDirectory();
      const content = await readFile(filepath, "utf-8");
      const path = this.normalizeStoredPath(JSON.parse(content));

      // Update cache
      this.pathCache.set(name, path);

      this.logger.info("path_store.loaded", {
        name,
        pointCount: path.points.length,
        filepath,
      });

      return path;
    } catch (error) {
      this.logger.error("path_store.load_failed", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to load path '${name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listPaths(): Promise<string[]> {
    try {
      await this.ensureStorageDirectory();
      const files = await readdir(this.storageDirectory);
      const pathFiles = files.filter((f: string) => f.endsWith(this.filenameSuffix) && !f.startsWith(".") && !f.startsWith("._"));
      const names = pathFiles.map((f: string) => f.slice(0, -this.filenameSuffix.length));

      this.logger.debug("path_store.list", { count: names.length });

      return names;
    } catch (error) {
      this.logger.error("path_store.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async deletePath(name: string): Promise<void> {
    const filename = this.getFilename(name);
    const filepath = join(this.storageDirectory, filename);

    try {
      await this.ensureStorageDirectory();
      await unlink(filepath);

      // Remove from cache
      this.pathCache.delete(name);

      this.logger.info("path_store.deleted", { name, filepath });
    } catch (error) {
      this.logger.error("path_store.delete_failed", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async pathExists(name: string): Promise<boolean> {
    // Check cache
    if (this.pathCache.has(name)) {
      return true;
    }

    // Check disk
    const filename = this.getFilename(name);
    const filepath = join(this.storageDirectory, filename);

    try {
      await this.ensureStorageDirectory();
      await access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  private getFilename(name: string): string {
    // Sanitize name for filesystem and cap length so an absurdly long name
    // cannot generate an oversized filename.
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, SANITIZED_NAME_MAX_LEN);
    return `${sanitized}${this.filenameSuffix}`;
  }

  private normalizeStoredPath(raw: unknown): StoredPath {
    const value = raw as Partial<StoredPath>;
    const points = Array.isArray(value.points) ? value.points : [];
    const metadata = (typeof value.metadata === "object" && value.metadata !== null)
      ? value.metadata as Partial<StoredPath["metadata"]>
      : {};
    return {
      name: typeof value.name === "string" ? value.name : "",
      points,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      metadata: {
        totalDistance: typeof metadata.totalDistance === "number"
          ? metadata.totalDistance
          : this.calculateTotalDistance(points),
        pointCount: typeof metadata.pointCount === "number" ? metadata.pointCount : points.length,
      },
    };
  }

  private calculateTotalDistance(points: PathPoint[]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].xMeters - points[i].xMeters;
      const dy = points[i + 1].yMeters - points[i].yMeters;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }
}
