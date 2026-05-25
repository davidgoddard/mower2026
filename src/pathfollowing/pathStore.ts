/**
 * Path Store - Persistent storage for recorded paths
 */

import { readFile, writeFile, readdir, unlink, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { IPathStore, PathPoint, StoredPath } from "./pathFollowerApi.js";
import { LoggerScope } from "../logging/types.js";

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
    const path: StoredPath = {
      name,
      points,
      createdAt: Date.now(),
      metadata: {
        totalDistance: this.calculateTotalDistance(points),
        pointCount: points.length,
      },
    };

    await this.ensureStorageDirectory();

    // Update cache
    this.pathCache.set(name, path);

    // Persist to disk
    const filename = this.getFilename(name);
    const filepath = join(this.storageDirectory, filename);

    try {
      await writeFile(filepath, JSON.stringify(path, null, 2), "utf-8");

      this.logger.info("path_store.saved", {
        name,
        pointCount: points.length,
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
      const path: StoredPath = JSON.parse(content);

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
    // Sanitize name for filesystem
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${sanitized}${this.filenameSuffix}`;
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
