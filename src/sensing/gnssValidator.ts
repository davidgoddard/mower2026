/**
 * GNSS validator — UM982 dual-antenna acceptance state machine.
 *
 * This module owns the decision of whether a GNSS sample is good enough to
 * use for navigation.  It does NOT consult dead-reckoning — DR vs GNSS
 * disagreement is not a gate here, by design.  There is also no
 * sample-to-sample physical-jump check — there is no calibrated source for
 * the mower's maximum credible motion until drive-learning produces one,
 * and a hard-coded guess would just be that, a guess.  The temporal filter
 * (3 consecutive valid epochs) plus RTK Fixed + position accuracy ≤ 5 cm is
 * what protects against teleporting samples for now.
 *
 * Rules (verbatim from spec):
 *
 *   POSITION ACCEPTANCE
 *     fixType == RTK_FIXED, gnssFixOK == true, RTK reliability >= 3,
 *     numSV >= 8 (12 preferred), HDOP < 5 (2 preferred), accuracy within
 *     application limits.
 *
 *   HEADING ACCEPTANCE (additional, on top of position)
 *     baseline 25..35 m, heading reliability >= 3, heading valid flag,
 *     heading accuracy below threshold, jump < 10° in 0.5 s, IMU
 *     consistency (|GNSS - IMU| < 5° for multiple epochs).
 *
 *   STATE
 *     TRUSTED  — all checks pass, used by control / navigation
 *     DEGRADED — partial failures (RTK_FLOAT, accuracy degraded, etc.)
 *     REJECTED — any hard failure
 *     Promote to TRUSTED only after N consecutive valid epochs (3 for
 *     position, 5 for heading).  Demote on M consecutive failures (40).
 *
 * Heading validation is intentionally separate from position validation.
 * The spec marks heading as a stricter superset — heading can be REJECTED
 * even when position is TRUSTED, but heading TRUSTED implies position TRUSTED.
 */

import { LoggerScope } from "../logging/types.js";
import { GnssPositionUpdateEvent } from "./sensorEvents.js";
import { unwrapInternalHeading, InternalHeading } from "../geometry/headingTypes.js";

export type GnssValidationState = "TRUSTED" | "DEGRADED" | "REJECTED";

export type GnssRejectionReason =
  | "fix_not_rtk_fixed"
  | "satellites_low"
  | "accuracy_high"
  | "no_heading"
  | "heading_invalid_flag"
  | "heading_baseline_out_of_range"
  | "heading_accuracy_high"
  | "heading_jump"
  | "heading_disagrees_with_imu";

export interface GnssValidationResult {
  readonly position: GnssValidationState;
  readonly heading: GnssValidationState;
  readonly positionRejections: GnssRejectionReason[];
  readonly headingRejections: GnssRejectionReason[];
  /** Sample-to-sample distance from the prior sample (m), null on first sample. */
  readonly jumpDistanceMeters: number | null;
}

export interface GnssValidatorOptions {
  readonly logger: LoggerScope;
  /** Minimum satellites in use. Spec: >= 8 (12 preferred). */
  readonly minSatellites?: number;
  /** Application accuracy ceiling for position (m). */
  readonly maxPositionAccuracyMeters?: number;
  /** Application accuracy ceiling for heading (deg). Spec robotics tier: 0.5°. */
  readonly maxHeadingAccuracyDeg?: number;
  /**
   * Configured antenna baseline (m).  The UM982 is configured with
   * `CONFIG HEADING LENGTH 30.00 5.00`, but the project hardware uses a
   * shorter dual-antenna baseline.  The runtime value should be set from
   * the same configuration source used by the firmware.
   */
  readonly baselineNominalMeters?: number;
  /** Allowed baseline error (m). */
  readonly baselineToleranceMeters?: number;
  /** Maximum credible heading change (deg per second of dt). */
  readonly maxHeadingRateDegPerSec?: number;
  /** Maximum |GNSS heading − IMU heading| during steady operation (deg). */
  readonly maxImuHeadingDisagreementDeg?: number;
  /** Consecutive valid epochs required to promote position to TRUSTED. */
  readonly positionPromotionEpochs?: number;
  /** Consecutive valid epochs required to promote heading to TRUSTED. */
  readonly headingPromotionEpochs?: number;
  /** Consecutive failures required to demote from TRUSTED. */
  readonly demotionEpochs?: number;
}

const DEFAULTS = {
  minSatellites: 8,
  maxPositionAccuracyMeters: 0.05,
  maxHeadingAccuracyDeg: 1.0,
  baselineNominalMeters: 0.30,
  baselineToleranceMeters: 0.05,
  maxHeadingRateDegPerSec: 20,
  maxImuHeadingDisagreementDeg: 5,
  positionPromotionEpochs: 3,
  headingPromotionEpochs: 5,
  demotionEpochs: 40,
};

export class GnssValidator {
  private readonly logger: LoggerScope;
  private readonly opts: Required<GnssValidatorOptions>;

  private positionConsecutivePass = 0;
  private positionConsecutiveFail = 0;
  private headingConsecutivePass = 0;
  private headingConsecutiveFail = 0;
  private positionState: GnssValidationState = "REJECTED";
  private headingState: GnssValidationState = "REJECTED";

  private lastSample: { x: number; y: number; t: number; headingDeg: number | null } | null = null;

  constructor(options: GnssValidatorOptions) {
    this.logger = options.logger;
    this.opts = {
      logger: options.logger,
      minSatellites: options.minSatellites ?? DEFAULTS.minSatellites,
      maxPositionAccuracyMeters: options.maxPositionAccuracyMeters ?? DEFAULTS.maxPositionAccuracyMeters,
      maxHeadingAccuracyDeg: options.maxHeadingAccuracyDeg ?? DEFAULTS.maxHeadingAccuracyDeg,
      baselineNominalMeters: options.baselineNominalMeters ?? DEFAULTS.baselineNominalMeters,
      baselineToleranceMeters: options.baselineToleranceMeters ?? DEFAULTS.baselineToleranceMeters,
      maxHeadingRateDegPerSec: options.maxHeadingRateDegPerSec ?? DEFAULTS.maxHeadingRateDegPerSec,
      maxImuHeadingDisagreementDeg: options.maxImuHeadingDisagreementDeg ?? DEFAULTS.maxImuHeadingDisagreementDeg,
      positionPromotionEpochs: options.positionPromotionEpochs ?? DEFAULTS.positionPromotionEpochs,
      headingPromotionEpochs: options.headingPromotionEpochs ?? DEFAULTS.headingPromotionEpochs,
      demotionEpochs: options.demotionEpochs ?? DEFAULTS.demotionEpochs,
    };
  }

  validate(sample: GnssPositionUpdateEvent, imuHeading: InternalHeading): GnssValidationResult {
    const positionRejections = this.validatePosition(sample);
    const headingRejections = this.validateHeading(sample, imuHeading, positionRejections.length === 0);

    this.advanceTemporalFilters(positionRejections.length === 0, headingRejections.length === 0);

    const result: GnssValidationResult = {
      position: this.positionState,
      heading: this.headingState,
      positionRejections,
      headingRejections,
      jumpDistanceMeters: this.lastSample === null ? null : Math.hypot(
        sample.xMeters - this.lastSample.x,
        sample.yMeters - this.lastSample.y,
      ),
    };

    this.lastSample = {
      x: sample.xMeters,
      y: sample.yMeters,
      t: sample.timestampMillis,
      headingDeg: sample.heading === null ? null : unwrapInternalHeading(sample.heading),
    };

    return result;
  }

  /** True only when the position state machine is currently TRUSTED. */
  isPositionTrusted(): boolean {
    return this.positionState === "TRUSTED";
  }

  /** True only when the heading state machine is currently TRUSTED. */
  isHeadingTrusted(): boolean {
    return this.headingState === "TRUSTED";
  }

  // ---------------------------------------------------------------------------
  // Internal: per-sample checks
  // ---------------------------------------------------------------------------

  private validatePosition(sample: GnssPositionUpdateEvent): GnssRejectionReason[] {
    const rejections: GnssRejectionReason[] = [];

    if (sample.fixType !== "fixed") {
      rejections.push("fix_not_rtk_fixed");
    }
    if (sample.satellitesInUse !== null && sample.satellitesInUse < this.opts.minSatellites) {
      rejections.push("satellites_low");
    }
    if (
      sample.positionAccuracyMeters === null ||
      sample.positionAccuracyMeters > this.opts.maxPositionAccuracyMeters
    ) {
      rejections.push("accuracy_high");
    }

    // No sample-to-sample physical-jump check yet — there is no calibrated
    // vehicle max speed to compare against until drive-learning produces one.
    // The temporal filter (3 consecutive valid epochs) plus RTK Fixed +
    // accuracy ≤ 5 cm is what protects against teleporting samples for now.

    return rejections;
  }

  private validateHeading(
    sample: GnssPositionUpdateEvent,
    imuHeading: InternalHeading,
    positionPassed: boolean,
  ): GnssRejectionReason[] {
    const rejections: GnssRejectionReason[] = [];

    if (!positionPassed) {
      // Heading requires position accepted first — surface fix issue once.
      rejections.push("fix_not_rtk_fixed");
      return rejections;
    }
    if (sample.heading === null) {
      rejections.push("no_heading");
      return rejections;
    }
    if (sample.headingValid === false) {
      rejections.push("heading_invalid_flag");
    }
    if (sample.headingBaselineMeters !== undefined) {
      const lo = this.opts.baselineNominalMeters - this.opts.baselineToleranceMeters;
      const hi = this.opts.baselineNominalMeters + this.opts.baselineToleranceMeters;
      if (sample.headingBaselineMeters < lo || sample.headingBaselineMeters > hi) {
        rejections.push("heading_baseline_out_of_range");
      }
    }
    if (sample.headingAccuracyDeg === null || sample.headingAccuracyDeg === undefined ||
        sample.headingAccuracyDeg > this.opts.maxHeadingAccuracyDeg) {
      rejections.push("heading_accuracy_high");
    }

    if (this.lastSample?.headingDeg !== undefined && this.lastSample?.headingDeg !== null) {
      const dt = Math.max(1e-3, (sample.timestampMillis - this.lastSample.t) / 1000);
      const prev = this.lastSample.headingDeg;
      const curr = unwrapInternalHeading(sample.heading);
      const wrapped = ((curr - prev + 540) % 360) - 180;
      const headingRateDegPerSec = Math.abs(wrapped) / dt;
      if (headingRateDegPerSec > this.opts.maxHeadingRateDegPerSec) {
        rejections.push("heading_jump");
      }
    }

    // IMU consistency check.
    const imuDeg = unwrapInternalHeading(imuHeading);
    const gnssDeg = unwrapInternalHeading(sample.heading);
    const rawDiff = gnssDeg - imuDeg;
    const disagreement = Math.abs(((rawDiff + 540) % 360) - 180);
    if (disagreement > this.opts.maxImuHeadingDisagreementDeg) {
      rejections.push("heading_disagrees_with_imu");
    }

    return rejections;
  }

  private advanceTemporalFilters(positionPassed: boolean, headingPassed: boolean): void {
    // Position
    if (positionPassed) {
      this.positionConsecutivePass += 1;
      this.positionConsecutiveFail = 0;
      if (this.positionConsecutivePass >= this.opts.positionPromotionEpochs) {
        if (this.positionState !== "TRUSTED") {
          this.logger.info("gnss_validator.position_promoted", { state: "TRUSTED" });
        }
        this.positionState = "TRUSTED";
      }
    } else {
      this.positionConsecutivePass = 0;
      this.positionConsecutiveFail += 1;
      if (this.positionConsecutiveFail >= this.opts.demotionEpochs) {
        if (this.positionState === "TRUSTED") {
          this.logger.info("gnss_validator.position_demoted", { to: "REJECTED" });
        }
        this.positionState = "REJECTED";
      }
    }
    // Heading
    if (headingPassed) {
      this.headingConsecutivePass += 1;
      this.headingConsecutiveFail = 0;
      if (this.headingConsecutivePass >= this.opts.headingPromotionEpochs) {
        if (this.headingState !== "TRUSTED") {
          this.logger.info("gnss_validator.heading_promoted", { state: "TRUSTED" });
        }
        this.headingState = "TRUSTED";
      }
    } else {
      this.headingConsecutivePass = 0;
      this.headingConsecutiveFail += 1;
      if (this.headingConsecutiveFail >= this.opts.demotionEpochs) {
        if (this.headingState === "TRUSTED") {
          this.logger.info("gnss_validator.heading_demoted", { to: "REJECTED" });
        }
        this.headingState = "REJECTED";
      }
    }
  }
}
