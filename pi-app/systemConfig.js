import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.resolve(scriptDirectory, "../config/system-parameters.json");

export async function loadSystemParameters() {
  const filePath = process.env.MOWER_CONFIG_PATH ?? defaultConfigPath;
  const content = await readFile(filePath, "utf8");
  const parsed = JSON.parse(content);

  if (parsed.leftMotorForwardSign !== -1 && parsed.leftMotorForwardSign !== 1) {
    throw new Error(`Invalid leftMotorForwardSign in ${filePath}; expected -1 or 1.`);
  }

  if (parsed.rightMotorForwardSign !== -1 && parsed.rightMotorForwardSign !== 1) {
    throw new Error(`Invalid rightMotorForwardSign in ${filePath}; expected -1 or 1.`);
  }

  for (const field of [
    "leftMotorForwardScale",
    "leftMotorReverseScale",
    "rightMotorForwardScale",
    "rightMotorReverseScale",
    "calibrationTurnScale",
    "calibrationLineGainScale",
    "waypointArrivalToleranceMeters",
    "headingArrivalToleranceDegrees",
  ]) {
    if (typeof parsed[field] !== "number" || !(parsed[field] > 0)) {
      throw new Error(`Invalid ${field} in ${filePath}; expected a positive number.`);
    }
  }

  if (typeof parsed.pivotAntennaExcursionMeters !== "number" || parsed.pivotAntennaExcursionMeters < 0) {
    throw new Error(`Invalid pivotAntennaExcursionMeters in ${filePath}; expected a zero or positive number.`);
  }

  for (const field of ["controllerSteeringSign", "controllerSpeedSign"]) {
    if (parsed[field] !== -1 && parsed[field] !== 1) {
      throw new Error(`Invalid ${field} in ${filePath}; expected -1 or 1.`);
    }
  }

  return {
    filePath,
    parameters: parsed,
  };
}
