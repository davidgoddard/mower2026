/**
 * Autonomous mower sensor web components.
 *
 * Registers two custom elements:
 *   <imu-sensor-widget>   — IMU heading, pitch, roll, status
 *   <gnss-position-widget> — GNSS heading, position, fix, satellites, accuracy, status
 *
 * Each component owns its DOM and CSS inside a Shadow DOM, so page styles
 * cannot reach inside and alter the widget appearance.  CSS custom properties
 * defined on :root DO pierce the shadow boundary, so the shared colour
 * palette (--primary-color, --bg-primary, etc.) still applies.
 *
 * Attributes (all optional, updated by setAttribute):
 *
 *   imu-sensor-widget:
 *     status          — "running" | "error" | "idle"
 *     error           — error message string (shown when status="error")
 *     heading-deg     — internal heading (0=east, CCW+), converted to nav convention for display
 *     pitch-deg       — tilt front-to-back in degrees
 *     roll-deg        — tilt side-to-side in degrees
 *     synced          — "" | "true" — highlights card green when GNSS is rebasing IMU
 *
 *   gnss-position-widget:
 *     status          — "running" | "error" | "idle"
 *     error           — error message string
 *     heading-deg     — internal heading for compass/display
 *     heading-accuracy-deg  — heading accuracy in degrees
 *     x-meters        — X position
 *     y-meters        — Y position
 *     position-accuracy-meters — position accuracy
 *     fix-type        — "fixed" | "float" | "rtk-fixed" | "rtk-float" | "single" | "none"
 *     satellites      — satellite count
 *     synced          — "" | "true" — highlights card green when GNSS is rebasing IMU
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function internalToNavHeading(deg) {
  return (90 - deg + 360) % 360;
}

function fmtMeters(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(3) + ' m';
}

function fmtDegrees(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(1) + '°';
}

function gnssFixClass(fixType) {
  switch ((fixType || 'unknown').toLowerCase()) {
    case 'fixed':     return 'gnss-fix-fixed';
    case 'rtk-fixed': return 'gnss-fix-rtk-fixed';
    case 'float':     return 'gnss-fix-float';
    case 'rtk-float': return 'gnss-fix-rtk-float';
    case 'single':    return 'gnss-fix-single';
    case 'none':      return 'gnss-fix-none';
    default:          return 'gnss-fix-unknown';
  }
}

// ---------------------------------------------------------------------------
// Shared shadow CSS — injected into each component's shadow root
// ---------------------------------------------------------------------------

const SHARED_CSS = `
  :host {
    display: block;
  }

  /* Colour tokens — fall back to sensible defaults if the page doesn't set them */
  :host {
    --_bg-primary:    var(--bg-primary,    #ffffff);
    --_bg-secondary:  var(--bg-secondary,  #f9fafb);
    --_bg-tertiary:   var(--bg-tertiary,   #f3f4f6);
    --_text-primary:  var(--text-primary,  #111827);
    --_text-secondary:var(--text-secondary,#6b7280);
    --_border-color:  var(--border-color,  #e5e7eb);
    --_primary-color: var(--primary-color, #2563eb);
    --_danger-color:  var(--danger-color,  #ef4444);
    --_success-color: var(--success-color, #10b981);
    --_shadow-sm:     var(--shadow-sm, 0 1px 2px 0 rgba(0,0,0,0.05));
  }

  .card {
    background: var(--_bg-primary);
    border: 1px solid var(--_border-color);
    border-radius: 0.75rem;
    padding: 1.25rem;
    box-shadow: var(--_shadow-sm);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
  }

  :host([synced="true"]) .card {
    background: linear-gradient(180deg, rgba(34,197,94,0.14), rgba(16,185,129,0.06));
    border-color: rgba(34,197,94,0.42);
    box-shadow: 0 0 0 1px rgba(34,197,94,0.12), var(--_shadow-sm);
  }

  :host(:not([synced="true"])) .card {
    /* warning state only when synced attr is explicitly set to non-true */
  }

  :host([synced="false"]) .card {
    background: linear-gradient(180deg, rgba(249,115,22,0.16), rgba(245,158,11,0.08));
    border-color: rgba(249,115,22,0.42);
    box-shadow: 0 0 0 1px rgba(249,115,22,0.12), var(--_shadow-sm);
  }

  /* Header */
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.875rem;
    padding-bottom: 0.875rem;
    border-bottom: 1px solid var(--_border-color);
  }

  .card-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--_text-secondary);
  }

  /* Status dot */
  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    display: inline-block;
    background: var(--_text-secondary);
    flex-shrink: 0;
  }

  .status-dot.running {
    background: var(--_success-color);
    box-shadow: 0 0 0 3px rgba(16,185,129,0.2);
  }

  .status-dot.error {
    background: var(--_danger-color);
    box-shadow: 0 0 0 3px rgba(239,68,68,0.2);
  }

  /* Compass */
  .compass {
    width: 100px;
    height: 100px;
    flex-shrink: 0;
    position: relative;
  }

  .compass-circle {
    width: 100%;
    height: 100%;
    border: 3px solid var(--_border-color);
    border-radius: 50%;
    position: relative;
    background: radial-gradient(circle, var(--_bg-secondary) 0%, var(--_bg-primary) 70%);
  }

  .compass-needle {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 4px;
    height: 45%;
    background: linear-gradient(to top, var(--_danger-color), var(--_primary-color));
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
    background: var(--_text-primary);
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 3px var(--_bg-primary);
  }

  .compass-label {
    position: absolute;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--_text-secondary);
  }

  .compass-label.n { top: 8px;    left: 50%; transform: translateX(-50%); }
  .compass-label.e { right: 8px;  top:  50%; transform: translateY(-50%); }
  .compass-label.s { bottom: 8px; left: 50%; transform: translateX(-50%); }
  .compass-label.w { left: 8px;   top:  50%; transform: translateY(-50%); }

  /* Top row: compass + heading metric */
  .top-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 0.75rem;
  }

  .top-metrics {
    flex: 1;
    display: grid;
    gap: 0.75rem;
  }

  .top-metrics.one { grid-template-columns: minmax(0,1fr); }
  .top-metrics.two { grid-template-columns: repeat(2, minmax(0,1fr)); }

  /* Metric tile — glass card style */
  .metric {
    padding: 0.8rem 0.9rem;
    background: rgba(255,255,255,0.68);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(148,163,184,0.16);
    border-radius: 0.75rem;
    box-shadow: 0 1px 0 rgba(255,255,255,0.45) inset, 0 1px 2px rgba(15,23,42,0.05);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .metric-label {
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--_text-secondary);
    white-space: nowrap;
  }

  .metric-value {
    font-size: clamp(1.05rem, 1.1vw, 1.35rem);
    font-weight: 600;
    color: var(--_text-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .metric-value.large {
    font-size: clamp(1.35rem, 1.8vw, 1.8rem);
  }

  /* Tilt indicators */
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
    border: 3px solid var(--_border-color);
    border-radius: 50%;
    position: relative;
    background: radial-gradient(circle, var(--_bg-secondary) 0%, var(--_bg-primary) 70%);
  }

  .tilt-line {
    position: absolute;
    top: 50%;
    left: 10%;
    right: 10%;
    height: 3px;
    background: var(--_primary-color);
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
    background: var(--_text-primary);
    border-radius: 50%;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 0 2px var(--_bg-primary);
  }

  .tilt-label {
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--_text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .tilt-value {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--_text-primary);
  }

  /* GNSS section */
  .gnss-section {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    margin-top: 1rem;
  }

  .gnss-row {
    display: grid;
    gap: 0.75rem;
  }

  .gnss-row.two   { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .gnss-row.three { grid-template-columns: repeat(3, minmax(0,1fr)); }

  /* Fix type pill */
  .fix-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem 0.7rem;
    border-radius: 0.5rem;
    font-size: clamp(1.05rem, 1.1vw, 1.35rem);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    background: var(--_bg-tertiary);
    color: var(--_text-primary);
    width: 100%;
    box-sizing: border-box;
  }

  .fix-pill.gnss-fix-none,
  .fix-pill.gnss-fix-unknown { background: #fee2e2; color: #991b1b; }
  .fix-pill.gnss-fix-single  { background: #ffedd5; color: #9a3412; }
  .fix-pill.gnss-fix-float   { background: #fef3c7; color: #92400e; }
  .fix-pill.gnss-fix-rtk-float { background: #fef3c7; color: #92400e; }
  .fix-pill.gnss-fix-fixed   { background: #dcfce7; color: #166534; }
  .fix-pill.gnss-fix-rtk-fixed { background: #dcfce7; color: #166534; }

  /* Error message */
  .error-msg {
    background: #fef2f2;
    color: #991b1b;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    margin-top: 0.75rem;
    display: none;
  }
`;

// ---------------------------------------------------------------------------
// <imu-sensor-widget>
// ---------------------------------------------------------------------------

class ImuSensorWidget extends HTMLElement {
  static get observedAttributes() {
    return ['status', 'error', 'heading-deg', 'pitch-deg', 'roll-deg', 'synced'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${SHARED_CSS}</style>
      <div class="card">
        <div class="card-header">
          <span class="card-title">IMU Sensor</span>
          <span class="status-dot" part="status-dot"></span>
        </div>
        <div class="top-row">
          <div class="compass" part="compass">
            <div class="compass-circle">
              <span class="compass-label n">N</span>
              <span class="compass-label e">E</span>
              <span class="compass-label s">S</span>
              <span class="compass-label w">W</span>
              <div class="compass-needle"></div>
              <div class="compass-center"></div>
            </div>
          </div>
          <div class="top-metrics one">
            <div class="metric">
              <div class="metric-label">Heading</div>
              <div class="metric-value large" part="heading-value">—</div>
            </div>
          </div>
        </div>
        <div class="tilt-indicators">
          <div class="tilt-indicator">
            <div class="tilt-circle" part="pitch-indicator">
              <div class="tilt-line"></div>
              <div class="tilt-center"></div>
            </div>
            <div class="tilt-label">Pitch</div>
            <div class="tilt-value" part="pitch-value">—</div>
          </div>
          <div class="tilt-indicator">
            <div class="tilt-circle" part="roll-indicator">
              <div class="tilt-line"></div>
              <div class="tilt-center"></div>
            </div>
            <div class="tilt-label">Roll</div>
            <div class="tilt-value" part="roll-value">—</div>
          </div>
        </div>
        <div class="error-msg" part="error-msg"></div>
      </div>
    `;
  }

  attributeChangedCallback(name, _old, value) {
    const root = this.shadowRoot;
    switch (name) {
      case 'status': {
        const dot = root.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot ' + (value || 'idle');
        const err = root.querySelector('.error-msg');
        if (err) err.style.display = value === 'error' ? 'block' : 'none';
        break;
      }
      case 'error': {
        const err = root.querySelector('.error-msg');
        if (err) err.textContent = value || '';
        break;
      }
      case 'heading-deg': {
        const navDeg = (value !== null && value !== '' && !isNaN(Number(value)))
          ? internalToNavHeading(Number(value))
          : null;
        const compass = root.querySelector('.compass-needle');
        if (compass) compass.style.setProperty('--heading-deg', (navDeg !== null ? navDeg : 0) + 'deg');
        const hv = root.querySelector('[part="heading-value"]');
        if (hv) hv.textContent = navDeg !== null ? fmtDegrees(navDeg) : '—';
        break;
      }
      case 'pitch-deg': {
        const v = (value !== null && value !== '' && !isNaN(Number(value))) ? Number(value) : null;
        const ind = root.querySelector('[part="pitch-indicator"] .tilt-line');
        if (ind) ind.style.setProperty('--tilt-deg', (v !== null ? v : 0) + 'deg');
        const pv = root.querySelector('[part="pitch-value"]');
        if (pv) pv.textContent = v !== null ? fmtDegrees(v) : '—';
        break;
      }
      case 'roll-deg': {
        const v = (value !== null && value !== '' && !isNaN(Number(value))) ? Number(value) : null;
        const ind = root.querySelector('[part="roll-indicator"] .tilt-line');
        if (ind) ind.style.setProperty('--tilt-deg', (v !== null ? v : 0) + 'deg');
        const rv = root.querySelector('[part="roll-value"]');
        if (rv) rv.textContent = v !== null ? fmtDegrees(v) : '—';
        break;
      }
      // synced handled by CSS :host([synced="true"]) — no JS needed
    }
  }
}

// ---------------------------------------------------------------------------
// <gnss-position-widget>
// ---------------------------------------------------------------------------

class GnssPositionWidget extends HTMLElement {
  static get observedAttributes() {
    return [
      'status', 'error',
      'heading-deg', 'heading-accuracy-deg',
      'x-meters', 'y-meters', 'position-accuracy-meters',
      'fix-type', 'satellites',
      'synced',
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${SHARED_CSS}</style>
      <div class="card">
        <div class="card-header">
          <span class="card-title">GNSS Position</span>
          <span class="status-dot" part="status-dot"></span>
        </div>
        <div class="top-row">
          <div class="compass" part="compass">
            <div class="compass-circle">
              <span class="compass-label n">N</span>
              <span class="compass-label e">E</span>
              <span class="compass-label s">S</span>
              <span class="compass-label w">W</span>
              <div class="compass-needle"></div>
              <div class="compass-center"></div>
            </div>
          </div>
          <div class="top-metrics two">
            <div class="metric">
              <div class="metric-label">Heading</div>
              <div class="metric-value large" part="heading-value">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Heading Accuracy</div>
              <div class="metric-value" part="heading-accuracy-value">—</div>
            </div>
          </div>
        </div>
        <div class="gnss-section">
          <div class="gnss-row three">
            <div class="metric">
              <div class="metric-label">X</div>
              <div class="metric-value" part="x-value">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Y</div>
              <div class="metric-value" part="y-value">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Position Accuracy</div>
              <div class="metric-value" part="accuracy-value">—</div>
            </div>
          </div>
          <div class="gnss-row two">
            <div class="metric">
              <div class="metric-label">Fix Type</div>
              <div class="fix-pill gnss-fix-unknown" part="fix-value">—</div>
            </div>
            <div class="metric">
              <div class="metric-label">Satellites</div>
              <div class="metric-value" part="sats-value">—</div>
            </div>
          </div>
        </div>
        <div class="error-msg" part="error-msg"></div>
      </div>
    `;
  }

  attributeChangedCallback(name, _old, value) {
    const root = this.shadowRoot;
    switch (name) {
      case 'status': {
        const dot = root.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot ' + (value || 'idle');
        const err = root.querySelector('.error-msg');
        if (err) err.style.display = value === 'error' ? 'block' : 'none';
        break;
      }
      case 'error': {
        const err = root.querySelector('.error-msg');
        if (err) err.textContent = value || '';
        break;
      }
      case 'heading-deg': {
        const navDeg = (value !== null && value !== '' && !isNaN(Number(value)))
          ? internalToNavHeading(Number(value))
          : null;
        const needle = root.querySelector('.compass-needle');
        if (needle) needle.style.setProperty('--heading-deg', (navDeg !== null ? navDeg : 0) + 'deg');
        const hv = root.querySelector('[part="heading-value"]');
        if (hv) hv.textContent = navDeg !== null ? fmtDegrees(navDeg) : '—';
        break;
      }
      case 'heading-accuracy-deg': {
        const el = root.querySelector('[part="heading-accuracy-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value)))
          ? fmtDegrees(Number(value)) : '—';
        break;
      }
      case 'x-meters': {
        const el = root.querySelector('[part="x-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value)))
          ? fmtMeters(Number(value)) : '—';
        break;
      }
      case 'y-meters': {
        const el = root.querySelector('[part="y-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value)))
          ? fmtMeters(Number(value)) : '—';
        break;
      }
      case 'position-accuracy-meters': {
        const el = root.querySelector('[part="accuracy-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value)))
          ? fmtMeters(Number(value)) : '—';
        break;
      }
      case 'fix-type': {
        const el = root.querySelector('[part="fix-value"]');
        if (el) {
          el.textContent = value || '—';
          el.className = 'fix-pill ' + gnssFixClass(value);
        }
        break;
      }
      case 'satellites': {
        const el = root.querySelector('[part="sats-value"]');
        if (el) el.textContent = (value !== null && value !== '') ? value : '—';
        break;
      }
      // synced handled by CSS :host([synced="true"]) — no JS needed
    }
  }
}

customElements.define('imu-sensor-widget', ImuSensorWidget);
customElements.define('gnss-position-widget', GnssPositionWidget);
