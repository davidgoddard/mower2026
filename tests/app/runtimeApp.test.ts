import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeApp } from "../../src/app/runtimeApp.js";
import { InMemoryBusAdapter } from "../../src/bus/busAdapter.js";
import { CommandLimiter } from "../../src/control/commandLimiter.js";
import { InMemoryParameterStore } from "../../src/config/parameterStore.js";
import { PoseEstimator } from "../../src/estimation/poseEstimator.js";
import { LineTracker } from "../../src/guidance/lineTracker.js";
import { MemoryEventLogger } from "../../src/logging/eventLogger.js";
import { MemoryTelemetryLogger } from "../../src/logging/telemetryLogger.js";
import { PollingGnssNodeClient } from "../../src/nodes/gnssNodeClient.js";
import { PollingMotorNodeClient } from "../../src/nodes/motorNodeClient.js";
import { MessageType, NodeId } from "../../src/protocols/commonProtocol.js";
import { decodeFrame } from "../../src/bus/frameCodec.js";
import { decodeWheelSpeedCommand } from "../../src/protocols/motorCodec.js";
import { PermissiveSafetyManager } from "../../src/safety/safetyManager.js";
import { GnssAdapter } from "../../src/sensing/gnssAdapter.js";
import { MotorFeedbackAdapter } from "../../src/sensing/motorFeedbackAdapter.js";
import { WheelCommandPlanner } from "../../src/control/wheelCommandPlanner.js";
import { RuleBasedSafetyManager } from "../../src/safety/safetyManager.js";

test("RuntimeApp runs one end-to-end control cycle and emits a wheel command", async () => {
  const bus = new InMemoryBusAdapter();
  const parameterStore = new InMemoryParameterStore();
  const gnssNodeClient = new PollingGnssNodeClient(bus);
  const motorNodeClient = new PollingMotorNodeClient(bus);
  const telemetryLogger = new MemoryTelemetryLogger();
  const eventLogger = new MemoryEventLogger();

  bus.setResponder(NodeId.Gnss, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    assert.equal(request.header.messageType, MessageType.GnssSample);
    return PollingGnssNodeClient.encodeResponse(
      {
        timestampMillis: 1_000,
        xMeters: 0,
        yMeters: 0.1,
        headingDegrees: 0,
        positionAccuracyMeters: 0.01,
        headingAccuracyDegrees: 0.5,
        fixType: "fixed",
        satellitesInUse: 18,
        sampleAgeMillis: 10,
      },
      request.header.sequence,
    );
  });

  bus.setResponder(NodeId.Motor, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    assert.equal(request.header.messageType, MessageType.MotorFeedbackSample);
    return PollingMotorNodeClient.encodeFeedbackResponse(
      {
        timestampMillis: 1_000,
        leftWheelActualMetersPerSecond: 0,
        rightWheelActualMetersPerSecond: 0,
        leftEncoderDelta: 0,
        rightEncoderDelta: 0,
        leftPwmApplied: 0,
        rightPwmApplied: 0,
        watchdogHealthy: true,
        faultFlags: 0,
      },
      request.header.sequence,
    );
  });

  const app = new RuntimeApp({
    bus,
    gnssNodeClient,
    motorNodeClient,
    gnssAdapter: new GnssAdapter({ staleAfterMillis: 250, now: () => 1_100 }),
    motorFeedbackAdapter: new MotorFeedbackAdapter({
      leftMetersPerEncoderCount: 0.001,
      rightMetersPerEncoderCount: 0.001,
      staleAfterMillis: 250,
      now: () => 1_100,
    }),
    poseEstimator: new PoseEstimator({ wheelBaseMeters: 0.5 }),
    lineTracker: new LineTracker({
      nominalSpeedMetersPerSecond: 0.5,
      maxSpeedMetersPerSecond: 0.8,
      crossTrackGain: -20,
      headingGain: 1,
      maxYawRateDegreesPerSecond: 90,
    }),
    wheelCommandPlanner: new WheelCommandPlanner({
      wheelBaseMeters: 0.5,
      maxWheelSpeedMetersPerSecond: 1,
    }),
    commandLimiter: new CommandLimiter({
      maxWheelSpeedMetersPerSecond: 1,
      maxWheelStepMetersPerSecond: 1,
    }),
    parameterStore,
    telemetryLogger,
    eventLogger,
    safetyManager: new PermissiveSafetyManager(),
  });

  await app.initialise();
  app.setActiveSegment({
    start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
    end: { xMeters: 5, yMeters: 0, headingDegrees: 0 },
  });

  const estimate = await app.runCycle();
  assert.equal(Number(estimate.yMeters.toFixed(3)), 0.09);

  const frames = bus.framesForNode(NodeId.Motor);
  const commandFrames = frames.map((frame) => decodeFrame(frame)).filter((frame) => frame.header.messageType === MessageType.MotorWheelSpeedCommand);
  assert.equal(commandFrames.length, 1);

  const command = decodeWheelSpeedCommand(commandFrames[0]!.payload);
  assert.equal(command.enableDrive, true);
  assert.equal(command.leftWheelTargetMetersPerSecond > command.rightWheelTargetMetersPerSecond, true);
  assert.equal(telemetryLogger.entries("pose.estimate").length, 1);
  assert.equal(eventLogger.entries()[0]?.eventName, "runtime.initialised");
});

test("RuntimeApp sends a disabled command when safety blocks motion", async () => {
  const bus = new InMemoryBusAdapter();
  const parameterStore = new InMemoryParameterStore();
  const gnssNodeClient = new PollingGnssNodeClient(bus);
  const motorNodeClient = new PollingMotorNodeClient(bus);
  const telemetryLogger = new MemoryTelemetryLogger();
  const eventLogger = new MemoryEventLogger();

  bus.setResponder(NodeId.Gnss, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    return PollingGnssNodeClient.encodeResponse(
      {
        timestampMillis: 1_000,
        xMeters: 0,
        yMeters: 0,
        positionAccuracyMeters: 0.01,
        fixType: "none",
        satellitesInUse: 4,
        sampleAgeMillis: 1_000,
      },
      request.header.sequence,
    );
  });

  bus.setResponder(NodeId.Motor, (requestFrame) => {
    const request = decodeFrame(requestFrame);
    return PollingMotorNodeClient.encodeFeedbackResponse(
      {
        timestampMillis: 1_000,
        leftWheelActualMetersPerSecond: 0,
        rightWheelActualMetersPerSecond: 0,
        leftEncoderDelta: 0,
        rightEncoderDelta: 0,
        leftPwmApplied: 0,
        rightPwmApplied: 0,
        watchdogHealthy: true,
        faultFlags: 0,
      },
      request.header.sequence,
    );
  });

  const app = new RuntimeApp({
    bus,
    gnssNodeClient,
    motorNodeClient,
    gnssAdapter: new GnssAdapter({ staleAfterMillis: 250, now: () => 2_000 }),
    motorFeedbackAdapter: new MotorFeedbackAdapter({
      leftMetersPerEncoderCount: 0.001,
      rightMetersPerEncoderCount: 0.001,
      staleAfterMillis: 250,
      now: () => 1_100,
    }),
    poseEstimator: new PoseEstimator({ wheelBaseMeters: 0.5 }),
    lineTracker: new LineTracker({
      nominalSpeedMetersPerSecond: 0.5,
      maxSpeedMetersPerSecond: 0.8,
      crossTrackGain: -20,
      headingGain: 1,
      maxYawRateDegreesPerSecond: 90,
    }),
    wheelCommandPlanner: new WheelCommandPlanner({
      wheelBaseMeters: 0.5,
      maxWheelSpeedMetersPerSecond: 1,
    }),
    commandLimiter: new CommandLimiter({
      maxWheelSpeedMetersPerSecond: 1,
      maxWheelStepMetersPerSecond: 1,
    }),
    parameterStore,
    telemetryLogger,
    eventLogger,
    safetyManager: new RuleBasedSafetyManager(),
  });

  await app.initialise();
  app.setActiveSegment({
    start: { xMeters: 0, yMeters: 0, headingDegrees: 0 },
    end: { xMeters: 5, yMeters: 0, headingDegrees: 0 },
  });

  await app.runCycle();

  const frames = bus.framesForNode(NodeId.Motor);
  const commandFrames = frames.map((frame) => decodeFrame(frame)).filter((frame) => frame.header.messageType === MessageType.MotorWheelSpeedCommand);
  assert.equal(commandFrames.length, 1);

  const command = decodeWheelSpeedCommand(commandFrames[0]!.payload);
  assert.equal(command.enableDrive, false);
  assert.equal(command.leftWheelTargetMetersPerSecond, 0);
  assert.equal(command.rightWheelTargetMetersPerSecond, 0);
  assert.equal(eventLogger.entries().some((entry) => entry.eventName === "runtime.motion_inhibited"), true);
});
