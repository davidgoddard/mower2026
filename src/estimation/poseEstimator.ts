import { normalizeAngleDegrees } from "../util/angles.js";
import type { MeasurementBundle } from "../sensing/measurementTypes.js";
import type { PoseEstimate } from "./estimatorTypes.js";
import { AdaptiveTrust, type TrustLevels } from "./adaptiveTrust.js";

export interface PoseEstimatorOptions {
  readonly wheelBaseMeters: number;
  readonly initialPose?: PoseEstimate;
}

const DEFAULT_POSE: PoseEstimate = {
  xMeters: 0,
  yMeters: 0,
  headingDegrees: 0,
  speedMetersPerSecond: 0,
  yawRateDegreesPerSecond: 0,
  confidence: 0,
  timestampMillis: 0,
};

export class PoseEstimator {
  private estimate: PoseEstimate;
  private lastImuTimestampMillis: number | undefined;

  public constructor(
    private readonly options: PoseEstimatorOptions,
    private readonly trustModel: AdaptiveTrust = new AdaptiveTrust(),
  ) {
    this.estimate = options.initialPose ?? DEFAULT_POSE;
  }

  public currentEstimate(): PoseEstimate {
    return this.estimate;
  }

  public ingest(bundle: MeasurementBundle): PoseEstimate {
    const trust = this.trustModel.evaluate(bundle);

    if (bundle.wheelOdometry !== undefined) {
      this.applyWheelOdometry(bundle, trust);
    }

    if (bundle.position !== undefined) {
      this.applyPositionMeasurement(bundle, trust);
    }

    if (bundle.heading !== undefined) {
      this.applyHeadingMeasurement(bundle, trust);
    }

    if (bundle.imu !== undefined) {
      this.applyImuMeasurement(bundle, trust);
    }

    this.estimate = {
      ...this.estimate,
      confidence: Math.max(trust.positionTrust, trust.headingTrust, trust.wheelTrust, trust.imuTrust),
      timestampMillis: this.latestTimestamp(bundle),
    };

    return this.estimate;
  }

  private applyWheelOdometry(bundle: MeasurementBundle, trust: TrustLevels): void {
    const odometry = bundle.wheelOdometry;
    if (odometry === undefined) {
      return;
    }

    const left = odometry.leftDistanceMeters * trust.wheelTrust;
    const right = odometry.rightDistanceMeters * trust.wheelTrust;
    const centerDistance = (left + right) / 2;
    const deltaHeadingDegrees = normalizeAngleDegrees(((right - left) / this.options.wheelBaseMeters) * (180 / Math.PI));
    const headingMidDegrees = this.estimate.headingDegrees + deltaHeadingDegrees / 2;
    const headingMidRadians = (headingMidDegrees * Math.PI) / 180;

    this.estimate = {
      ...this.estimate,
      xMeters: this.estimate.xMeters + centerDistance * Math.cos(headingMidRadians),
      yMeters: this.estimate.yMeters + centerDistance * Math.sin(headingMidRadians),
      headingDegrees: normalizeAngleDegrees(this.estimate.headingDegrees + deltaHeadingDegrees),
      speedMetersPerSecond: (odometry.leftSpeedMetersPerSecond + odometry.rightSpeedMetersPerSecond) / 2,
      yawRateDegreesPerSecond: deltaHeadingDegrees,
      timestampMillis: odometry.timestampMillis,
    };
  }

  private applyPositionMeasurement(bundle: MeasurementBundle, trust: TrustLevels): void {
    const position = bundle.position;
    if (position === undefined || trust.positionTrust === 0) {
      return;
    }

    this.estimate = {
      ...this.estimate,
      xMeters: blend(this.estimate.xMeters, position.xMeters, trust.positionTrust),
      yMeters: blend(this.estimate.yMeters, position.yMeters, trust.positionTrust),
      timestampMillis: position.timestampMillis,
    };
  }

  private applyHeadingMeasurement(bundle: MeasurementBundle, trust: TrustLevels): void {
    const heading = bundle.heading;
    if (heading === undefined || trust.headingTrust === 0) {
      return;
    }

    const delta = normalizeAngleDegrees(heading.headingDegrees - this.estimate.headingDegrees);
    this.estimate = {
      ...this.estimate,
      headingDegrees: normalizeAngleDegrees(this.estimate.headingDegrees + delta * trust.headingTrust),
      timestampMillis: heading.timestampMillis,
    };
  }

  private applyImuMeasurement(bundle: MeasurementBundle, trust: TrustLevels): void {
    const imu = bundle.imu;
    if (imu === undefined || trust.imuTrust === 0) {
      return;
    }

    const referenceTimestampMillis = this.lastImuTimestampMillis ?? this.estimate.timestampMillis;
    const timestampDeltaMillis = Math.max(0, imu.timestampMillis - referenceTimestampMillis);
    const deltaHeadingDegrees = imu.angularVelocity.zDegreesPerSecond * (timestampDeltaMillis / 1000) * trust.imuTrust;

    this.estimate = {
      ...this.estimate,
      headingDegrees: normalizeAngleDegrees(this.estimate.headingDegrees + deltaHeadingDegrees),
      yawRateDegreesPerSecond: imu.angularVelocity.zDegreesPerSecond * trust.imuTrust,
      timestampMillis: imu.timestampMillis,
    };
    this.lastImuTimestampMillis = imu.timestampMillis;
  }

  private latestTimestamp(bundle: MeasurementBundle): number {
    return bundle.position?.timestampMillis
      ?? bundle.heading?.timestampMillis
      ?? bundle.wheelOdometry?.timestampMillis
      ?? bundle.imu?.timestampMillis
      ?? this.estimate.timestampMillis;
  }
}

function blend(current: number, measurement: number, trust: number): number {
  return current + (measurement - current) * trust;
}
