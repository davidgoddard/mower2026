export interface ReplayReader<TSample> {
  readAll(): AsyncIterable<TSample>;
}

export class ArrayReplayReader<TSample> implements ReplayReader<TSample> {
  public constructor(private readonly samples: ReadonlyArray<TSample>) {}

  public async *readAll(): AsyncIterable<TSample> {
    for (const sample of this.samples) {
      yield sample;
    }
  }
}
