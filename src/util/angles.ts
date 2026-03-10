export function normalizeAngleDegrees(angleDegrees: number): number {
  let normalized = angleDegrees;
  while (normalized <= -180) {
    normalized += 360;
  }
  while (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}
