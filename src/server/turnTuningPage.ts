/**
 * Turn tuning web page - modern, responsive UI for turn controller
 */

export function getTurnTuningPageHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Turn Tuning - Mower Control</title>
  <style>
    :root {
      --primary-color: #2563eb;
      --primary-hover: #1d4ed8;
      --success-color: #10b981;
      --danger-color: #ef4444;
      --danger-hover: #dc2626;
      --warning-color: #f59e0b;
      --bg-primary: #ffffff;
      --bg-secondary: #f9fafb;
      --bg-tertiary: #f3f4f6;
      --text-primary: #111827;
      --text-secondary: #6b7280;
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
      flex-wrap: wrap;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .back-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 0.5rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      text-decoration: none;
      font-size: 1.25rem;
      transition: all 0.2s;
    }

    .back-button:hover {
      background: var(--bg-tertiary);
      border-color: var(--primary-color);
      transform: translateX(-2px);
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .status-badge.running {
      background: #dbeafe;
      color: var(--primary-color);
    }

    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: currentColor;
    }

    .controls-panel {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: var(--shadow-md);
    }

    .controls-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      align-items: end;
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    input[type="number"] {
      padding: 0.625rem 0.875rem;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      font-size: 1rem;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: all 0.2s;
    }

    input[type="number"]:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    .button-group {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    button {
      padding: 0.625rem 1.25rem;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      white-space: nowrap;
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--primary-color);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--primary-hover);
      box-shadow: var(--shadow-md);
    }

    .btn-danger {
      background: var(--danger-color);
      color: white;
      font-weight: 600;
    }

    .btn-danger:hover:not(:disabled) {
      background: var(--danger-hover);
      box-shadow: var(--shadow-md);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--border-color);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .stat-value.good {
      color: var(--success-color);
    }

    .stat-value.warning {
      color: var(--warning-color);
    }

    .results-section {
      background: var(--bg-primary);
      border-radius: 0.75rem;
      padding: 1.5rem;
      box-shadow: var(--shadow-md);
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
      gap: 1rem;
      flex-wrap: wrap;
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .table-container {
      overflow-x: auto;
      border-radius: 0.5rem;
      border: 1px solid var(--border-color);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }

    thead {
      background: var(--bg-tertiary);
    }

    th {
      padding: 0.75rem 1rem;
      text-align: left;
      font-weight: 600;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
    }

    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-color);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: var(--bg-secondary);
    }

    .angle-cell {
      font-weight: 600;
      color: var(--text-primary);
    }

    .error-cell {
      font-weight: 500;
    }

    .error-good {
      color: var(--success-color);
    }

    .error-warning {
      color: var(--warning-color);
    }

    .error-bad {
      color: var(--danger-color);
    }

    .status-cell {
      display: inline-block;
      padding: 0.25rem 0.625rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .status-success {
      background: #d1fae5;
      color: #065f46;
    }

    .status-timeout {
      background: #fed7aa;
      color: #92400e;
    }

    .status-stopped {
      background: #fee2e2;
      color: #991b1b;
    }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    /* Mobile responsiveness */
    @media (max-width: 768px) {
      h1 {
        font-size: 1.25rem;
      }

      .controls-grid {
        grid-template-columns: 1fr;
      }

      .button-group {
        flex-direction: column;
      }

      button {
        width: 100%;
        justify-content: center;
      }

      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .stat-value {
        font-size: 1.5rem;
      }

      .header-content {
        flex-direction: column;
        align-items: flex-start;
      }

      table {
        font-size: 0.8125rem;
      }

      th, td {
        padding: 0.5rem 0.75rem;
      }
    }

    @media (max-width: 480px) {
      .stats-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Loading spinner */
    .spinner {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="header-left">
        <a href="/" class="back-button" title="Back to Dashboard">←</a>
        <h1>🔄 Turn Tuning</h1>
      </div>
      <div class="status-badge" id="controllerStatus">
        <span class="status-dot"></span>
        <span>Idle</span>
      </div>
    </div>
  </div>

  <div class="container">
    <!-- Controls Panel -->
    <div class="controls-panel">
      <div class="controls-grid">
        <div class="control-group">
          <label for="testAngle">Test Angle (degrees)</label>
          <input type="number" id="testAngle" min="-180" max="180" step="10" value="90">
        </div>

        <div class="control-group">
          <label for="iterations">Tuning Iterations</label>
          <input type="number" id="iterations" min="1" max="10" step="1" value="1">
        </div>

        <div class="control-group">
          <label>&nbsp;</label>
          <div class="button-group">
            <button class="btn-primary" id="runSingleTurn">Run Single Turn</button>
            <button class="btn-primary" id="runTuningSequence">Run Full Tuning</button>
          </div>
        </div>

        <div class="control-group">
          <label>&nbsp;</label>
          <div class="button-group">
            <button class="btn-danger" id="stopTurn">⏹ STOP</button>
            <button class="btn-secondary" id="clearHistory">Clear History</button>
            <button class="btn-secondary" id="resetLearning">Reset Learning</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Statistics -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Turns Completed</div>
        <div class="stat-value" id="turnsCompleted">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Average Error</div>
        <div class="stat-value" id="averageError">0.0°</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Error</div>
        <div class="stat-value" id="lastError">—</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Controller Status</div>
        <div class="stat-value" id="statusText">Idle</div>
      </div>
    </div>

    <!-- Results Table -->
    <div class="results-section">
      <div class="section-header">
        <h2>Turn Results</h2>
        <span style="font-size: 0.875rem; color: var(--text-secondary);" id="resultsCount">0 turns</span>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Requested</th>
              <th>Achieved</th>
              <th>Error</th>
              <th>Duration</th>
              <th>Brake Angle</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="resultsTableBody">
            <tr>
              <td colspan="7">
                <div class="empty-state">
                  <div class="empty-icon">📊</div>
                  <div>No turn results yet. Run a turn to see results here.</div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let updateInterval = null;

    // Format time
    function formatTime(isoString) {
      const date = new Date(isoString);
      return date.toLocaleTimeString();
    }

    // Format angle
    function formatAngle(deg) {
      return deg >= 0 ? \`+\${deg.toFixed(1)}°\` : \`\${deg.toFixed(1)}°\`;
    }

    // Get error class
    function getErrorClass(errorDeg) {
      const abs = Math.abs(errorDeg);
      if (abs <= 2) return 'error-good';
      if (abs <= 5) return 'error-warning';
      return 'error-bad';
    }

    // Update UI with status data
    async function updateStatus() {
      try {
        const response = await fetch('/api/turn/status');
        const data = await response.json();

        // Update controller status badge
        const statusBadge = document.getElementById('controllerStatus');
        const statusSpan = statusBadge.querySelector('span:last-child');
        statusSpan.textContent = data.state.status.charAt(0).toUpperCase() + data.state.status.slice(1);
        statusBadge.className = 'status-badge';
        if (data.state.status !== 'idle') {
          statusBadge.classList.add('running');
        }

        // Update stats
        document.getElementById('turnsCompleted').textContent = data.state.turnsCompleted;
        document.getElementById('statusText').textContent = data.state.status.charAt(0).toUpperCase() + data.state.status.slice(1);

        const avgError = data.state.averageErrorDeg;
        const avgErrorEl = document.getElementById('averageError');
        avgErrorEl.textContent = \`\${avgError.toFixed(2)}°\`;
        avgErrorEl.className = 'stat-value ' + (avgError <= 2 ? 'good' : avgError <= 5 ? 'warning' : '');

        // Update last error
        if (data.history && data.history.length > 0) {
          const lastResult = data.history[data.history.length - 1];
          const lastErrorDeg = lastResult.errorAngle;
          const lastErrorEl = document.getElementById('lastError');
          lastErrorEl.textContent = formatAngle(lastErrorDeg);
          lastErrorEl.className = 'stat-value ' + getErrorClass(lastErrorDeg);
        }

        // Update results table
        const tbody = document.getElementById('resultsTableBody');
        const resultsCount = document.getElementById('resultsCount');

        if (data.history && data.history.length > 0) {
          resultsCount.textContent = \`\${data.history.length} turn\${data.history.length !== 1 ? 's' : ''}\`;

          tbody.innerHTML = data.history.slice().reverse().slice(0, 50).map(result => \`
            <tr>
              <td>\${formatTime(result.timestamp)}</td>
              <td class="angle-cell">\${formatAngle(result.requestedAngle)}</td>
              <td class="angle-cell">\${formatAngle(result.achievedAngle)}</td>
              <td class="error-cell \${getErrorClass(result.errorAngle)}">\${formatAngle(result.errorAngle)}</td>
              <td>\${result.durationMs}ms</td>
              <td>\${formatAngle(result.brakeAngleUsed)}</td>
              <td><span class="status-cell status-\${result.status}">\${result.status}</span></td>
            </tr>
          \`).join('');
        } else {
          resultsCount.textContent = '0 turns';
          tbody.innerHTML = \`
            <tr>
              <td colspan="7">
                <div class="empty-state">
                  <div class="empty-icon">📊</div>
                  <div>No turn results yet. Run a turn to see results here.</div>
                </div>
              </td>
            </tr>
          \`;
        }
      } catch (error) {
        console.error('Failed to update status:', error);
      }
    }

    // Run single turn
    document.getElementById('runSingleTurn').addEventListener('click', async () => {
      const angle = parseFloat(document.getElementById('testAngle').value);
      const button = document.getElementById('runSingleTurn');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Running...';

      try {
        await fetch('/api/turn/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ angleDeg: angle, enableLearning: true })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to execute turn: ' + error.message);
      } finally {
        button.disabled = false;
        button.innerHTML = 'Run Single Turn';
      }
    });

    // Run tuning sequence
    document.getElementById('runTuningSequence').addEventListener('click', async () => {
      const iterations = parseInt(document.getElementById('iterations').value);
      const button = document.getElementById('runTuningSequence');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Running Tuning...';

      try {
        await fetch('/api/turn/tune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iterations })
        });
        await updateStatus();
      } catch (error) {
        alert('Failed to run tuning: ' + error.message);
      } finally {
        button.disabled = false;
        button.innerHTML = 'Run Full Tuning';
      }
    });

    // Stop turn
    document.getElementById('stopTurn').addEventListener('click', async () => {
      try {
        await fetch('/api/turn/stop', { method: 'POST' });
        await updateStatus();
      } catch (error) {
        alert('Failed to stop turn: ' + error.message);
      }
    });

    // Clear history
    document.getElementById('clearHistory').addEventListener('click', async () => {
      if (confirm('Clear all turn history?')) {
        try {
          await fetch('/api/turn/clear-history', { method: 'POST' });
          await updateStatus();
        } catch (error) {
          alert('Failed to clear history: ' + error.message);
        }
      }
    });

    // Reset learning
    document.getElementById('resetLearning').addEventListener('click', async () => {
      if (confirm('Reset all learned parameters to defaults?')) {
        try {
          await fetch('/api/turn/reset-learning', { method: 'POST' });
          await updateStatus();
        } catch (error) {
          alert('Failed to reset learning: ' + error.message);
        }
      }
    });

    // Initial update and start polling
    updateStatus();
    updateInterval = setInterval(updateStatus, 1000);

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      if (updateInterval) {
        clearInterval(updateInterval);
      }
    });
  </script>
</body>
</html>
  `;
}
