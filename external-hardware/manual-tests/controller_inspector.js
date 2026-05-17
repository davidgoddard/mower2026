import { HidGameController } from "./hidGameController.js";
import { loadSystemParameters } from "./systemConfig.js";

let lastPrintedMillis = 0;
const observedRange = {
  steeringByteMin: Infinity,
  steeringByteMax: -Infinity,
  speedByteMin: Infinity,
  speedByteMax: -Infinity,
  angleDegreesMin: Infinity,
  angleDegreesMax: -Infinity,
  speedMin: Infinity,
  speedMax: -Infinity,
};

function summariseButtons(buttons) {
  return Object.entries(buttons)
    .filter(([, pressed]) => pressed)
    .map(([label]) => label)
    .join(", ");
}

function updateObservedRange(snapshot) {
  observedRange.steeringByteMin = Math.min(observedRange.steeringByteMin, snapshot.steeringByte);
  observedRange.steeringByteMax = Math.max(observedRange.steeringByteMax, snapshot.steeringByte);
  observedRange.speedByteMin = Math.min(observedRange.speedByteMin, snapshot.speedByte);
  observedRange.speedByteMax = Math.max(observedRange.speedByteMax, snapshot.speedByte);
  observedRange.angleDegreesMin = Math.min(observedRange.angleDegreesMin, snapshot.angleDegrees);
  observedRange.angleDegreesMax = Math.max(observedRange.angleDegreesMax, snapshot.angleDegrees);
  observedRange.speedMin = Math.min(observedRange.speedMin, snapshot.speed);
  observedRange.speedMax = Math.max(observedRange.speedMax, snapshot.speed);
}

function safeRangeValue(value) {
  return Number.isFinite(value) ? value : null;
}

function formatSnapshot(snapshot) {
  return {
    connected: snapshot.connected,
    product: snapshot.product ?? "unknown",
    path: snapshot.path ?? "unavailable",
    steeringByte: snapshot.steeringByte,
    steeringCentered: snapshot.steeringCentered,
    speedByte: snapshot.speedByte,
    speedCentered: snapshot.speedCentered,
    angleDegrees: snapshot.angleDegrees,
    speed: snapshot.speed,
    observedRange: {
      steeringByteMin: safeRangeValue(observedRange.steeringByteMin),
      steeringByteMax: safeRangeValue(observedRange.steeringByteMax),
      speedByteMin: safeRangeValue(observedRange.speedByteMin),
      speedByteMax: safeRangeValue(observedRange.speedByteMax),
      angleDegreesMin: safeRangeValue(observedRange.angleDegreesMin),
      angleDegreesMax: safeRangeValue(observedRange.angleDegreesMax),
      speedMin: safeRangeValue(observedRange.speedMin),
      speedMax: safeRangeValue(observedRange.speedMax),
    },
    pressedButtons: summariseButtons(snapshot.buttons) || "none",
    rawPacketHex: snapshot.lastPacketHex || "",
  };
}

const { parameters } = await loadSystemParameters();
const controller = new HidGameController({
  steeringSign: parameters.controllerSteeringSign,
  speedSign: parameters.controllerSpeedSign,
});

const heartbeat = setInterval(() => {
  const snapshot = controller.snapshot();
  updateObservedRange(snapshot);
  const now = Date.now();
  if (now - lastPrintedMillis < 1000) {
    return;
  }
  lastPrintedMillis = now;

  console.log(formatSnapshot(snapshot));
}, 1000);

controller.on("connected", (snapshot) => {
  console.log("Controller connected:", {
    product: snapshot.product,
    path: snapshot.path,
    vendorId: snapshot.vendorId,
    productId: snapshot.productId,
  });
});

controller.on("update", (snapshot) => {
  updateObservedRange(snapshot);
  const now = Date.now();
  if (now - lastPrintedMillis < 150) {
    return;
  }
  lastPrintedMillis = now;

  console.log(formatSnapshot(snapshot));
});

for (const label of [
  "top",
  "right",
  "bottom",
  "left",
  "triangle",
  "circle",
  "cross",
  "square",
  "left-top",
  "right-top",
  "select",
  "start",
  "analog",
]) {
  controller.on(label, () => {
    console.log(`Button pressed: ${label}`);
  });
}

controller.on("error", (error) => {
  console.error("Controller error:", error instanceof Error ? error.message : String(error));
});

process.on("SIGINT", () => {
  clearInterval(heartbeat);
  controller.close();
  process.exitCode = 0;
});

controller.start();
