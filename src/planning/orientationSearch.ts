import { normalizeAngleDegrees } from "../util/angles.js";
import type { SiteModel } from "../site/siteTypes.js";

export interface OrientationSearchOptions {
  readonly coarseStepDegrees: number;
}

const DEFAULT_OPTIONS: OrientationSearchOptions = {
  coarseStepDegrees: 15,
};

export function candidateOrientationsDegrees(
  site: SiteModel,
  options?: Partial<OrientationSearchOptions>,
): number[] {
  const coarseStepDegrees = options?.coarseStepDegrees ?? DEFAULT_OPTIONS.coarseStepDegrees;
  const candidates = new Set<number>();
  const points = uniqueVertices(site.perimeter.simplifiedPoints);

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const dx = next.xMeters - current.xMeters;
    const dy = next.yMeters - current.yMeters;
    if (Math.hypot(dx, dy) < 1e-6) {
      continue;
    }
    candidates.add(normalizeHalfTurnDegrees(Math.atan2(dy, dx) * (180 / Math.PI)));
  }

  for (let degrees = 0; degrees < 180; degrees += coarseStepDegrees) {
    candidates.add(normalizeHalfTurnDegrees(degrees));
  }

  return [...candidates].sort((a, b) => a - b);
}

function normalizeHalfTurnDegrees(degrees: number): number {
  let normalized = normalizeAngleDegrees(degrees);
  if (normalized < 0) {
    normalized += 180;
  }
  if (normalized >= 180) {
    normalized -= 180;
  }
  return Number(normalized.toFixed(3));
}

function uniqueVertices(points: readonly SiteModel["perimeter"]["simplifiedPoints"][number][]): SiteModel["perimeter"]["simplifiedPoints"] {
  if (points.length <= 1) {
    return [...points];
  }

  const last = points[points.length - 1]!;
  const first = points[0]!;
  const closed = first.xMeters === last.xMeters && first.yMeters === last.yMeters;
  return closed ? points.slice(0, -1) : [...points];
}
