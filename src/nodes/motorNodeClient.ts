import type { BusAdapter } from "../bus/busAdapter.js";
import { decodeFrame, encodeFrame } from "../bus/frameCodec.js";
import { decodeMotorFeedbackSample, decodeWheelSpeedCommand, encodeMotorFeedbackSample, encodeWheelSpeedCommand } from "../protocols/motorCodec.js";
import { MessageType, NodeId, PROTOCOL_VERSION } from "../protocols/commonProtocol.js";
import type { MotorFeedbackSample, WheelSpeedCommand } from "../protocols/motorProtocol.js";
import type { NodeHealth } from "./nodeHealth.js";

export interface MotorNodeClient {
  sendWheelSpeedCommand(command: WheelSpeedCommand): Promise<void>;
  refreshFeedback(): Promise<MotorFeedbackSample>;
  latestFeedback(): MotorFeedbackSample | undefined;
  health(): NodeHealth;
}

export class PollingMotorNodeClient implements MotorNodeClient {
  private sequence = 0;
  private lastFeedback: MotorFeedbackSample | undefined;
  private lastSeenNodeTimestampMillis = 0;
  private lastRefreshHostMillis = 0;
  private lastFaultFlags = 0;

  public constructor(
    private readonly bus: BusAdapter,
    private readonly staleAfterMillis = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async sendWheelSpeedCommand(command: WheelSpeedCommand): Promise<void> {
    const frame = encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Motor,
        messageType: MessageType.MotorWheelSpeedCommand,
        flags: 0,
        sequence: this.sequence++,
      },
      encodeWheelSpeedCommand(command),
    );

    await this.bus.send(NodeId.Motor, frame);
  }

  public async refreshFeedback(): Promise<MotorFeedbackSample> {
    const requestFrame = encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Motor,
        messageType: MessageType.MotorFeedbackSample,
        flags: 0,
        sequence: this.sequence++,
      },
      new Uint8Array(0),
    );

    const responseFrame = await this.bus.request(NodeId.Motor, requestFrame);
    const decoded = decodeFrame(responseFrame);

    if (decoded.header.nodeId !== NodeId.Motor || decoded.header.messageType !== MessageType.MotorFeedbackSample) {
      throw new Error("Unexpected motor response frame");
    }

    const feedback = decodeMotorFeedbackSample(decoded.payload);
    this.lastFeedback = feedback;
    this.lastSeenNodeTimestampMillis = feedback.timestampMillis;
    this.lastRefreshHostMillis = this.now();
    this.lastFaultFlags = decoded.header.flags;
    return feedback;
  }

  public latestFeedback(): MotorFeedbackSample | undefined {
    return this.lastFeedback;
  }

  public health(): NodeHealth {
    return {
      online: this.lastFeedback !== undefined,
      stale: this.lastFeedback === undefined ? true : this.now() - this.lastRefreshHostMillis > this.staleAfterMillis,
      lastSeenMillis: this.lastSeenNodeTimestampMillis,
      faultFlags: this.lastFaultFlags,
    };
  }

  public static encodeFeedbackResponse(sample: MotorFeedbackSample, sequence: number, flags = 0): Uint8Array {
    return encodeFrame(
      {
        version: PROTOCOL_VERSION,
        nodeId: NodeId.Motor,
        messageType: MessageType.MotorFeedbackSample,
        flags,
        sequence,
      },
      encodeMotorFeedbackSample(sample),
    );
  }

  public static decodeCommandFrame(frame: Uint8Array): WheelSpeedCommand {
    const decoded = decodeFrame(frame);
    if (decoded.header.nodeId !== NodeId.Motor || decoded.header.messageType !== MessageType.MotorWheelSpeedCommand) {
      throw new Error("Unexpected motor command frame");
    }
    return decodeWheelSpeedCommand(decoded.payload);
  }
}
