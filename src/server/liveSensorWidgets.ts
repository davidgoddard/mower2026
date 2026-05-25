export interface LiveSensorWidgetOptions {
  readonly imuCardId: string;
  readonly imuCompassId: string;
  readonly imuHeadingId: string;
  readonly imuPitchId: string;
  readonly imuRollId: string;
  readonly imuPitchIndicatorId: string;
  readonly imuRollIndicatorId: string;
  readonly imuStatusId: string;
  readonly imuErrorId: string;
  readonly gnssCompassId: string;
  readonly gnssHeadingId: string;
  readonly gnssHeadingAccuracyId: string;
  readonly gnssAccuracyId: string;
  readonly gnssStatusId: string;
  readonly gnssErrorId: string;
  readonly gnssFixId: string;
  readonly gnssSatsId: string;
  readonly gnssCardId: string;
  readonly gnssXMetersId?: string;
  readonly gnssYMetersId?: string;
  readonly includeGnsPosition: boolean;
  readonly includeTilt: boolean;
}

export function getLiveSensorWidgetsStyles(): string {
  return `
    .widget-sync-ok .sensor-card,
    .sensor-card.widget-sync-ok {
      background: linear-gradient(180deg, rgba(34, 197, 94, 0.14), rgba(16, 185, 129, 0.06)) !important;
      border-color: rgba(34, 197, 94, 0.42) !important;
      box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.12), var(--shadow-sm);
    }

    .widget-sync-warning .sensor-card,
    .sensor-card.widget-sync-warning {
      background: linear-gradient(180deg, rgba(249, 115, 22, 0.16), rgba(245, 158, 11, 0.08)) !important;
      border-color: rgba(249, 115, 22, 0.42) !important;
      box-shadow: 0 0 0 1px rgba(249, 115, 22, 0.12), var(--shadow-sm);
    }

    .live-widget {
      transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .live-widget .compass {
      width: 100px;
      height: 100px;
      margin: 0 auto;
      position: relative;
    }

    .live-widget .compass-circle {
      width: 100%;
      height: 100%;
      border: 3px solid var(--border-color);
      border-radius: 50%;
      position: relative;
      background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
    }

    .live-widget .compass-needle {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 4px;
      height: 45%;
      background: linear-gradient(to top, var(--danger-color), var(--primary-color));
      transform-origin: bottom center;
      transform: translate(-50%, -100%) rotate(var(--heading-deg, 0deg));
      border-radius: 2px;
      transition: transform 0.3s ease-out;
    }

    .live-widget .compass-center {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 12px;
      height: 12px;
      background: var(--text-primary);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 3px var(--bg-primary);
    }

    .live-widget .compass-label {
      position: absolute;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .live-widget .compass-label.n { top: 8px; left: 50%; transform: translateX(-50%); }
    .live-widget .compass-label.e { right: 8px; top: 50%; transform: translateY(-50%); }
    .live-widget .compass-label.s { bottom: 8px; left: 50%; transform: translateX(-50%); }
    .live-widget .compass-label.w { left: 8px; top: 50%; transform: translateY(-50%); }

    .live-widget .position-display {
      text-align: center;
      padding: 0.75rem;
      background: var(--bg-tertiary);
      border-radius: 0.5rem;
      margin-top: 0.75rem;
    }

    .live-widget .top-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-top: 0.75rem;
    }

    .live-widget .top-summary {
      flex: 1;
      display: grid;
      gap: 0.75rem;
    }

    .live-widget .top-summary.one {
      grid-template-columns: minmax(0, 1fr);
    }

    .live-widget .top-summary.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .live-widget .top-summary.three {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .live-widget .top-metric {
      padding: 0.8rem 0.9rem;
      background: rgba(255, 255, 255, 0.68);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 0.75rem;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset, 0 1px 2px rgba(15, 23, 42, 0.05);
    }

    .live-widget .top-metric .metric-label {
      margin-bottom: 0.25rem;
    }

    .live-widget .top-metric .metric-value {
      white-space: normal;
    }

    .live-widget .metric {
      padding: 0.8rem 0.9rem;
      background: rgba(255, 255, 255, 0.68);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 0.75rem;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset, 0 1px 2px rgba(15, 23, 42, 0.05);
    }

    .live-widget .metric-value {
      font-size: clamp(1.05rem, 1.1vw, 1.35rem);
      line-height: 1.08;
      white-space: nowrap;
    }

    .live-widget .metric-value.large {
      font-size: clamp(1.35rem, 1.8vw, 1.8rem);
    }

    .live-widget .tilt-indicators {
      display: flex;
      justify-content: space-around;
      gap: 1rem;
      margin-top: 1rem;
    }

    .live-widget .tilt-indicator {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    .live-widget .tilt-circle {
      width: 80px;
      height: 80px;
      border: 3px solid var(--border-color);
      border-radius: 50%;
      position: relative;
      background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
    }

    .live-widget .tilt-line {
      position: absolute;
      top: 50%;
      left: 10%;
      right: 10%;
      height: 3px;
      background: var(--primary-color);
      transform-origin: center center;
      transform: translateY(-50%) rotate(var(--tilt-deg, 0deg));
      border-radius: 2px;
      transition: transform 0.3s ease-out;
    }

    .live-widget .tilt-center {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 8px;
      height: 8px;
      background: var(--text-primary);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 2px var(--bg-primary);
    }

    .live-widget .tilt-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .live-widget .tilt-value {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .live-widget .gnss-summary {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
      margin-top: 1rem;
    }

    .live-widget .gnss-row {
      display: grid;
      gap: 1rem;
    }

    .live-widget .gnss-row.three {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .live-widget .gnss-row.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .live-widget .gnss-fix-value {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 5.25rem;
      padding: 0.35rem 0.7rem;
      border-radius: 0.5rem;
      background: var(--bg-tertiary);
    }

    .live-widget .gnss-fix-value.gnss-fix-unknown,
    .live-widget .gnss-fix-value.gnss-fix-none {
      background: #fee2e2;
      color: #991b1b;
    }

    .live-widget .gnss-fix-value.gnss-fix-single {
      background: #ffedd5;
      color: #9a3412;
    }

    .live-widget .gnss-fix-value.gnss-fix-float {
      background: #fef3c7;
      color: #92400e;
    }

    .live-widget .gnss-fix-value.gnss-fix-fixed {
      background: #dcfce7;
      color: #166534;
    }
  `;
}

export function getLiveSensorWidgetsScript(): string {
  return `
    function internalToNavigationHeading(headingDeg) {
      return (90 - headingDeg + 360) % 360;
    }

    function setWidgetSyncState(widgetIds, isSynced) {
      const stateClass = isSynced ? "widget-sync-ok" : "widget-sync-warning";
      const background = isSynced
        ? "linear-gradient(180deg, rgba(34, 197, 94, 0.14), rgba(16, 185, 129, 0.06))"
        : "linear-gradient(180deg, rgba(249, 115, 22, 0.16), rgba(245, 158, 11, 0.08))";
      const borderColor = isSynced
        ? "rgba(34, 197, 94, 0.42)"
        : "rgba(249, 115, 22, 0.42)";
      const boxShadow = isSynced
        ? "0 0 0 1px rgba(34, 197, 94, 0.12), var(--shadow-sm)"
        : "0 0 0 1px rgba(249, 115, 22, 0.12), var(--shadow-sm)";
      for (const widgetId of widgetIds) {
        const root = document.getElementById(widgetId);
        if (!root) continue;
        root.classList.remove("widget-sync-ok", "widget-sync-warning");
        root.classList.add(stateClass);
        root.style.background = background;
        root.style.borderColor = borderColor;
        root.style.boxShadow = boxShadow;
      }
    }

    function updateWidgetSyncState(widgetIds, usingGnssHeading) {
      setWidgetSyncState(widgetIds, usingGnssHeading === true);
    }

    function updateWidgetHeading(compassId, headingId, headingDeg) {
      const compass = document.getElementById(compassId);
      const heading = document.getElementById(headingId);
      const navigationHeading = headingDeg !== null && headingDeg !== undefined
        ? internalToNavigationHeading(headingDeg)
        : null;
      if (heading) {
        heading.textContent = navigationHeading !== null ? formatDegrees(navigationHeading) : "—";
      }
      if (compass) {
        compass.style.setProperty("--heading-deg", (navigationHeading !== null ? navigationHeading : 0) + "deg");
      }
      return navigationHeading;
    }

    function updateTiltIndicator(indicatorId, valueId, value) {
      const indicator = document.getElementById(indicatorId);
      const output = document.getElementById(valueId);
      if (output) {
        output.textContent = value !== null && value !== undefined ? formatDegrees(value) : "—";
      }
      if (indicator) {
        indicator.style.setProperty("--tilt-deg", (value !== null && value !== undefined ? value : 0) + "deg");
      }
    }
  `;
}

export function getLiveSensorWidgetsHtml(options: LiveSensorWidgetOptions): string {
  const tilt = options.includeTilt
    ? `
      <div class="tilt-indicators">
        <div class="tilt-indicator">
          <div class="tilt-circle" id="${options.imuPitchIndicatorId}">
            <div class="tilt-line"></div>
            <div class="tilt-center"></div>
          </div>
          <div class="tilt-label">Pitch</div>
          <div class="tilt-value" id="${options.imuPitchId}">—</div>
        </div>
        <div class="tilt-indicator">
          <div class="tilt-circle" id="${options.imuRollIndicatorId}">
            <div class="tilt-line"></div>
            <div class="tilt-center"></div>
          </div>
          <div class="tilt-label">Roll</div>
          <div class="tilt-value" id="${options.imuRollId}">—</div>
        </div>
      </div>
    `
    : `
      <div class="metric-row compact">
        <div class="metric">
          <div class="metric-label">Pitch</div>
          <div class="metric-value" id="${options.imuPitchId}">—</div>
        </div>
        <div class="metric">
          <div class="metric-label">Roll</div>
          <div class="metric-value" id="${options.imuRollId}">—</div>
        </div>
      </div>
    `;

  const gnssPosition = options.includeGnsPosition
    ? `
      <div class="gnss-row three">
        <div class="metric">
          <div class="metric-label">X</div>
          <div class="metric-value" id="${options.gnssXMetersId ?? "gnss-x"}">—</div>
        </div>
        <div class="metric">
          <div class="metric-label">Y</div>
          <div class="metric-value" id="${options.gnssYMetersId ?? "gnss-y"}">—</div>
        </div>
        <div class="metric">
          <div class="metric-label">Position Accuracy</div>
          <div class="metric-value" id="${options.gnssAccuracyId}">—</div>
        </div>
      </div>
    `
    : `
      <div class="gnss-row two">
        <div class="metric">
          <div class="metric-label">Position</div>
          <div class="metric-value" id="${options.gnssXMetersId ?? "gnss-x"}">—</div>
        </div>
        <div class="metric">
          <div class="metric-label">Position Accuracy</div>
          <div class="metric-value" id="${options.gnssAccuracyId}">—</div>
        </div>
      </div>
    `;

  return `
    <div class="sensor-card live-widget" id="${options.imuCardId}">
      <div class="sensor-header">
        <div class="sensor-title">IMU Sensor</div>
        <span class="status-dot" id="${options.imuStatusId}"></span>
      </div>
      <div class="top-row">
        <div class="compass" id="${options.imuCompassId}">
          <div class="compass-circle">
            <div class="compass-label n">N</div>
            <div class="compass-label e">E</div>
            <div class="compass-label s">S</div>
            <div class="compass-label w">W</div>
            <div class="compass-needle"></div>
            <div class="compass-center"></div>
          </div>
        </div>
        <div class="top-summary one">
          <div class="top-metric">
            <div class="metric-label">Heading</div>
            <div class="metric-value large" id="${options.imuHeadingId}">—</div>
          </div>
        </div>
      </div>
      ${tilt}
      <div id="${options.imuErrorId}" class="error-message" style="display: none;"></div>
    </div>

    <div class="sensor-card live-widget" id="${options.gnssCardId}">
      <div class="sensor-header">
        <div class="sensor-title">GNSS Position</div>
        <span class="status-dot" id="${options.gnssStatusId}"></span>
      </div>
      <div class="top-row">
        <div class="compass" id="${options.gnssCompassId}">
          <div class="compass-circle">
            <div class="compass-label n">N</div>
            <div class="compass-label e">E</div>
            <div class="compass-label s">S</div>
            <div class="compass-label w">W</div>
            <div class="compass-needle"></div>
            <div class="compass-center"></div>
          </div>
        </div>
        <div class="top-summary two">
          <div class="top-metric">
            <div class="metric-label">Heading</div>
            <div class="metric-value large" id="${options.gnssHeadingId}">—</div>
          </div>
          <div class="top-metric">
            <div class="metric-label">Heading Accuracy</div>
            <div class="metric-value" id="${options.gnssHeadingAccuracyId}">—</div>
          </div>
        </div>
      </div>
      <div class="gnss-summary">
        ${gnssPosition}
        <div class="gnss-row two">
          <div class="metric">
            <div class="metric-label">Fix Type</div>
            <div class="metric-value gnss-fix-value" id="${options.gnssFixId}">—</div>
          </div>
          <div class="metric">
            <div class="metric-label">Satellites</div>
            <div class="metric-value" id="${options.gnssSatsId}">—</div>
          </div>
        </div>
      </div>
      <div id="${options.gnssErrorId}" class="error-message" style="display: none;"></div>
    </div>
  `;
}
