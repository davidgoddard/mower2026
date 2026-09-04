const EPSILON = 1e-9;

/**
 * Build equal-area marking bands across a recorded lawn.
 *
 * The heading is the long-axis heading used by the mowing planner. Increasing
 * normal offset points towards the top of the Drive & Paths canvas for Pattern
 * A (23 degrees), so boundaries are returned from the top of the app downwards.
 */
export function buildPegLayout(options) {
  const headingDeg = finiteNumber(options.headingDeg, "headingDeg");
  const targetAreaSquareMeters = positiveNumber(
    options.targetAreaSquareMeters,
    "targetAreaSquareMeters",
  );
  const edgeInsetMeters = nonNegativeNumber(options.edgeInsetMeters ?? 0, "edgeInsetMeters");
  const endpointStandoffMeters = nonNegativeNumber(
    options.endpointStandoffMeters ?? 0,
    "endpointStandoffMeters",
  );
  const area = normalizePolygon(options.areaPoints, "area");
  const obstacles = (options.obstaclePointsArray ?? [])
    .map((points, index) => normalizePolygon(points, `obstacle ${index + 1}`));

  const headingRadians = (headingDeg * Math.PI) / 180;
  const direction = { x: Math.cos(headingRadians), y: Math.sin(headingRadians) };
  const normal = { x: -direction.y, y: direction.x };
  const offsets = area.map((point) => dot(point, normal));
  const maximumOffset = Math.max(...offsets);
  const minimumOffset = Math.min(...offsets);
  const topOffset = maximumOffset - edgeInsetMeters;
  const bottomOffset = minimumOffset + edgeInsetMeters;
  if (topOffset <= bottomOffset + EPSILON) {
    throw new Error("peg_layout_edge_inset_too_large");
  }

  const areaAboveTop = freeAreaAbove(area, obstacles, normal, topOffset);
  const areaAboveBottom = freeAreaAbove(area, obstacles, normal, bottomOffset);
  const usableAreaSquareMeters = areaAboveBottom - areaAboveTop;
  if (usableAreaSquareMeters <= EPSILON) {
    throw new Error("peg_layout_has_no_usable_area");
  }

  const boundaryOffsets = [topOffset];
  for (
    let cumulativeTarget = targetAreaSquareMeters;
    cumulativeTarget < usableAreaSquareMeters - 0.01;
    cumulativeTarget += targetAreaSquareMeters
  ) {
    boundaryOffsets.push(findOffsetForArea({
      area,
      obstacles,
      normal,
      topOffset,
      bottomOffset,
      areaAboveTop,
      targetAreaSquareMeters: cumulativeTarget,
    }));
  }
  boundaryOffsets.push(bottomOffset);

  const boundaries = boundaryOffsets.map((offsetMeters, index) => {
    const intervals = crossSectionIntervals(area, direction, normal, offsetMeters);
    if (intervals.length === 0) {
      throw new Error(`peg_layout_boundary_${index + 1}_does_not_cross_area`);
    }
    const minimumAlong = Math.min(...intervals.map((interval) => interval.start));
    const maximumAlong = Math.max(...intervals.map((interval) => interval.end));
    const spanMeters = maximumAlong - minimumAlong;
    if (spanMeters <= (endpointStandoffMeters * 2) + EPSILON) {
      throw new Error(`peg_layout_boundary_${index + 1}_too_short_for_standoff`);
    }

    return {
      index,
      offsetMeters,
      spanMeters,
      pegSpanMeters: spanMeters - (endpointStandoffMeters * 2),
      intervalCount: intervals.length,
      left: fromAxisCoordinates(
        minimumAlong + endpointStandoffMeters,
        offsetMeters,
        direction,
        normal,
      ),
      right: fromAxisCoordinates(
        maximumAlong - endpointStandoffMeters,
        offsetMeters,
        direction,
        normal,
      ),
    };
  });

  const bands = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const upper = boundaries[index - 1];
    const lower = boundaries[index];
    const upperArea = freeAreaAbove(area, obstacles, normal, upper.offsetMeters);
    const lowerArea = freeAreaAbove(area, obstacles, normal, lower.offsetMeters);
    bands.push({
      index: index - 1,
      upperBoundaryIndex: upper.index,
      lowerBoundaryIndex: lower.index,
      depthMeters: upper.offsetMeters - lower.offsetMeters,
      usableAreaSquareMeters: lowerArea - upperArea,
      isFullTargetBand: Math.abs((lowerArea - upperArea) - targetAreaSquareMeters) <= 0.02,
    });
  }

  const pegs = boundaries.flatMap((boundary, index) => {
    const crossesLeftToRight = index % 2 === 0;
    const firstSide = crossesLeftToRight ? "left" : "right";
    const secondSide = crossesLeftToRight ? "right" : "left";
    return [firstSide, secondSide].map((side) => ({
      index: (index * 2) + (side === firstSide ? 0 : 1),
      boundaryIndex: boundary.index,
      side,
      point: boundary[side],
    }));
  });

  return {
    headingDeg,
    targetAreaSquareMeters,
    edgeInsetMeters,
    endpointStandoffMeters,
    grossAreaSquareMeters: polygonArea(area),
    excludedAreaSquareMeters: obstacles.reduce((sum, obstacle) => sum + polygonArea(obstacle), 0),
    usableAreaSquareMeters,
    topExcludedCapSquareMeters: areaAboveTop,
    bottomExcludedCapSquareMeters:
      (polygonArea(area) - obstacles.reduce((sum, obstacle) => sum + polygonArea(obstacle), 0))
      - areaAboveBottom,
    direction,
    normal,
    boundaries,
    bands,
    pegs,
  };
}

export function polygonArea(points) {
  if (points.length < 3) {
    return 0;
  }
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(twiceArea) / 2;
}

function findOffsetForArea(options) {
  let lowerOffset = options.bottomOffset;
  let upperOffset = options.topOffset;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const candidateOffset = (lowerOffset + upperOffset) / 2;
    const candidateArea = freeAreaAbove(
      options.area,
      options.obstacles,
      options.normal,
      candidateOffset,
    ) - options.areaAboveTop;
    if (candidateArea > options.targetAreaSquareMeters) {
      lowerOffset = candidateOffset;
    } else {
      upperOffset = candidateOffset;
    }
  }
  return (lowerOffset + upperOffset) / 2;
}

function freeAreaAbove(area, obstacles, normal, offsetMeters) {
  const outerArea = polygonArea(clipPolygonAbove(area, normal, offsetMeters));
  const excludedArea = obstacles.reduce(
    (sum, obstacle) => sum + polygonArea(clipPolygonAbove(obstacle, normal, offsetMeters)),
    0,
  );
  return Math.max(0, outerArea - excludedArea);
}

function clipPolygonAbove(points, normal, offsetMeters) {
  const result = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const startDistance = dot(start, normal) - offsetMeters;
    const endDistance = dot(end, normal) - offsetMeters;
    const startInside = startDistance >= -EPSILON;
    const endInside = endDistance >= -EPSILON;

    if (startInside) {
      result.push(start);
    }
    if (startInside !== endInside) {
      const fraction = startDistance / (startDistance - endDistance);
      result.push({
        x: start.x + ((end.x - start.x) * fraction),
        y: start.y + ((end.y - start.y) * fraction),
      });
    }
  }
  return removeAdjacentDuplicates(result);
}

function crossSectionIntervals(points, direction, normal, offsetMeters) {
  const intersections = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const startOffset = dot(start, normal);
    const endOffset = dot(end, normal);
    if ((startOffset > offsetMeters) === (endOffset > offsetMeters)) {
      continue;
    }
    const fraction = (offsetMeters - startOffset) / (endOffset - startOffset);
    const intersection = {
      x: start.x + ((end.x - start.x) * fraction),
      y: start.y + ((end.y - start.y) * fraction),
    };
    intersections.push(dot(intersection, direction));
  }
  intersections.sort((left, right) => left - right);
  if (intersections.length % 2 !== 0) {
    throw new Error("peg_layout_cross_section_has_odd_intersection_count");
  }

  const intervals = [];
  for (let index = 0; index < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > EPSILON) {
      intervals.push({ start: intersections[index], end: intersections[index + 1] });
    }
  }
  return intervals;
}

function fromAxisCoordinates(along, offset, direction, normal) {
  return {
    xMeters: (direction.x * along) + (normal.x * offset),
    yMeters: (direction.y * along) + (normal.y * offset),
  };
}

function normalizePolygon(points, label) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error(`peg_layout_${label.replaceAll(" ", "_")}_needs_three_points`);
  }
  const normalized = points.map((point) => {
    const x = finiteNumber(point.xMeters ?? point.x, `${label}.x`);
    const y = finiteNumber(point.yMeters ?? point.y, `${label}.y`);
    return { x, y };
  });
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) {
    normalized.pop();
  }
  if (normalized.length < 3 || polygonArea(normalized) <= EPSILON) {
    throw new Error(`peg_layout_${label.replaceAll(" ", "_")}_is_degenerate`);
  }
  return normalized;
}

function removeAdjacentDuplicates(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON) {
      result.push(point);
    }
  }
  if (
    result.length > 1
    && Math.hypot(result[0].x - result.at(-1).x, result[0].y - result.at(-1).y) <= EPSILON
  ) {
    result.pop();
  }
  return result;
}

function dot(left, right) {
  return (left.x * right.x) + (left.y * right.y);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`peg_layout_${label}_must_be_finite`);
  }
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new Error(`peg_layout_${label}_must_be_positive`);
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) {
    throw new Error(`peg_layout_${label}_must_be_non_negative`);
  }
  return number;
}
