import { decodeFrame, encodeFrame, frameLengthForPayload } from "../bus/frameCodec.js";
import { I2cBusController } from "../i2c/i2cBusController.js";
import { I2C_PRIORITY } from "../i2c/priorities.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../protocols/commonProtocol.js";
import { decodeGnssSample, gnssPayloadLength } from "./gnssCodec.js";
import type { GnssSample } from "./gnssProtocol.js";
import { GNSS_DEFAULT_MAX_ATTEMPTS, GNSS_RETRY_DELAY_MS } from "../constants.js";

// Protocol sequence wrapping (implementation detail)
const PROTOCOL_SEQUENCE_MASK = 0xffff;

interface GnssNodeClientOptions {
  address: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * Source for the Pi-side wallclock used to stamp the decoded sample.
   * Defaults to Date.now().  Override in tests for determinism.
   */
  nowMillis?: () => number;
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
  private readonly nowMillis: () => number;

  constructor(controller: I2cBusController, options: GnssNodeClientOptions) {
    this.controller = controller;
    this.address = options.address;
    this.maxAttempts = options.maxAttempts ?? GNSS_DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? GNSS_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.nowMillis = options.nowMillis ?? (() => Date.now());
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
        this.sequence = (this.sequence + 1) & PROTOCOL_SEQUENCE_MASK;

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

        return decodeGnssSample(decoded.payload, { nowMillis: this.nowMillis() });
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
