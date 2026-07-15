import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const areaFile = process.argv[2] ?? "area-perimeters/Rear_Lawn.area.path.json";
const outputDir = process.argv[3] ?? "logs/area-smoothing-harness";
const {
  decimateSmoothedAreaPerimeter,
  smoothAreaPerimeterAdaptively,
} = await loadExperimentalAdaptiveAreaSmoothing();

const area = JSON.parse(fs.readFileSync(areaFile, "utf8"));
const harnessStartedAtMs = Date.now();
const smoothingStartedAtMs = Date.now();
const result = smoothAreaPerimeterAdaptively(area.points, {
  resampleSpacingMeters: 0.15,
  maxDeviationMeters: 0.10,
  passes: 3,
  maxSmoothingFactor: 0.42,
  minSmoothingFactor: 0.04,
  cornerStartDeg: 12,
  cornerFullDeg: 40,
});
const smoothingMs = Date.now() - smoothingStartedAtMs;
const decimationStartedAtMs = Date.now();
const decimated = decimateSmoothedAreaPerimeter(result.smoothedPoints, area.points, {
  maxDeviationMeters: 0.10,
  segmentValidationSpacingMeters: 0.05,
});
const decimationMs = Date.now() - decimationStartedAtMs;

fs.mkdirSync(outputDir, { recursive: true });

const statsPath = path.join(outputDir, "stats.json");
const svgPath = path.join(outputDir, "overlay.svg");

const stats = {
  areaName: area.name,
  originalPointCount: result.originalPointCount,
  resampledPointCount: result.resampledPointCount,
  smoothedPointCount: result.smoothedPointCount,
  maxDeviationCm: Number((result.maxDeviationMeters * 100).toFixed(2)),
  averageDeviationCm: Number((result.averageDeviationMeters * 100).toFixed(2)),
  outsidePointCount: result.outsidePointCount,
  invalidSegmentCount: result.invalidSegmentCount,
  repairIterations: result.repairIterations,
  smoothingMs,
  decimation: {
    pointCount: decimated.decimatedPointCount,
    reductionPercent: Number((((1 - (decimated.decimatedPointCount / result.smoothedPointCount)) * 100)).toFixed(2)),
    maxDeviationCm: Number((decimated.maxDeviationMeters * 100).toFixed(2)),
    averageDeviationCm: Number((decimated.averageDeviationMeters * 100).toFixed(2)),
    outsidePointCount: decimated.outsidePointCount,
    invalidSegmentCount: decimated.invalidSegmentCount,
    decimationMs,
  },
  totalHarnessMs: Date.now() - harnessStartedAtMs,
};

fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
fs.writeFileSync(
  svgPath,
  buildOverlaySvg(area.points, result.smoothedPoints, decimated.decimatedPoints),
  "utf8",
);

console.log(JSON.stringify({
  ...stats,
  statsPath,
  svgPath,
}, null, 2));

function buildOverlaySvg(originalPoints, smoothedPoints, decimatedPoints) {
  const originalOpen = stripDuplicateClosure(originalPoints.map((point) => ({ x: point.xMeters, y: point.yMeters })));
  const smoothedOpen = stripDuplicateClosure(smoothedPoints.map((point) => ({ x: point.xMeters, y: point.yMeters })));
  const decimatedOpen = stripDuplicateClosure(decimatedPoints.map((point) => ({ x: point.xMeters, y: point.yMeters })));
  const allPoints = originalOpen.concat(smoothedOpen, decimatedOpen);
  const minX = Math.min(...allPoints.map((point) => point.x));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const minY = Math.min(...allPoints.map((point) => point.y));
  const maxY = Math.max(...allPoints.map((point) => point.y));
  const padding = 40;
  const width = 1400;
  const height = 1000;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width - (padding * 2)) / spanX, (height - (padding * 2)) / spanY);
  const offsetX = padding + ((width - (padding * 2) - (spanX * scale)) / 2);
  const offsetY = padding + ((height - (padding * 2) - (spanY * scale)) / 2);

  const project = (point) => [
    offsetX + ((point.x - minX) * scale),
    height - (offsetY + ((point.y - minY) * scale)),
  ];

  const originalPolyline = originalOpen.map((point) => project(point).join(",")).join(" ");
  const smoothedPolyline = smoothedOpen.map((point) => project(point).join(",")).join(" ");
  const decimatedPolyline = decimatedOpen.map((point) => project(point).join(",")).join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="#f8f5ee" />
  <text x="30" y="45" font-family="monospace" font-size="28" fill="#1d1d1d">Area smoothing harness overlay</text>
  <text x="30" y="80" font-family="monospace" font-size="20" fill="#555">Original: gray | Smoothed: green | Decimated: orange</text>
  <polyline points="${originalPolyline}" fill="none" stroke="#8d8d8d" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
  <polyline points="${smoothedPolyline}" fill="none" stroke="#0f8b4c" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
  <polyline points="${decimatedPolyline}" fill="none" stroke="#dd6b20" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
</svg>`;
}

function stripDuplicateClosure(points) {
  if (points.length <= 1) {
    return points.slice();
  }
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9 ? points.slice(0, -1) : points.slice();
}

async function loadExperimentalAdaptiveAreaSmoothing() {
  const sourcePath = path.resolve("src/pathfollowing/experimentalAdaptiveAreaSmoothing.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });
  const tempModulePath = path.join(
    os.tmpdir(),
    `experimentalAdaptiveAreaSmoothing.${Date.now()}.${process.pid}.mjs`,
  );
  fs.writeFileSync(tempModulePath, transpiled.outputText, "utf8");
  return import(pathToFileURL(tempModulePath).href);
}
