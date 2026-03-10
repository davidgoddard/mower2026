import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBusAdapter } from "../../src/bus/busAdapter.js";
import { decodeFrame } from "../../src/bus/frameCodec.js";
import { PollingMotorNodeClient } from "../../src/nodes/motorNodeClient.js";
import { MessageType, NodeId } from "../../src/protocols/commonProtocol.js";

test("PollingMotorNodeClient encodes wheel speed commands", async () => {
  const bus = new InMemoryBusAdapter();
  const client = new PollingMotorNodeClient(bus);
  const command = {
    timestampMillis: 1500,
    leftWheelTargetMetersPerSecond: 0.25,
    rightWheelTargetMetersPerSecond: 0.27,
    enableDrive: true,
    commandTimeoutMillis: 250,
    maxAccelerationMetersPerSecondSquared: 0.5,
  };

  await client.sendWheelSpeedCommand(command);

  const [frame] = bus.framesForNode(NodeId.Motor);
  assert.notEqual(frame, undefined);
  const decodedFrame = decodeFrame(frame!);
  assert.equal(decodedFrame.header.messageType, MessageType.MotorWheelSpeedCommand);
  assert.deepEqual(PollingMotorNodeClient.decodeCommandFrame(frame!), command);
});

test("PollingMotorNodeClient requests and decodes motor feedback", async () => {
  const bus = new InMemoryBusAdapter();
  const client = new PollingMotorNodeClient(bus);
  const feedback = {
    timestampMillis: 2200,
    leftWheelActualMetersPerSecond: 0.31,
    rightWheelActualMetersPerSecond: 0.3,
    leftEncoderDelta: 120,
    rightEncoderDelta: 118,
    leftPwmApplied: 40,
    rightPwmApplied: 39,
    watchdogHealthy: true,
    faultFlags: 0,
  };

  bus.setResponder(NodeId.Motor, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    assert.equal(request.header.messageType, MessageType.MotorFeedbackSample);
    return PollingMotorNodeClient.encodeFeedbackResponse(feedback, request.header.sequence, 0x04);
  });

  const refreshed = await client.refreshFeedback();
  assert.deepEqual(refreshed, feedback);
  assert.deepEqual(client.latestFeedback(), feedback);
  assert.deepEqual(client.health(), {
    online: true,
    stale: false,
    lastSeenMillis: 2200,
    faultFlags: 0x04,
  });
});
