export interface BusAdapter {
  send(nodeId: number, payload: Uint8Array): Promise<void>;
  request(nodeId: number, payload: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

export class InMemoryBusAdapter implements BusAdapter {
  private readonly sentFrames: Array<{ readonly nodeId: number; readonly payload: Uint8Array }> = [];
  private readonly responders = new Map<number, (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>>();

  public async send(nodeId: number, payload: Uint8Array): Promise<void> {
    this.sentFrames.push({ nodeId, payload: payload.slice() });
  }

  public async request(nodeId: number, payload: Uint8Array): Promise<Uint8Array> {
    this.sentFrames.push({ nodeId, payload: payload.slice() });
    const responder = this.responders.get(nodeId);
    if (responder === undefined) {
      throw new Error(`No responder configured for node ${nodeId}`);
    }
    return await responder(payload.slice());
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }

  public setResponder(nodeId: number, responder: (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>): void {
    this.responders.set(nodeId, responder);
  }

  public framesForNode(nodeId: number): ReadonlyArray<Uint8Array> {
    return this.sentFrames.filter((entry) => entry.nodeId === nodeId).map((entry) => entry.payload.slice());
  }
}
