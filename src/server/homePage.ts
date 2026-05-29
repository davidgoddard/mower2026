import { getSensorWidgetScriptTag, getSensorWidgetLayoutStyles } from "./liveSensorWidgets.js";


export function renderHomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mower Control Dashboard</title>
      <style>
${getSensorWidgetLayoutStyles()}
        :root {
        --primary-color: #2563eb;
        --primary-hover: #1d4ed8;
        --success-color: #10b981;
        --danger-color: #ef4444;
        --warning-color: #f59e0b;
        --bg-primary: #ffffff;
        --bg-secondary: #f9fafb;
        --bg-tertiary: #f3f4f6;
        --text-primary: #111827;
        --text-secondary: #6b7280;
        --text-muted: #9ca3af;
        --border-color: #e5e7eb;
        --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
      }

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        background: var(--bg-secondary);
        color: var(--text-primary);
        line-height: 1.6;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }

      .header {
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border-color);
        padding: 1.5rem 0;
        box-shadow: var(--shadow-sm);
      }

      .header-content {
        max-width: 1400px;
        margin: 0 auto;
        padding: 0 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 2rem;
      }

      .header-left {
        flex: 1;
      }

      h1 {
        font-size: 1.875rem;
        font-weight: 700;
        color: var(--text-primary);
        margin-bottom: 0.25rem;
      }

      .subtitle {
        color: var(--text-secondary);
        font-size: 0.875rem;
      }

      .header-nav {
        display: flex;
        gap: 0.75rem;
      }

      .nav-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.625rem 1.25rem;
        background: var(--primary-color);
        color: white;
        text-decoration: none;
        border-radius: 0.5rem;
        font-weight: 500;
        font-size: 0.875rem;
        transition: all 0.2s;
        box-shadow: var(--shadow-sm);
        gap: 0.5rem;
      }

      .nav-button:hover {
        background: var(--primary-hover);
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .nav-button-icon {
        font-size: 1.125rem;
      }

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 1.5rem 1.5rem;
        flex: 1;
      }

      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1.5rem;
        margin-bottom: 1.5rem;
      }

      .sensor-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.25rem;
        box-shadow: var(--shadow-sm);
      }

      .sensor-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.875rem;
        padding-bottom: 0.875rem;
        border-bottom: 1px solid var(--border-color);
      }

      .sensor-title {
        font-size: 1rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }

      .status-dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        display: inline-block;
      }

      .status-dot.running {
        background: var(--success-color);
        box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
      }

      .status-dot.error {
        background: var(--danger-color);
        box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.2);
      }

      .status-dot.idle {
        background: var(--text-muted);
      }

      .metric-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1rem;
      }

      .metric {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .metric-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .metric-value {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .metric-value.large {
        font-size: 1.5rem;
      }

      .metric-unit {
        font-size: 0.875rem;
        color: var(--text-secondary);
        font-weight: 400;
      }

      .compass {
        width: 100px;
        height: 100px;
        margin: 0 auto;
        position: relative;
      }

      .compass-circle {
        width: 100%;
        height: 100%;
        border: 3px solid var(--border-color);
        border-radius: 50%;
        position: relative;
        background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
      }

      .compass-needle {
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

      .compass-center {
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

      .compass-label {
        position: absolute;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      .compass-label.n { top: 8px; left: 50%; transform: translateX(-50%); }
      .compass-label.e { right: 8px; top: 50%; transform: translateY(-50%); }
      .compass-label.s { bottom: 8px; left: 50%; transform: translateX(-50%); }
      .compass-label.w { left: 8px; top: 50%; transform: translateY(-50%); }

      .tilt-indicators {
        display: flex;
        justify-content: space-around;
        gap: 1rem;
        margin-top: 1rem;
      }

      .tilt-indicator {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
      }

      .tilt-circle {
        width: 80px;
        height: 80px;
        border: 3px solid var(--border-color);
        border-radius: 50%;
        position: relative;
        background: radial-gradient(circle, var(--bg-secondary) 0%, var(--bg-primary) 70%);
      }

      .tilt-line {
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

      .tilt-center {
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

      .tilt-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .tilt-value {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      .vu-meter-container {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .vu-meter-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .vu-meter-values {
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      .vu-meter-track {
        width: 100%;
        height: 24px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        position: relative;
        overflow: hidden;
        border: 1px solid var(--border-color);
      }

      .vu-meter-bar {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        background: linear-gradient(to right, var(--success-color) 0%, var(--success-color) 60%, var(--warning-color) 80%, var(--danger-color) 100%);
        width: 0%;
        transition: width 0.2s ease-out;
        border-radius: 3px 0 0 3px;
      }

      .vu-meter-peak {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--danger-color);
        box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
        left: 0%;
        transition: left 0.1s ease-out;
      }

      .vu-meter-scale {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        display: flex;
        pointer-events: none;
      }

      .vu-meter-tick {
        flex: 1;
        border-right: 1px solid rgba(0, 0, 0, 0.1);
      }

      .vu-meter-tick:last-child {
        border-right: none;
      }

      .position-display {
        text-align: center;
        padding: 0.75rem;
        background: var(--bg-tertiary);
        border-radius: 0.5rem;
        margin-top: 0.75rem;
      }

      .coordinates {
        display: flex;
        justify-content: center;
        gap: 2rem;
        margin-top: 0.5rem;
      }

      .gnss-summary {
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        margin-top: 1rem;
      }

      .gnss-row {
        display: grid;
        gap: 1rem;
      }

      .gnss-row.three {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .gnss-row.two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .coordinate {
        display: flex;
        flex-direction: column;
      }

      .coordinate-label {
        font-size: 0.75rem;
        color: var(--text-secondary);
        text-transform: uppercase;
      }

      .coordinate-value {
        font-size: 1.25rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }

      .metric-secondary {
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-top: 0.125rem;
      }

      .metric-value.small {
        font-size: 1rem;
      }

      .gnss-fix-value {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 5.25rem;
        padding: 0.35rem 0.7rem;
        border-radius: 0.5rem;
        background: var(--bg-tertiary);
      }

      .gnss-fix-value.gnss-fix-unknown,
      .gnss-fix-value.gnss-fix-none {
        background: #fee2e2;
        color: #991b1b;
      }

      .gnss-fix-value.gnss-fix-single {
        background: #ffedd5;
        color: #9a3412;
      }

      .gnss-fix-value.gnss-fix-float {
        background: #fef3c7;
        color: #92400e;
      }

      .gnss-fix-value.gnss-fix-fixed,
      .gnss-fix-value.gnss-fix-rtk-fixed {
        background: #d1fae5;
        color: #065f46;
      }

      .gnss-fix-value.gnss-fix-rtk-float {
        background: #dcfce7;
        color: #166534;
      }

      .error-message {
        background: #fef2f2;
        color: #991b1b;
        padding: 0.75rem;
        border-radius: 0.5rem;
        font-size: 0.875rem;
        margin-top: 0.5rem;
      }

      .footer {
        background: var(--bg-primary);
        border-top: 1px solid var(--border-color);
        padding: 1rem 0;
        margin-top: auto;
      }

      .footer-content {
        max-width: 1400px;
        margin: 0 auto;
        padding: 0 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 1rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .footer-status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .timeline-section {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.25rem;
        box-shadow: var(--shadow-sm);
        margin-bottom: 1.5rem;
      }

      .timeline-section-title {
        font-size: 1rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        margin-bottom: 0.75rem;
      }

      .timeline-canvas {
        width: 100%;
        display: block;
        background: #ffffff;
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
      }

      .timeline-legend {
        display: flex;
        gap: 1.25rem;
        margin-top: 0.5rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
      }

      .legend-swatch {
        display: inline-block;
        width: 18px;
        height: 3px;
        vertical-align: middle;
        margin-right: 4px;
        border-radius: 2px;
      }

      .timeline-stats {
        margin-top: 0.375rem;
        font-size: 0.75rem;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }

      @media (max-width: 1024px) {
        .dashboard-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 768px) {
        .header-content {
          flex-direction: column;
          align-items: flex-start;
        }

        .header-nav {
          width: 100%;
        }

        .nav-button {
          flex: 1;
        }

        .metric-grid {
          grid-template-columns: 1fr;
        }

        .footer-content {
          flex-direction: column;
          text-align: center;
        }
      }
    </style>
${getSensorWidgetScriptTag()}
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <div class="header-left">
          <h1>🚜 Mower Control Dashboard</h1>
          <div class="subtitle">Autonomous Lawn Mower Control System</div>
        </div>
        <div class="header-nav">
          <a href="/turn-tuning" class="nav-button" title="Configure and test autonomous turning with self-learning brake points">
            <span class="nav-button-icon">🔄</span>
            <span>Turn Tuning</span>
          </a>
          <a href="/drive-tuning" class="nav-button" title="Test point-to-point navigation with CTE correction and waypoint patterns">
            <span class="nav-button-icon">🎯</span>
            <span>Drive Tuning</span>
          </a>
          <a href="/segment-testing" class="nav-button" title="Collect rough waypoints and exercise the full turn-and-drive segment controller">
            <span class="nav-button-icon">🧭</span>
            <span>Segment Testing</span>
          </a>
          <a href="/manual-drive" class="nav-button" title="Manual drive, live position tracking, and stored path management">
            <span class="nav-button-icon">🧭</span>
            <span>Drive &amp; Paths</span>
          </a>
          <a href="/dead-reckoning" class="nav-button" title="Calibrate dead-reckoning: straight-line encoder calibration and arc tracking validation">
            <span class="nav-button-icon">📐</span>
            <span>Dead Reckoning</span>
          </a>
        </div>
      </div>
    </div>

    <div class="container">
      <!-- Sensor Dashboard -->
      <div class="dashboard-grid">
        <imu-sensor-widget id="imu-widget"></imu-sensor-widget>
        <gnss-position-widget id="gnss-widget"></gnss-position-widget>

        <!-- Motors Card -->
        <div class="sensor-card">
          <div class="sensor-header">
            <div class="sensor-title">Motor Status</div>
            <span class="status-dot" id="motor-status"></span>
          </div>
          <div class="metric-grid" style="grid-template-columns: repeat(2, 1fr);">
            <div class="metric">
              <div class="metric-label">Left Speed</div>
              <div class="metric-value" id="motor-left">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Right Speed</div>
              <div class="metric-value" id="motor-right">—</div>
            </div>
          </div>

          <!-- VU Meters for Current -->
          <div style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
            <div class="vu-meter-container">
              <div class="vu-meter-label">
                <span>Left Motor Current</span>
                <span class="vu-meter-values"><span id="motor-left-current">—</span> / <span id="motor-left-peak">—</span></span>
              </div>
              <div class="vu-meter-track">
                <div class="vu-meter-scale">
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                </div>
                <div class="vu-meter-bar" id="motor-left-vu-bar"></div>
                <div class="vu-meter-peak" id="motor-left-vu-peak"></div>
              </div>
            </div>
            <div class="vu-meter-container">
              <div class="vu-meter-label">
                <span>Right Motor Current</span>
                <span class="vu-meter-values"><span id="motor-right-current">—</span> / <span id="motor-right-peak">—</span></span>
              </div>
              <div class="vu-meter-track">
                <div class="vu-meter-scale">
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                  <div class="vu-meter-tick"></div>
                </div>
                <div class="vu-meter-bar" id="motor-right-vu-bar"></div>
                <div class="vu-meter-peak" id="motor-right-vu-peak"></div>
              </div>
            </div>
          </div>

          <div class="metric-grid" style="margin-top: 1rem;">
            <div class="metric">
              <div class="metric-label">Left PWM</div>
              <div class="metric-value" style="font-size: 1rem;" id="motor-left-pwm">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Right PWM</div>
              <div class="metric-value" style="font-size: 1rem;" id="motor-right-pwm">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Watchdog</div>
              <div class="metric-value" style="font-size: 1rem;" id="motor-watchdog">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Faults</div>
              <div class="metric-value" style="font-size: 1rem;" id="motor-faults">—</div>
            </div>
          </div>
          <div id="motor-error" class="error-message" style="display: none;"></div>
        </div>
      </div>
      <!-- Heading Timeline -->
      <div class="timeline-section">
        <div class="timeline-section-title">Heading History (last hour)</div>
        <canvas id="headingCanvas" class="timeline-canvas" height="200"></canvas>
        <div class="timeline-legend">
          <span><span class="legend-swatch" style="background:#2563eb;"></span>IMU (fused)</span>
          <span><span class="legend-swatch" style="background:#f59e0b;"></span>GNSS heading ± accuracy</span>
        </div>
        <div class="timeline-stats" id="headingStats">Waiting for heading data…</div>
      </div>

      <!-- Position Accuracy Timeline -->
      <div class="timeline-section">
        <div class="timeline-section-title">Position Accuracy History (last hour)</div>
        <canvas id="posAccCanvas" class="timeline-canvas" height="140"></canvas>
        <div class="timeline-legend">
          <span><span class="legend-swatch" style="background:#10b981;"></span>GNSS position accuracy (m)</span>
        </div>
        <div class="timeline-stats" id="posAccStats">Waiting for accuracy data…</div>
      </div>
    </div>

    <div class="footer">
      <div class="footer-content">
        <div class="footer-status">
          <span class="status-dot" id="server-status"></span>
          <span id="server-state">Server: —</span>
        </div>
        <div id="last-update">Last updated: —</div>
      </div>
    </div>

    <script>
      // Peak tracking for motor current VU meters
      const MOTOR_CURRENT_MAX_AMPS = 10.0; // Maximum expected current for scale
      const PEAK_HOLD_TIME_MS = 2000; // Hold peak for 2 seconds
      let leftMotorPeakAmps = 0;
      let rightMotorPeakAmps = 0;
      let leftPeakTimestamp = 0;
      let rightPeakTimestamp = 0;

      function updateVUMeter(currentAmps, peakAmps, barId, peakId, currentTextId, peakTextId) {
        const now = Date.now();
        const barElement = document.getElementById(barId);
        const peakElement = document.getElementById(peakId);
        const currentText = document.getElementById(currentTextId);
        const peakText = document.getElementById(peakTextId);

        if (currentAmps === null || currentAmps === undefined) {
          barElement.style.width = '0%';
          peakElement.style.left = '0%';
          currentText.textContent = '—';
          peakText.textContent = '—';
          return 0;
        }

        // Update current level
        const currentPercent = Math.min(100, (currentAmps / MOTOR_CURRENT_MAX_AMPS) * 100);
        barElement.style.width = currentPercent + '%';
        currentText.textContent = currentAmps.toFixed(2) + 'A';

        // Update peak
        let newPeak = peakAmps;
        if (currentAmps > peakAmps) {
          newPeak = currentAmps;
        }
        const peakPercent = Math.min(100, (newPeak / MOTOR_CURRENT_MAX_AMPS) * 100);
        peakElement.style.left = peakPercent + '%';
        peakText.textContent = newPeak.toFixed(2) + 'A';

        return newPeak;
      }

      // ── Timeline history ──────────────────────────────────────────────────
      const MAX_TIMELINE_POINTS = 3600;

      // Each entry: { imuDeg, gnssDeg, gnssAccDeg, posAccM } — all InternalHeading, all nullable
      const timelineHistory = [];

      const headingCanvas = document.getElementById('headingCanvas');
      const headingCtx = headingCanvas.getContext('2d');
      const posAccCanvas = document.getElementById('posAccCanvas');
      const posAccCtx = posAccCanvas.getContext('2d');

      // InternalHeading (-180..180 Cartesian) → FieldHeading (0..360 N=0)
      function internalToField(deg) {
        return ((90 - deg) % 360 + 360) % 360;
      }

      function syncCanvasWidth(canvas) {
        const w = canvas.clientWidth || canvas.parentElement.clientWidth || 900;
        if (canvas.width !== w) canvas.width = w;
        return canvas.width;
      }

      function addTimelinePoint(imuDeg, gnssDeg, gnssAccDeg, posAccM) {
        timelineHistory.push({ imuDeg, gnssDeg, gnssAccDeg, posAccM });
        if (timelineHistory.length > MAX_TIMELINE_POINTS) timelineHistory.shift();
      }

      function drawHeadingTimeline() {
        const W = syncCanvasWidth(headingCanvas);
        const H = headingCanvas.height;
        const padL = 46, padR = 10, padT = 10, padB = 22;
        const plotW = W - padL - padR;
        const plotH = H - padT - padB;
        const n = timelineHistory.length;

        headingCtx.clearRect(0, 0, W, H);
        headingCtx.fillStyle = '#ffffff';
        headingCtx.fillRect(0, 0, W, H);

        const yFor = (deg) => padT + plotH - (deg / 360) * plotH;
        const xFor = (i) => padL + (i / Math.max(n - 1, 1)) * plotW;

        // Grid lines every 45°
        headingCtx.strokeStyle = 'rgba(0,0,0,0.07)';
        headingCtx.lineWidth = 1;
        headingCtx.fillStyle = '#111827';
        headingCtx.font = '10px system-ui,sans-serif';
        headingCtx.textAlign = 'right';
        for (let ang = 0; ang <= 360; ang += 45) {
          const y = yFor(ang);
          headingCtx.beginPath();
          headingCtx.moveTo(padL, y);
          headingCtx.lineTo(padL + plotW, y);
          headingCtx.stroke();
          headingCtx.fillText(ang + '°', padL - 4, y + 3.5);
        }

        if (n === 0) return;

        // GNSS accuracy band — one ImageData column per point
        for (let i = 0; i < n; i++) {
          const pt = timelineHistory[i];
          if (pt.gnssDeg === null || pt.gnssAccDeg === null) continue;
          const cx = Math.round(xFor(i));
          const cyCentre = yFor(pt.gnssDeg) - padT; // relative to plot area
          const halfBandPx = (pt.gnssAccDeg / 360) * plotH;
          const col = new Uint8ClampedArray(plotH * 4);
          for (let py = 0; py < plotH; py++) {
            const dist = Math.abs(py - cyCentre);
            const a = halfBandPx > 0 ? Math.max(0, 1 - dist / halfBandPx) * 100 : 0;
            const idx = py * 4;
            col[idx] = 245; col[idx + 1] = 158; col[idx + 2] = 11; col[idx + 3] = Math.round(a);
          }
          headingCtx.putImageData(new ImageData(col, 1, plotH), cx, padT);
        }

        // IMU line
        headingCtx.strokeStyle = '#2563eb';
        headingCtx.lineWidth = 1.5;
        headingCtx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const pt = timelineHistory[i];
          if (pt.imuDeg === null) { started = false; continue; }
          const x = xFor(i), y = yFor(internalToField(pt.imuDeg));
          if (!started) { headingCtx.moveTo(x, y); started = true; } else headingCtx.lineTo(x, y);
        }
        headingCtx.stroke();

        // GNSS heading line
        headingCtx.strokeStyle = '#f59e0b';
        headingCtx.lineWidth = 2;
        headingCtx.beginPath();
        started = false;
        for (let i = 0; i < n; i++) {
          const pt = timelineHistory[i];
          if (pt.gnssDeg === null) { started = false; continue; }
          const x = xFor(i), y = yFor(internalToField(pt.gnssDeg));
          if (!started) { headingCtx.moveTo(x, y); started = true; } else headingCtx.lineTo(x, y);
        }
        headingCtx.stroke();

        // Y-axis label
        headingCtx.save();
        headingCtx.fillStyle = '#111827';
        headingCtx.font = '10px system-ui,sans-serif';
        headingCtx.textAlign = 'center';
        headingCtx.translate(8, padT + plotH / 2);
        headingCtx.rotate(-Math.PI / 2);
        headingCtx.fillText('Heading (°)', 0, 0);
        headingCtx.restore();

        const last = timelineHistory[n - 1];
        document.getElementById('headingStats').textContent =
          n + ' points' +
          (last.imuDeg !== null ? ' | IMU: ' + internalToField(last.imuDeg).toFixed(1) + '°' : '') +
          (last.gnssDeg !== null ? ' | GNSS: ' + internalToField(last.gnssDeg).toFixed(1) + '°' +
            (last.gnssAccDeg !== null ? ' ±' + last.gnssAccDeg.toFixed(1) + '°' : '') : '');
      }

      let posAccMaxM = 0.5;

      function drawPosAccTimeline() {
        const W = syncCanvasWidth(posAccCanvas);
        const H = posAccCanvas.height;
        const padL = 52, padR = 10, padT = 10, padB = 22;
        const plotW = W - padL - padR;
        const plotH = H - padT - padB;
        const n = timelineHistory.length;

        posAccCtx.clearRect(0, 0, W, H);
        posAccCtx.fillStyle = '#ffffff';
        posAccCtx.fillRect(0, 0, W, H);

        for (const pt of timelineHistory) {
          if (pt.posAccM !== null && pt.posAccM > posAccMaxM) {
            posAccMaxM = Math.ceil(pt.posAccM * 2) / 2;
          }
        }

        const yFor = (m) => padT + plotH - (m / posAccMaxM) * plotH;
        const xFor = (i) => padL + (i / Math.max(n - 1, 1)) * plotW;

        const step = posAccMaxM <= 0.5 ? 0.1 : posAccMaxM <= 2 ? 0.5 : 1;
        posAccCtx.strokeStyle = 'rgba(0,0,0,0.07)';
        posAccCtx.lineWidth = 1;
        posAccCtx.fillStyle = '#111827';
        posAccCtx.font = '10px system-ui,sans-serif';
        posAccCtx.textAlign = 'right';
        for (let m = 0; m <= posAccMaxM + 0.001; m = Math.round((m + step) * 1000) / 1000) {
          const y = yFor(m);
          posAccCtx.beginPath();
          posAccCtx.moveTo(padL, y);
          posAccCtx.lineTo(padL + plotW, y);
          posAccCtx.stroke();
          posAccCtx.fillText(m.toFixed(2) + 'm', padL - 4, y + 3.5);
        }

        if (n === 0) return;

        posAccCtx.strokeStyle = '#10b981';
        posAccCtx.lineWidth = 1.5;
        posAccCtx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const pt = timelineHistory[i];
          if (pt.posAccM === null) { started = false; continue; }
          const x = xFor(i), y = yFor(pt.posAccM);
          if (!started) { posAccCtx.moveTo(x, y); started = true; } else posAccCtx.lineTo(x, y);
        }
        posAccCtx.stroke();

        posAccCtx.save();
        posAccCtx.fillStyle = '#111827';
        posAccCtx.font = '10px system-ui,sans-serif';
        posAccCtx.textAlign = 'center';
        posAccCtx.translate(8, padT + plotH / 2);
        posAccCtx.rotate(-Math.PI / 2);
        posAccCtx.fillText('Acc (m)', 0, 0);
        posAccCtx.restore();

        const last = timelineHistory[n - 1];
        document.getElementById('posAccStats').textContent =
          n + ' points | current: ' + (last.posAccM !== null ? last.posAccM.toFixed(3) + ' m' : 'n/a') +
          ' | scale: 0–' + posAccMaxM.toFixed(2) + ' m';
      }

      async function updateDashboard() {
        try {
          const [primitives, health] = await Promise.all([
            fetch('/api/primitives').then(r => r.json()),
            fetch('/health').then(r => r.json())
          ]);

          // Update IMU + GNSS widgets
          const imu = primitives.primitives.imu ?? {};
          const gnss = primitives.primitives.gnss ?? {};
          const poseFusion = primitives.primitives.poseFusion ?? {};
          const imuWidget = document.getElementById('imu-widget');
          const gnssWidget = document.getElementById('gnss-widget');
          if (imuWidget) {
            imuWidget.setAttribute('status', imu.status || 'idle');
            if (imu.error != null) imuWidget.setAttribute('error', imu.error);
            if (imu.headingDeg != null) imuWidget.setAttribute('heading-deg', imu.headingDeg);
            if (imu.pitchDeg != null) imuWidget.setAttribute('pitch-deg', imu.pitchDeg);
            if (imu.rollDeg != null) imuWidget.setAttribute('roll-deg', imu.rollDeg);
            imuWidget.setAttribute('synced', poseFusion.usingGnssHeading === true ? 'true' : 'false');
          }
          if (gnssWidget) {
            gnssWidget.setAttribute('status', gnss.status || 'idle');
            if (gnss.error != null) gnssWidget.setAttribute('error', gnss.error);
            if (gnss.headingDeg != null) gnssWidget.setAttribute('heading-deg', gnss.headingDeg);
            if (gnss.headingAccuracyDeg != null) gnssWidget.setAttribute('heading-accuracy-deg', gnss.headingAccuracyDeg);
            if (gnss.xMeters != null) gnssWidget.setAttribute('x-meters', gnss.xMeters);
            if (gnss.yMeters != null) gnssWidget.setAttribute('y-meters', gnss.yMeters);
            if (gnss.positionAccuracyMeters != null) gnssWidget.setAttribute('position-accuracy-meters', gnss.positionAccuracyMeters);
            if (gnss.fixType != null) gnssWidget.setAttribute('fix-type', gnss.fixType);
            if (gnss.satellitesInUse != null) gnssWidget.setAttribute('satellites', gnss.satellitesInUse);
            gnssWidget.setAttribute('synced', poseFusion.usingGnssHeading === true ? 'true' : 'false');
          }

          // Update Motors
          const motors = primitives.primitives.motors ?? {};
          const motorStatusDot = document.getElementById('motor-status');
          motorStatusDot.className = 'status-dot ' + (motors.status || 'idle');

          if (motors.status === 'error') {
            document.getElementById('motor-error').textContent = motors.error;
            document.getElementById('motor-error').style.display = 'block';
          } else {
            document.getElementById('motor-error').style.display = 'none';
          }

          document.getElementById('motor-left').textContent = motors.leftWheelSpeedMetersPerSecond !== null
            ? formatMeters(motors.leftWheelSpeedMetersPerSecond).replace(' m', ' m/s')
            : '—';
          document.getElementById('motor-right').textContent = motors.rightWheelSpeedMetersPerSecond !== null
            ? formatMeters(motors.rightWheelSpeedMetersPerSecond).replace(' m', ' m/s')
            : '—';

          // Update VU meters with peak tracking
          const now = Date.now();

          // Left motor current
          if (now - leftPeakTimestamp > PEAK_HOLD_TIME_MS) {
            leftMotorPeakAmps = 0;
          }
          leftMotorPeakAmps = updateVUMeter(
            motors.leftMotorCurrentAmps,
            leftMotorPeakAmps,
            'motor-left-vu-bar',
            'motor-left-vu-peak',
            'motor-left-current',
            'motor-left-peak'
          );
          if (motors.leftMotorCurrentAmps !== null && motors.leftMotorCurrentAmps > leftMotorPeakAmps - 0.01) {
            leftPeakTimestamp = now;
          }

          // Right motor current
          if (now - rightPeakTimestamp > PEAK_HOLD_TIME_MS) {
            rightMotorPeakAmps = 0;
          }
          rightMotorPeakAmps = updateVUMeter(
            motors.rightMotorCurrentAmps,
            rightMotorPeakAmps,
            'motor-right-vu-bar',
            'motor-right-vu-peak',
            'motor-right-current',
            'motor-right-peak'
          );
          if (motors.rightMotorCurrentAmps !== null && motors.rightMotorCurrentAmps > rightMotorPeakAmps - 0.01) {
            rightPeakTimestamp = now;
          }

          document.getElementById('motor-left-pwm').textContent = motors.leftPwmAppliedPercent !== null
            ? motors.leftPwmAppliedPercent.toFixed(1) + '%'
            : '—';
          document.getElementById('motor-right-pwm').textContent = motors.rightPwmAppliedPercent !== null
            ? motors.rightPwmAppliedPercent.toFixed(1) + '%'
            : '—';
          document.getElementById('motor-watchdog').textContent = motors.watchdogHealthy !== null
            ? (motors.watchdogHealthy ? '✓' : '✗')
            : '—';
          document.getElementById('motor-faults').textContent = motors.faultFlags !== null
            ? '0x' + motors.faultFlags.toString(16).toUpperCase()
            : '—';

          // Update timelines
          addTimelinePoint(
            imu.status !== 'error' ? imu.headingDeg : null,
            gnss.status !== 'error' ? gnss.headingDeg : null,
            gnss.status !== 'error' ? gnss.headingAccuracyDeg : null,
            gnss.status !== 'error' ? gnss.positionAccuracyMeters : null
          );
          drawHeadingTimeline();
          drawPosAccTimeline();

          // Update footer
          const serverStatusDot = document.getElementById('server-status');
          serverStatusDot.className = 'status-dot ' + (health.state === 'running' ? 'running' : 'idle');
          document.getElementById('server-state').textContent = 'Server: ' + (health.state || 'unknown');
          document.getElementById('last-update').textContent = 'Last updated: ' + new Date().toLocaleTimeString();

        } catch (error) {
          console.error('Failed to update dashboard:', error);
        }
      }

      // Initial update and refresh every second
      updateDashboard();
      setInterval(updateDashboard, 1000);
    </script>
  </body>
</html>`;
}
