import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface MowingRecord {
  id: string;
  areaName: string;
  headingDeg: number;
  stripWidthMeters: number;
  completedAt: string;
}

export interface MowingPreset {
  id: string;
  name: string;
  areaName: string;
  headingDeg: number;
  stripWidthMeters: number;
}

export interface BladeMaintenance {
  lastSharpenedAt: string | null;
  sharpeningIntervalMeters: number;
  metersSinceSharpening: number;
}

export interface MowingRecordsData {
  version: 2;
  history: MowingRecord[];
  presets: MowingPreset[];
  bladeMaintenance: BladeMaintenance;
}

const DEFAULT_DATA: MowingRecordsData = {
  version: 2,
  history: [],
  presets: [],
  bladeMaintenance: { lastSharpenedAt: null, sharpeningIntervalMeters: 10_000, metersSinceSharpening: 0 },
};

function finiteInRange(value: unknown, minimum: number, maximum: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${field}_invalid`);
  return parsed;
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field}_required`);
  return text;
}

export class MowingRecordsStore {
  private data: MowingRecordsData = structuredClone(DEFAULT_DATA);
  constructor(private readonly path = "./data/mowing-records.json") {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonFile(this.path) as Partial<MowingRecordsData>;
      this.data = {
        version: 2,
        history: Array.isArray(raw.history) ? raw.history : [],
        presets: Array.isArray(raw.presets) ? raw.presets : [],
        bladeMaintenance: {
          lastSharpenedAt: typeof raw.bladeMaintenance?.lastSharpenedAt === "string" ? raw.bladeMaintenance.lastSharpenedAt : null,
          sharpeningIntervalMeters: Number.isFinite(raw.bladeMaintenance?.sharpeningIntervalMeters) && Number(raw.bladeMaintenance?.sharpeningIntervalMeters) > 0
            ? Number(raw.bladeMaintenance?.sharpeningIntervalMeters) : DEFAULT_DATA.bladeMaintenance.sharpeningIntervalMeters,
          metersSinceSharpening: Number.isFinite(raw.bladeMaintenance?.metersSinceSharpening) && Number(raw.bladeMaintenance?.metersSinceSharpening) >= 0
            ? Number(raw.bladeMaintenance?.metersSinceSharpening) : 0,
        },
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await this.persist();
    }
  }

  snapshot(): MowingRecordsData { return structuredClone(this.data); }

  async recordMowing(areaName: string, headingDeg: number, stripWidthMeters: number, completedAt = new Date().toISOString()): Promise<MowingRecord> {
    const record = {
      id: `mowing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      areaName: requiredText(areaName, "area_name"),
      headingDeg: finiteInRange(headingDeg, 0, 179.999, "heading"),
      stripWidthMeters: finiteInRange(stripWidthMeters, 0.1, 0.4, "strip_width"),
      completedAt,
    };
    this.data.history.unshift(record);
    await this.persist();
    return record;
  }

  async savePreset(input: Omit<MowingPreset, "id"> & { id?: string }): Promise<MowingPreset> {
    const preset: MowingPreset = {
      id: input.id?.trim() || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: requiredText(input.name, "preset_name"),
      areaName: requiredText(input.areaName, "area_name"),
      headingDeg: finiteInRange(input.headingDeg, 0, 179.999, "heading"),
      stripWidthMeters: finiteInRange(input.stripWidthMeters, 0.1, 0.4, "strip_width"),
    };
    const index = this.data.presets.findIndex((entry) => entry.id === preset.id);
    if (index >= 0) this.data.presets[index] = preset; else this.data.presets.push(preset);
    await this.persist();
    return preset;
  }

  async deletePreset(id: string): Promise<void> {
    const next = this.data.presets.filter((preset) => preset.id !== id);
    if (next.length === this.data.presets.length) throw new Error("preset_not_found");
    this.data.presets = next;
    await this.persist();
  }

  async updateBladeMaintenance(lastSharpenedAt: unknown, sharpeningIntervalMeters: unknown): Promise<BladeMaintenance> {
    const date = requiredText(lastSharpenedAt, "last_sharpened_at");
    if (Number.isNaN(Date.parse(date))) throw new Error("last_sharpened_at_invalid");
    const interval = finiteInRange(sharpeningIntervalMeters, 1, 10_000_000, "sharpening_interval_meters");
    const resetUsage = this.data.bladeMaintenance.lastSharpenedAt !== date;
    this.data.bladeMaintenance = {
      lastSharpenedAt: date,
      sharpeningIntervalMeters: interval,
      metersSinceSharpening: resetUsage ? 0 : this.data.bladeMaintenance.metersSinceSharpening,
    };
    await this.persist();
    return structuredClone(this.data.bladeMaintenance);
  }

  async addBladeTravelMeters(distanceMeters: number): Promise<void> {
    const distance = finiteInRange(distanceMeters, 0, 1_000_000, "blade_travel_meters");
    if (distance === 0) return;
    this.data.bladeMaintenance.metersSinceSharpening += distance;
    await this.persist();
  }

  private persist(): Promise<void> { return writeJsonFile(this.path, this.data); }
}
