import type { BusAdapter } from "../bus/busAdapter.js";
import { decodeFrame, encodeFrame } from "../bus/frameCodec.js";
import { decodeGnssSample, encodeGnssSample } from "../protocols/gnssCodec.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../protocols/commonProtocol.js";
import type { GnssSample } from "../protocols/gnssProtocol.js";
import type { NodeHealth } from "./nodeHealth.js";

export interface GnssNodeClient {
  refresh(): Promise<GnssSample>;
  latestSample(): GnssSample | undefined;
  health(): NodeHealth;
}

export class PollingGnssNodeClient implements GnssNodeClient {
  private sequence = 0;
  private lastSample: GnssSample | undefined;
  private lastSeenNodeTimestampMillis = 0;
  private lastRefreshHostMillis = 0;
  private lastFaultFlags = 0;

  public constructor(
    private readonly bus: BusAdapter,
    private readonly staleAfterMillis = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async refresh(): Promise<GnssSample> {
    const requestFrame = encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Gnss,
        messageType: MessageType.GnssSample,
        flags: 0,
        sequence: this.sequence++,
      },
      new Uint8Array(0),
    );

    const responseFrame = await this.bus.request(NodeId.Gnss, requestFrame);
    const decoded = decodeFrame(responseFrame);

    if (decoded.header.nodeId !== NodeId.Gnss || decoded.header.messageType !== MessageType.GnssSample) {
      throw new Error("Unexpected GNSS response frame");
    }

    const sample = decodeGnssSample(decoded.payload);
    this.lastSample = sample;
    this.lastSeenNodeTimestampMillis = sample.timestampMillis;
    this.lastRefreshHostMillis = this.now();
    this.lastFaultFlags = decoded.header.flags;
    return sample;
  }

  public latestSample(): GnssSample | undefined {
    return this.lastSample;
  }

  public health(): NodeHealth {
    return {
      online: this.lastSample !== undefined,
      stale: this.lastSample === undefined ? true : this.now() - this.lastRefreshHostMillis > this.staleAfterMillis,
      lastSeenMillis: this.lastSeenNodeTimestampMillis,
      faultFlags: this.lastFaultFlags,
    };
  }

  public static encodeResponse(sample: GnssSample, sequence: number, flags = 0): Uint8Array {
    return encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Gnss,
        messageType: MessageType.GnssSample,
        flags,
        sequence,
      },
      encodeGnssSample(sample),
    );
  }
}
