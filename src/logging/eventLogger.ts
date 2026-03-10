export interface EventLogger {
  log(eventName: string, fields: Record<string, unknown>): void;
}

export class NoOpEventLogger implements EventLogger {
  public log(_eventName: string, _fields: Record<string, unknown>): void {}
}

export interface EventRecord {
  readonly eventName: string;
  readonly fields: Record<string, unknown>;
}

export class MemoryEventLogger implements EventLogger {
  private readonly records: EventRecord[] = [];

  public log(eventName: string, fields: Record<string, unknown>): void {
    this.records.push({
      eventName,
      fields: { ...fields },
    });
  }

  public entries(): ReadonlyArray<EventRecord> {
    return this.records;
  }
}
