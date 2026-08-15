import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface RechargePoint { readonly xMeters: number; readonly yMeters: number }
export interface RechargeConfiguration {
  readonly enabled: boolean;
  readonly chargingPosition: RechargePoint | null;
  readonly driveToPosition: RechargePoint | null;
  readonly dockingWheelOutputPercent: number;
}

export const DEFAULT_RECHARGE_CONFIGURATION: RechargeConfiguration = {
  enabled: true,
  chargingPosition: null,
  driveToPosition: null,
  dockingWheelOutputPercent: 0.3,
};

export class RechargeConfigStore {
  constructor(private readonly filePath = "./data/recharge-config.json") {}
  async load(): Promise<RechargeConfiguration> {
    try {
      const value = await readJsonFile(this.filePath) as Partial<RechargeConfiguration>;
      return this.validate(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_RECHARGE_CONFIGURATION;
      throw error;
    }
  }
  async save(value: RechargeConfiguration): Promise<RechargeConfiguration> {
    const checked = this.validate(value);
    await writeJsonFile(this.filePath, checked);
    return checked;
  }
  private validate(value: Partial<RechargeConfiguration>): RechargeConfiguration {
    const point = (candidate: RechargePoint | null | undefined): RechargePoint | null => candidate
      && Number.isFinite(candidate.xMeters) && Number.isFinite(candidate.yMeters)
      ? { xMeters: candidate.xMeters, yMeters: candidate.yMeters } : null;
    const speed = Number(value.dockingWheelOutputPercent);
    return {
      enabled: value.enabled !== false,
      chargingPosition: point(value.chargingPosition),
      driveToPosition: point(value.driveToPosition),
      dockingWheelOutputPercent: Number.isFinite(speed) ? Math.min(1, Math.max(0.1, speed)) : 0.3,
    };
  }
}
