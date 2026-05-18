export function renderHomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mower Control Dashboard</title>
    <style>
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

      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 2rem 1.5rem;
        flex: 1;
      }

      .action-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 1.5rem;
        margin-bottom: 2rem;
      }

      .action-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.5rem;
        box-shadow: var(--shadow-sm);
        transition: all 0.2s;
        cursor: pointer;
        text-decoration: none;
        color: inherit;
        display: block;
      }

      .action-card:hover {
        box-shadow: var(--shadow-md);
        transform: translateY(-2px);
        border-color: var(--primary-color);
      }

      .action-card-icon {
        width: 48px;
        height: 48px;
        background: linear-gradient(135deg, var(--primary-color), var(--primary-hover));
        border-radius: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
        margin-bottom: 1rem;
      }

      .action-card-title {
        font-size: 1.125rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
      }

      .action-card-description {
        color: var(--text-secondary);
        font-size: 0.875rem;
      }

      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 1.5rem;
        margin-bottom: 2rem;
      }

      .sensor-card {
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 0.75rem;
        padding: 1.5rem;
        box-shadow: var(--shadow-sm);
      }

      .sensor-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
        padding-bottom: 1rem;
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
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }

      .metric-value.large {
        font-size: 2rem;
      }

      .metric-unit {
        font-size: 0.875rem;
        color: var(--text-secondary);
        font-weight: 400;
      }

      .compass {
        width: 120px;
        height: 120px;
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

      .position-display {
        text-align: center;
        padding: 1rem;
        background: var(--bg-tertiary);
        border-radius: 0.5rem;
        margin-top: 1rem;
      }

      .coordinates {
        display: flex;
        justify-content: center;
        gap: 2rem;
        margin-top: 0.5rem;
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

      @media (max-width: 768px) {
        .action-cards {
          grid-template-columns: 1fr;
        }

        .dashboard-grid {
          grid-template-columns: 1fr;
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
  </head>
  <body>
    <div class="header">
      <div class="header-content">
        <h1>🚜 Mower Control Dashboard</h1>
        <div class="subtitle">Autonomous Lawn Mower Control System</div>
      </div>
    </div>

    <div class="container">
      <!-- Action Cards -->
      <div class="action-cards">
        <a href="/turn-tuning" class="action-card">
          <div class="action-card-icon">🔄</div>
          <div class="action-card-title">Turn Tuning</div>
          <div class="action-card-description">
            Configure and test autonomous turning with self-learning brake points
          </div>
        </a>

        <a href="/drive-tuning" class="action-card">
          <div class="action-card-icon">🎯</div>
          <div class="action-card-title">Drive Tuning</div>
          <div class="action-card-description">
            Test point-to-point navigation with CTE correction and waypoint patterns
          </div>
        </a>
      </div>

      <!-- Sensor Dashboard -->
      <div class="dashboard-grid">
        <!-- IMU Card -->
        <div class="sensor-card">
          <div class="sensor-header">
            <div class="sensor-title">IMU Sensor</div>
            <span class="status-dot" id="imu-status"></span>
          </div>
          <div class="compass" id="compass">
            <div class="compass-circle">
              <div class="compass-label n">N</div>
              <div class="compass-label e">E</div>
              <div class="compass-label s">S</div>
              <div class="compass-label w">W</div>
              <div class="compass-needle"></div>
              <div class="compass-center"></div>
            </div>
          </div>
          <div class="position-display">
            <div class="metric-label">Heading</div>
            <div class="metric-value large" id="imu-heading">—</div>
          </div>
          <div id="imu-error" class="error-message" style="display: none;"></div>
        </div>

        <!-- GNSS Card -->
        <div class="sensor-card">
          <div class="sensor-header">
            <div class="sensor-title">GNSS Position</div>
            <span class="status-dot" id="gnss-status"></span>
          </div>
          <div class="coordinates">
            <div class="coordinate">
              <div class="coordinate-label">X</div>
              <div class="coordinate-value" id="gnss-x">—</div>
            </div>
            <div class="coordinate">
              <div class="coordinate-label">Y</div>
              <div class="coordinate-value" id="gnss-y">—</div>
            </div>
          </div>
          <div class="metric-grid" style="margin-top: 1rem;">
            <div class="metric">
              <div class="metric-label">Fix Type</div>
              <div class="metric-value" style="font-size: 1rem;" id="gnss-fix">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Accuracy</div>
              <div class="metric-value" style="font-size: 1rem;" id="gnss-accuracy">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Satellites</div>
              <div class="metric-value" style="font-size: 1rem;" id="gnss-sats">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Heading</div>
              <div class="metric-value" style="font-size: 1rem;" id="gnss-heading">—</div>
            </div>
          </div>
          <div id="gnss-error" class="error-message" style="display: none;"></div>
        </div>

        <!-- Motors Card -->
        <div class="sensor-card">
          <div class="sensor-header">
            <div class="sensor-title">Motor Status</div>
            <span class="status-dot" id="motor-status"></span>
          </div>
          <div class="metric-grid">
            <div class="metric">
              <div class="metric-label">Left Speed</div>
              <div class="metric-value" id="motor-left">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Right Speed</div>
              <div class="metric-value" id="motor-right">—</div>
            </div>
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
      function formatMeters(value) {
        if (value === null || value === undefined) return '—';
        return value.toFixed(3) + ' m';
      }

      function formatDegrees(value) {
        if (value === null || value === undefined) return '—';
        return value.toFixed(1) + '°';
      }

      async function updateDashboard() {
        try {
          const [primitives, health] = await Promise.all([
            fetch('/api/primitives').then(r => r.json()),
            fetch('/health').then(r => r.json())
          ]);

          // Update IMU
          const imu = primitives.primitives.imu;
          const imuStatusDot = document.getElementById('imu-status');
          imuStatusDot.className = 'status-dot ' + (imu.status || 'idle');

          if (imu.status === 'error') {
            document.getElementById('imu-error').textContent = imu.error;
            document.getElementById('imu-error').style.display = 'block';
            document.getElementById('imu-heading').textContent = '—';
          } else {
            document.getElementById('imu-error').style.display = 'none';
            if (imu.headingDeg !== null) {
              document.getElementById('imu-heading').textContent = formatDegrees(imu.headingDeg);
              // Update compass needle
              const compass = document.getElementById('compass');
              compass.style.setProperty('--heading-deg', imu.headingDeg + 'deg');
            } else {
              document.getElementById('imu-heading').textContent = '—';
            }
          }

          // Update GNSS
          const gnss = primitives.primitives.gnss;
          const gnssStatusDot = document.getElementById('gnss-status');
          gnssStatusDot.className = 'status-dot ' + (gnss.status || 'idle');

          if (gnss.status === 'error') {
            document.getElementById('gnss-error').textContent = gnss.error;
            document.getElementById('gnss-error').style.display = 'block';
          } else {
            document.getElementById('gnss-error').style.display = 'none';
          }

          document.getElementById('gnss-x').textContent = formatMeters(gnss.xMeters);
          document.getElementById('gnss-y').textContent = formatMeters(gnss.yMeters);
          document.getElementById('gnss-fix').textContent = gnss.fixType || '—';
          document.getElementById('gnss-accuracy').textContent = gnss.positionAccuracyMeters !== null
            ? formatMeters(gnss.positionAccuracyMeters)
            : '—';
          document.getElementById('gnss-sats').textContent = gnss.satellitesInUse !== null
            ? gnss.satellitesInUse
            : '—';
          document.getElementById('gnss-heading').textContent = formatDegrees(gnss.headingDeg);

          // Update Motors
          const motors = primitives.primitives.motors;
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
