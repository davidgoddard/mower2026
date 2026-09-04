export interface DriveSteeringSample {
  readonly alongTrackMeters: number;
  readonly cteMeters: number;
}

export interface DriveSteeringMetrics {
  readonly sampleCount: number;
  readonly sampledAlongTrackMeters: number;
  readonly initialAbsCteMeters: number;
  readonly finalAbsCteMeters: number;
  readonly meanAbsCteMeters: number;
  readonly maxAbsCteMeters: number;
  readonly cteIntegralMetersSquared: number;
  readonly baselineCrossings: number;
  readonly nonDecayingCrossings: number;
  readonly distanceToTargetBandMeters: number | null;
}

export function calculateDriveSteeringMetrics(
  samples: ReadonlyArray<DriveSteeringSample>,
  targetCteMeters: number,
  crossingHysteresisMeters: number,
): DriveSteeringMetrics {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      sampledAlongTrackMeters: 0,
      initialAbsCteMeters: 0,
      finalAbsCteMeters: 0,
      meanAbsCteMeters: 0,
      maxAbsCteMeters: 0,
      cteIntegralMetersSquared: 0,
      baselineCrossings: 0,
      nonDecayingCrossings: 0,
      distanceToTargetBandMeters: null,
    };
  }

  const ordered = [...samples].sort((left, right) => left.alongTrackMeters - right.alongTrackMeters);
  const startAlong = ordered[0].alongTrackMeters;
  const endAlong = ordered.at(-1)!.alongTrackMeters;
  let integral = 0;
  let absSum = 0;
  let maxAbs = 0;
  let stableBandStart: number | null = null;
  let distanceToTargetBandMeters: number | null = null;
  let lastCommittedSide: -1 | 0 | 1 = 0;
  let sidePeak = 0;
  const completedSidePeaks: number[] = [];
  let baselineCrossings = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];
    const absCte = Math.abs(sample.cteMeters);
    absSum += absCte;
    maxAbs = Math.max(maxAbs, absCte);
    if (index > 0) {
      const previous = ordered[index - 1];
      const deltaAlong = Math.max(0, sample.alongTrackMeters - previous.alongTrackMeters);
      integral += deltaAlong * ((Math.abs(previous.cteMeters) + absCte) / 2);
    }

    if (absCte <= targetCteMeters) {
      stableBandStart ??= sample.alongTrackMeters;
      if (
        distanceToTargetBandMeters === null
        && sample.alongTrackMeters - stableBandStart >= 0.1
      ) {
        distanceToTargetBandMeters = Math.max(0, stableBandStart - startAlong);
      }
    } else {
      stableBandStart = null;
    }

    const side: -1 | 0 | 1 = sample.cteMeters > crossingHysteresisMeters
      ? 1
      : sample.cteMeters < -crossingHysteresisMeters
        ? -1
        : 0;
    if (side === 0) continue;
    if (lastCommittedSide === 0) {
      lastCommittedSide = side;
      sidePeak = absCte;
      continue;
    }
    if (side !== lastCommittedSide) {
      completedSidePeaks.push(sidePeak);
      baselineCrossings += 1;
      lastCommittedSide = side;
      sidePeak = absCte;
    } else {
      sidePeak = Math.max(sidePeak, absCte);
    }
  }
  if (lastCommittedSide !== 0) completedSidePeaks.push(sidePeak);

  let nonDecayingCrossings = 0;
  for (let index = 1; index < completedSidePeaks.length; index += 1) {
    if (completedSidePeaks[index] >= completedSidePeaks[index - 1] * 0.9) {
      nonDecayingCrossings += 1;
    }
  }

  return {
    sampleCount: ordered.length,
    sampledAlongTrackMeters: Math.max(0, endAlong - startAlong),
    initialAbsCteMeters: Math.abs(ordered[0].cteMeters),
    finalAbsCteMeters: Math.abs(ordered.at(-1)!.cteMeters),
    meanAbsCteMeters: absSum / ordered.length,
    maxAbsCteMeters: maxAbs,
    cteIntegralMetersSquared: integral,
    baselineCrossings,
    nonDecayingCrossings,
    distanceToTargetBandMeters,
  };
}
