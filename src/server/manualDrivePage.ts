/**
 * Manual Drive dashboard - live controller view with position map
 */

export function getManualDrivePageHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Manual Drive - Mower Control</title>
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
      --border-color: #e5e7eb;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
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
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 1rem;
    }

    .header {
      background: var(--bg-primary);
      border-bottom: 1px solid var(--border-color);
      padding: 1rem 0;
      box-shadow: var(--shadow-sm);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-content {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .header-left {
      flex: 1;
    }

    .back-link {
      color: var(--primary-color);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.875rem;
      transition: all 0.2s;
    }

    .back-link:hover {
      color: var(--primary-hover);
      text-decoration: underline;
    }

    h1 {
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .subtitle {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .map-section {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: var(--shadow-md);
    }

    .section-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1rem;
    }

    #mapCanvas {
      width: 100%;
      height: 400px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      display: block;
    }

    .map-stats {
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: 'SFMono-Regular', Consolas, monospace;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .stat-card {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: var(--shadow-sm);
    }

    .stat-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 0.5rem;
    }

    .stat-detail {
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.625rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .status-ok {
      background: #d1fae5;
      color: #065f46;
    }

    .status-warning {
      background: #fed7aa;
      color: #92400e;
    }

    .status-danger {
      background: #fee2e2;
      color: #991b1b;
    }

    .details-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
    }

    .detail-card {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: var(--shadow-sm);
    }

    .detail-row {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
      margin-top: 0.75rem;
    }

    .detail-item {
      padding: 0.75rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
    }

    .detail-item-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .detail-item-value {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    @media (max-width: 768px) {
      h1 {
        font-size: 1.25rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .detail-row {
        grid-template-columns: 1fr;
      }

      #mapCanvas {
        height: 300px;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="header-left">
        <h1>🎮 Manual Drive</h1>
        <p class="subtitle">Controller-driven live view with position tracking</p>
      </div>
      <a href="/" class="back-link">← Back to Dashboard</a>
    </div>
  </div>

  <div class="container">
    <!-- Position Map -->
    <div class="map-section">
      <div class="section-title">Position Map (Last 10 Minutes)</div>
      <canvas id="mapCanvas" width="1200" height="800"></canvas>
      <div class="map-stats" id="mapStats">Waiting for position data...</div>
    </div>

    <!-- Primary Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Controller</div>
        <div class="stat-value" id="controllerStatus">Waiting...</div>
        <div class="stat-detail" id="controllerDetail">No controller state yet</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Command</div>
        <div class="stat-value" id="commandStatus">Stopped</div>
        <div class="stat-detail" id="commandDetail">No wheel command yet</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Position Estimate</div>
        <div class="stat-value" id="estimateStatus">Waiting...</div>
        <div class="stat-detail" id="estimateDetail">No fused estimate yet</div>
      </div>
    </div>

    <!-- Controller Details -->
    <div class="details-grid">
      <div class="detail-card">
        <div class="stat-label">Controller Demand</div>
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-item-label">Angle</div>
            <div class="detail-item-value" id="controllerAngle">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Speed</div>
            <div class="detail-item-value" id="controllerSpeed">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Left Target</div>
            <div class="detail-item-value" id="leftTarget">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Right Target</div>
            <div class="detail-item-value" id="rightTarget">—</div>
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="stat-label">Motion Feedback</div>
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-item-label">Left Actual</div>
            <div class="detail-item-value" id="leftActual">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Right Actual</div>
            <div class="detail-item-value" id="rightActual">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Vehicle Speed</div>
            <div class="detail-item-value" id="vehicleSpeed">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Turn Bias</div>
            <div class="detail-item-value" id="turnBias">—</div>
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="stat-label">GNSS</div>
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-item-label">Fix Type</div>
            <div class="detail-item-value" id="gnssFix">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Heading</div>
            <div class="detail-item-value" id="gnssHeading">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Speed</div>
            <div class="detail-item-value" id="gnssSpeed">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Sample Age</div>
            <div class="detail-item-value" id="gnssAge">—</div>
          </div>
        </div>
      </div>

      <div class="detail-card">
        <div class="stat-label">IMU</div>
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-item-label">Roll</div>
            <div class="detail-item-value" id="imuRoll">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Pitch</div>
            <div class="detail-item-value" id="imuPitch">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Gyro Z</div>
            <div class="detail-item-value" id="imuGyroZ">—</div>
          </div>
          <div class="detail-item">
            <div class="detail-item-label">Gravity</div>
            <div class="detail-item-value" id="imuGravity">—</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    function format(value, decimals = 2) {
      return Number(value).toFixed(decimals);
    }

    // Position history tracking
    const positionHistory = [];
    const MAX_HISTORY_MS = 10 * 60 * 1000; // 10 minutes
    const canvas = $("mapCanvas");
    const ctx = canvas.getContext("2d");

    function addPositionToHistory(x, y, heading, timestamp) {
      positionHistory.push({ x, y, heading, timestamp });

      // Remove old points beyond 10 minutes
      const cutoff = timestamp - MAX_HISTORY_MS;
      while (positionHistory.length > 0 && positionHistory[0].timestamp < cutoff) {
        positionHistory.shift();
      }
    }

    function drawMap() {
      if (positionHistory.length === 0) {
        return;
      }

      const width = canvas.width;
      const height = canvas.height;
      const padding = 60;

      // Clear canvas
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, 0, width, height);

      // Find bounds
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (const pos of positionHistory) {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
      }

      // Add padding to bounds
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      minX -= rangeX * 0.1;
      maxX += rangeX * 0.1;
      minY -= rangeY * 0.1;
      maxY += rangeY * 0.1;

      // Calculate scale to fit canvas
      const scaleX = (width - 2 * padding) / (maxX - minX);
      const scaleY = (height - 2 * padding) / (maxY - minY);
      const scale = Math.min(scaleX, scaleY);

      // Transform functions
      const toCanvasX = (x) => padding + (x - minX) * scale;
      const toCanvasY = (y) => height - padding - (y - minY) * scale;

      // Draw grid
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 1;
      const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(rangeX, rangeY) / 5)));

      for (let x = Math.floor(minX / gridSize) * gridSize; x <= maxX; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(toCanvasX(x), padding);
        ctx.lineTo(toCanvasX(x), height - padding);
        ctx.stroke();
      }
      for (let y = Math.floor(minY / gridSize) * gridSize; y <= maxY; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(padding, toCanvasY(y));
        ctx.lineTo(width - padding, toCanvasY(y));
        ctx.stroke();
      }

      // Draw axes labels
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("X (meters)", width / 2, height - 10);
      ctx.save();
      ctx.translate(15, height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("Y (meters)", 0, 0);
      ctx.restore();

      // Draw trail with fading
      const now = positionHistory[positionHistory.length - 1].timestamp;
      ctx.lineWidth = 3;

      for (let i = 1; i < positionHistory.length; i++) {
        const prev = positionHistory[i - 1];
        const curr = positionHistory[i];
        const age = now - curr.timestamp;
        const opacity = 1 - (age / MAX_HISTORY_MS);

        ctx.strokeStyle = \`rgba(37, 99, 235, \${opacity * 0.6})\`;
        ctx.beginPath();
        ctx.moveTo(toCanvasX(prev.x), toCanvasY(prev.y));
        ctx.lineTo(toCanvasX(curr.x), toCanvasY(curr.y));
        ctx.stroke();
      }

      // Draw current position as arrow
      const current = positionHistory[positionHistory.length - 1];
      const cx = toCanvasX(current.x);
      const cy = toCanvasY(current.y);
      const headingRad = (current.heading * Math.PI) / 180;
      const arrowSize = 20;

      ctx.fillStyle = "#2563eb";
      ctx.strokeStyle = "#1e3a8a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(headingRad) * arrowSize,
        cy - Math.sin(headingRad) * arrowSize
      );
      ctx.lineTo(
        cx + Math.cos(headingRad + 2.6) * arrowSize * 0.6,
        cy - Math.sin(headingRad + 2.6) * arrowSize * 0.6
      );
      ctx.lineTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(headingRad - 2.6) * arrowSize * 0.6,
        cy - Math.sin(headingRad - 2.6) * arrowSize * 0.6
      );
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Update stats
      const distance = Math.max(rangeX, rangeY);
      $("mapStats").textContent = \`\${positionHistory.length} points | range: \${format(distance, 2)}m | scale: \${format(1/scale, 3)}m/px | current: (\${format(current.x, 2)}, \${format(current.y, 2)})\`;
    }

    async function updateStatus() {
      try {
        const response = await fetch('/api/primitives');
        const data = await response.json();
        const primitives = data.primitives;

        // Controller status
        if (primitives.hidController) {
          const connected = primitives.hidController.connected;
          const armed = primitives.hidController.manualDriveEnabled;
          $("controllerStatus").innerHTML = connected
            ? (armed ? '<span class="status-badge status-warning">Armed</span>' : '<span class="status-badge status-ok">Connected</span>')
            : '<span class="status-badge status-danger">Disconnected</span>';
          $("controllerDetail").textContent = connected
            ? \`\${primitives.hidController.product || 'Unknown'}\`
            : 'No controller detected';

          $("controllerAngle").textContent = \`\${format(primitives.hidController.angleDegrees || 0, 1)}°\`;
          $("controllerSpeed").textContent = format(primitives.hidController.speed || 0, 2);
        }

        // Command status
        if (primitives.manualDriveCoordinator) {
          const mode = primitives.manualDriveCoordinator.mode;
          $("commandStatus").innerHTML = mode === 'stopped'
            ? '<span class="status-badge status-danger">Stopped</span>'
            : '<span class="status-badge status-warning">Driving</span>';
          $("commandDetail").textContent = \`L: \${format(primitives.manualDriveCoordinator.limitedLeftMetersPerSecond || 0, 3)} | R: \${format(primitives.manualDriveCoordinator.limitedRightMetersPerSecond || 0, 3)} m/s\`;

          $("leftTarget").textContent = \`\${format(primitives.manualDriveCoordinator.limitedLeftMetersPerSecond || 0, 3)} m/s\`;
          $("rightTarget").textContent = \`\${format(primitives.manualDriveCoordinator.limitedRightMetersPerSecond || 0, 3)} m/s\`;
        }

        // Position estimate
        if (primitives.poseFusion && primitives.poseFusion.status === 'ok') {
          const pose = primitives.poseFusion;
          $("estimateStatus").innerHTML = '<span class="status-badge status-ok">Active</span>';
          $("estimateDetail").textContent = \`Heading: \${format(pose.headingDeg, 1)}° | Speed: \${format(pose.speedMetersPerSecond, 3)} m/s\`;

          // Add to map
          if (pose.xMeters != null && pose.yMeters != null) {
            addPositionToHistory(
              pose.xMeters,
              pose.yMeters,
              pose.headingDeg,
              Date.now()
            );
            drawMap();
          }
        } else {
          $("estimateStatus").innerHTML = '<span class="status-badge status-danger">Unavailable</span>';
          $("estimateDetail").textContent = primitives.poseFusion?.error || 'No data';
        }

        // Motors
        if (primitives.motors && primitives.motors.status === 'ok') {
          $("leftActual").textContent = \`\${format(primitives.motors.leftWheelSpeedMetersPerSecond || 0, 3)} m/s\`;
          $("rightActual").textContent = \`\${format(primitives.motors.rightWheelSpeedMetersPerSecond || 0, 3)} m/s\`;
          const avgSpeed = ((primitives.motors.leftWheelSpeedMetersPerSecond || 0) + (primitives.motors.rightWheelSpeedMetersPerSecond || 0)) / 2;
          $("vehicleSpeed").textContent = \`\${format(avgSpeed, 3)} m/s\`;
          const turnBias = (primitives.motors.rightWheelSpeedMetersPerSecond || 0) - (primitives.motors.leftWheelSpeedMetersPerSecond || 0);
          $("turnBias").textContent = \`\${format(turnBias, 3)} m/s\`;
        }

        // GNSS
        if (primitives.gnss && primitives.gnss.status === 'ok') {
          $("gnssFix").textContent = primitives.gnss.fixType || '—';
          $("gnssHeading").textContent = primitives.gnss.headingDeg != null ? \`\${format(primitives.gnss.headingDeg, 1)}°\` : '—';
          $("gnssSpeed").textContent = '—'; // Speed not in primitives
          $("gnssAge").textContent = \`\${primitives.gnss.sampleAgeMillis || 0}ms\`;
        }

        // IMU
        if (primitives.imu && primitives.imu.status === 'ok') {
          $("imuRoll").textContent = primitives.imu.rollDeg != null ? \`\${format(primitives.imu.rollDeg, 1)}°\` : '—';
          $("imuPitch").textContent = primitives.imu.pitchDeg != null ? \`\${format(primitives.imu.pitchDeg, 1)}°\` : '—';
          $("imuGyroZ").textContent = '—'; // Gyro not in primitives
          $("imuGravity").textContent = '—'; // Gravity not in primitives
        }

      } catch (error) {
        console.error('Failed to update status:', error);
      }
    }

    // Poll for updates
    setInterval(updateStatus, 500);
    updateStatus();
  </script>
</body>
</html>
  `;
}
