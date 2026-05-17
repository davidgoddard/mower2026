import { decodeFrame, encodeFrame, frameLengthForPayload } from "../bus/frameCodec.js";
import { I2cBusController } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../protocols/commonProtocol.js";
import { decodeGnssSample, gnssPayloadLength } from "./gnssCodec.js";
import type { GnssSample } from "./gnssProtocol.js";

interface GnssNodeClientOptions {
  address: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class GnssNodeClient {
  private sequence = 0;
  private readonly controller: I2cBusController;
  private readonly address: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(controller: I2cBusController, options: GnssNodeClientOptions) {
    this.controller = controller;
    this.address = options.address;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 20;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async refresh(): Promise<GnssSample> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const requestFrame = encodeFrame(
          {
            version: PROTOCOL_VERSION,
            nodeId: NodeId.Gnss,
            messageType: MessageType.GnssSample,
            flags: 0,
            sequence: this.sequence,
          },
          new Uint8Array(0),
        );
        this.sequence = (this.sequence + 1) & 0xffff;

        const responseFrame = await this.controller.queueRead({
          key: "gnss.sample",
          priority: I2C_PRIORITY.gnssRead,
          address: this.address,
          requestPayload: requestFrame,
          responseLength: frameLengthForPayload(gnssPayloadLength()),
        });

        const decoded = decodeFrame(responseFrame);
        if (decoded.header.nodeId !== NodeId.Gnss || decoded.header.messageType !== MessageType.GnssSample) {
          throw new Error("Unexpected GNSS response frame");
        }

        return decodeGnssSample(decoded.payload);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
