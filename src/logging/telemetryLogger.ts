export interface TelemetryLogger {
  append(streamName: string, sample: Record<string, unknown>): void;
}

export class NoOpTelemetryLogger implements TelemetryLogger {
  public append(_streamName: string, _sample: Record<string, unknown>): void {}
}

export interface TelemetryRecord {
  readonly streamName: string;
  readonly sample: Record<string, unknown>;
}

export class MemoryTelemetryLogger implements TelemetryLogger {
  private readonly records: TelemetryRecord[] = [];

  public append(streamName: string, sample: Record<string, unknown>): void {
    this.records.push({
      streamName,
      sample: { ...sample },
    });
  }

  public entries(streamName?: string): ReadonlyArray<TelemetryRecord> {
    return streamName === undefined ? this.records : this.records.filter((entry) => entry.streamName === streamName);
  }
}
