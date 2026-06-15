/**
 * Sensor widget module — web component bundle and page helpers.
 *
 * The component JS is embedded as a string constant so the TypeScript build
 * (which only copies .ts output) carries it into dist without any extra copy
 * step or runtime file I/O.
 */

// ---------------------------------------------------------------------------
// Web component bundle — served verbatim at GET /sensor-widgets.js
// ---------------------------------------------------------------------------

export const SENSOR_WIDGETS_JS: string = `
// <imu-sensor-widget> and <gnss-position-widget> custom elements.
// Attributes updated via setAttribute(); shadow DOM isolates all styling.

(function () {
  'use strict';

  function internalToNavHeading(deg) {
    return (90 - deg + 360) % 360;
  }

  function fmtMeters(v) {
    if (v === null || v === undefined || isNaN(v)) return '\\u2014';
    return Number(v).toFixed(3) + ' m';
  }
  function fmtCentimetres(v) {
    if (v === null || v === undefined || isNaN(v)) return '\\u2014';
    return (Number(v) * 100).toFixed(1) + ' cm';
  }

  function fmtDegrees(v) {
    if (v === null || v === undefined || isNaN(v)) return '\\u2014';
    return Number(v).toFixed(1) + '\\u00b0';
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

  const SHARED_CSS = \`
    :host { display: block; width: 100%; box-sizing: border-box; }

    :host {
      --_bg-primary:     var(--bg-primary,     #ffffff);
      --_bg-secondary:   var(--bg-secondary,   #f9fafb);
      --_bg-tertiary:    var(--bg-tertiary,     #f3f4f6);
      --_text-primary:   var(--text-primary,   #111827);
      --_text-secondary: var(--text-secondary, #6b7280);
      --_border-color:   var(--border-color,   #e5e7eb);
      --_primary-color:  var(--primary-color,  #2563eb);
      --_danger-color:   var(--danger-color,   #ef4444);
      --_success-color:  var(--success-color,  #10b981);
      --_shadow-sm:      var(--shadow-sm, 0 1px 2px 0 rgba(0,0,0,0.05));
    }

    .card {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
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

    :host([synced="false"]) .card {
      background: linear-gradient(180deg, rgba(249,115,22,0.16), rgba(245,158,11,0.08));
      border-color: rgba(249,115,22,0.42);
      box-shadow: 0 0 0 1px rgba(249,115,22,0.12), var(--_shadow-sm);
    }

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

    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      display: inline-block;
      background: var(--_text-secondary);
      flex-shrink: 0;
    }
    .status-dot.running { background: var(--_success-color); box-shadow: 0 0 0 3px rgba(16,185,129,0.2); }
    .status-dot.error   { background: var(--_danger-color);  box-shadow: 0 0 0 3px rgba(239,68,68,0.2); }

    .compass {
      width: 100px; height: 100px;
      flex-shrink: 0; position: relative;
    }
    .compass-circle {
      width: 100%; height: 100%;
      border: 3px solid var(--_border-color);
      border-radius: 50%; position: relative;
      background: radial-gradient(circle, var(--_bg-secondary) 0%, var(--_bg-primary) 70%);
    }
    .compass-needle {
      position: absolute; top: 50%; left: 50%;
      width: 4px; height: 45%;
      background: linear-gradient(to top, var(--_danger-color), var(--_primary-color));
      transform-origin: bottom center;
      transform: translate(-50%, -100%) rotate(var(--heading-deg, 0deg));
      border-radius: 2px;
      transition: transform 0.3s ease-out;
    }
    .compass-center {
      position: absolute; top: 50%; left: 50%;
      width: 12px; height: 12px;
      background: var(--_text-primary); border-radius: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 3px var(--_bg-primary);
    }
    .compass-label {
      position: absolute;
      font-size: 0.75rem; font-weight: 600;
      color: var(--_text-secondary);
    }
    .compass-label.n { top: 8px;    left: 50%; transform: translateX(-50%); }
    .compass-label.e { right: 8px;  top:  50%; transform: translateY(-50%); }
    .compass-label.s { bottom: 8px; left: 50%; transform: translateX(-50%); }
    .compass-label.w { left: 8px;   top:  50%; transform: translateY(-50%); }

    .top-row { display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem; }
    .top-metrics { flex: 1; display: grid; gap: 0.75rem; min-width: 0; }
    .top-metrics.one { grid-template-columns: minmax(0,1fr); }
    .top-metrics.two { grid-template-columns: repeat(2, minmax(0,1fr)); }

    .metric {
      padding: 0.8rem 0.9rem;
      background: rgba(255,255,255,0.68);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(148,163,184,0.16);
      border-radius: 0.75rem;
      box-shadow: 0 1px 0 rgba(255,255,255,0.45) inset, 0 1px 2px rgba(15,23,42,0.05);
      display: flex; flex-direction: column; gap: 0.25rem;
      min-width: 0;
      overflow: hidden;
    }
    .metric-label {
      font-size: 0.6875rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--_text-secondary);
    }
    .metric-value {
      font-size: clamp(1.05rem, 1.1vw, 1.35rem);
      font-weight: 600; color: var(--_text-primary);
      font-variant-numeric: tabular-nums; line-height: 1.1;
    }
    .metric-value.large { font-size: clamp(1.35rem, 1.8vw, 1.8rem); }

    .tilt-indicators { display: flex; justify-content: space-around; gap: 1rem; margin-top: 1rem; }
    .tilt-indicator  { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
    .tilt-circle {
      width: 80px; height: 80px;
      border: 3px solid var(--_border-color); border-radius: 50%; position: relative;
      background: radial-gradient(circle, var(--_bg-secondary) 0%, var(--_bg-primary) 70%);
    }
    .tilt-line {
      position: absolute; top: 50%; left: 10%; right: 10%; height: 3px;
      background: var(--_primary-color); transform-origin: center center;
      transform: translateY(-50%) rotate(var(--tilt-deg, 0deg));
      border-radius: 2px; transition: transform 0.3s ease-out;
    }
    .tilt-center {
      position: absolute; top: 50%; left: 50%; width: 8px; height: 8px;
      background: var(--_text-primary); border-radius: 50%;
      transform: translate(-50%, -50%); box-shadow: 0 0 0 2px var(--_bg-primary);
    }
    .tilt-label { font-size: 0.6875rem; font-weight: 500; color: var(--_text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
    .tilt-value { font-size: 0.875rem; font-weight: 600; color: var(--_text-primary); }

    .gnss-section { display: flex; flex-direction: column; gap: 0.9rem; margin-top: 1rem; }
    .gnss-row { display: grid; gap: 0.75rem; }
    .gnss-row.two   { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .gnss-row.three { grid-template-columns: repeat(3, minmax(0,1fr)); }

    .fix-pill {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0.35rem 0.7rem; border-radius: 0.5rem;
      font-size: clamp(1.05rem, 1.1vw, 1.35rem); font-weight: 600;
      font-variant-numeric: tabular-nums;
      background: var(--_bg-tertiary); color: var(--_text-primary);
      width: 100%; box-sizing: border-box;
    }
    .fix-pill.gnss-fix-none,
    .fix-pill.gnss-fix-unknown  { background: #fee2e2; color: #991b1b; }
    .fix-pill.gnss-fix-single   { background: #ffedd5; color: #9a3412; }
    .fix-pill.gnss-fix-float,
    .fix-pill.gnss-fix-rtk-float { background: #fef3c7; color: #92400e; }
    .fix-pill.gnss-fix-fixed,
    .fix-pill.gnss-fix-rtk-fixed { background: #dcfce7; color: #166534; }

    .error-msg {
      background: #fef2f2; color: #991b1b;
      padding: 0.75rem; border-radius: 0.5rem;
      font-size: 0.875rem; margin-top: 0.75rem; display: none;
    }
  \`;

  // ── <imu-sensor-widget> ───────────────────────────────────────────────────

  class ImuSensorWidget extends HTMLElement {
    static get observedAttributes() {
      return ['status', 'error', 'heading-deg', 'pitch-deg', 'roll-deg', 'synced'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = \`
        <style>\${SHARED_CSS}</style>
        <div class="card">
          <div class="card-header">
            <span class="card-title">IMU Sensor</span>
            <span class="status-dot"></span>
          </div>
          <div class="top-row">
            <div class="compass">
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
                <div class="metric-value large" data-part="heading-value">—</div>
              </div>
            </div>
          </div>
          <div class="tilt-indicators">
            <div class="tilt-indicator">
              <div class="tilt-circle" data-part="pitch-indicator">
                <div class="tilt-line"></div><div class="tilt-center"></div>
              </div>
              <div class="tilt-label">Pitch</div>
              <div class="tilt-value" data-part="pitch-value">—</div>
            </div>
            <div class="tilt-indicator">
              <div class="tilt-circle" data-part="roll-indicator">
                <div class="tilt-line"></div><div class="tilt-center"></div>
              </div>
              <div class="tilt-label">Roll</div>
              <div class="tilt-value" data-part="roll-value">—</div>
            </div>
          </div>
          <div class="error-msg"></div>
        </div>
      \`;
    }
    attributeChangedCallback(name, _old, value) {
      const r = this.shadowRoot;
      if (name === 'status') {
        const dot = r.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot ' + (value || 'idle');
        const err = r.querySelector('.error-msg');
        if (err) err.style.display = value === 'error' ? 'block' : 'none';
      } else if (name === 'error') {
        const err = r.querySelector('.error-msg');
        if (err) err.textContent = value || '';
      } else if (name === 'heading-deg') {
        const nav = (value !== null && value !== '' && !isNaN(Number(value))) ? internalToNavHeading(Number(value)) : null;
        const needle = r.querySelector('.compass-needle');
        if (needle) needle.style.setProperty('--heading-deg', (nav !== null ? nav : 0) + 'deg');
        const hv = r.querySelector('[data-part="heading-value"]');
        if (hv) hv.textContent = nav !== null ? fmtDegrees(nav) : '\\u2014';
      } else if (name === 'pitch-deg') {
        const v = (value !== null && value !== '' && !isNaN(Number(value))) ? Number(value) : null;
        const line = r.querySelector('[data-part="pitch-indicator"] .tilt-line');
        if (line) line.style.setProperty('--tilt-deg', (v !== null ? v : 0) + 'deg');
        const pv = r.querySelector('[data-part="pitch-value"]');
        if (pv) pv.textContent = v !== null ? fmtDegrees(v) : '\\u2014';
      } else if (name === 'roll-deg') {
        const v = (value !== null && value !== '' && !isNaN(Number(value))) ? Number(value) : null;
        const line = r.querySelector('[data-part="roll-indicator"] .tilt-line');
        if (line) line.style.setProperty('--tilt-deg', (v !== null ? v : 0) + 'deg');
        const rv = r.querySelector('[data-part="roll-value"]');
        if (rv) rv.textContent = v !== null ? fmtDegrees(v) : '\\u2014';
      }
      // synced: handled entirely by :host([synced="..."]) CSS — no JS needed
    }
  }

  // ── <gnss-position-widget> ────────────────────────────────────────────────

  class GnssPositionWidget extends HTMLElement {
    static get observedAttributes() {
      return ['status','error','heading-deg','heading-accuracy-deg','x-meters','y-meters','position-accuracy-meters','fix-type','satellites','synced'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = \`
        <style>\${SHARED_CSS}</style>
        <div class="card">
          <div class="card-header">
            <span class="card-title">GNSS Position</span>
            <span class="status-dot"></span>
          </div>
          <div class="top-row">
            <div class="compass">
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
                <div class="metric-value large" data-part="heading-value">—</div>
              </div>
              <div class="metric">
                <div class="metric-label">Accuracy</div>
                <div class="metric-value" data-part="heading-accuracy-value">—</div>
              </div>
            </div>
          </div>
          <div class="gnss-section">
            <div class="gnss-row three">
              <div class="metric"><div class="metric-label">X</div><div class="metric-value" data-part="x-value">—</div></div>
              <div class="metric"><div class="metric-label">Y</div><div class="metric-value" data-part="y-value">—</div></div>
              <div class="metric"><div class="metric-label">Accuracy</div><div class="metric-value" data-part="accuracy-value">—</div></div>
            </div>
            <div class="gnss-row two">
              <div class="metric"><div class="metric-label">Fix Type</div><div class="fix-pill gnss-fix-unknown" data-part="fix-value">—</div></div>
              <div class="metric"><div class="metric-label">Satellites</div><div class="metric-value" data-part="sats-value">—</div></div>
            </div>
          </div>
          <div class="error-msg"></div>
        </div>
      \`;
    }
    attributeChangedCallback(name, _old, value) {
      const r = this.shadowRoot;
      if (name === 'status') {
        const dot = r.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot ' + (value || 'idle');
        const err = r.querySelector('.error-msg');
        if (err) err.style.display = value === 'error' ? 'block' : 'none';
      } else if (name === 'error') {
        const err = r.querySelector('.error-msg');
        if (err) err.textContent = value || '';
      } else if (name === 'heading-deg') {
        const nav = (value !== null && value !== '' && !isNaN(Number(value))) ? internalToNavHeading(Number(value)) : null;
        const needle = r.querySelector('.compass-needle');
        if (needle) needle.style.setProperty('--heading-deg', (nav !== null ? nav : 0) + 'deg');
        const hv = r.querySelector('[data-part="heading-value"]');
        if (hv) hv.textContent = nav !== null ? fmtDegrees(nav) : '\\u2014';
      } else if (name === 'heading-accuracy-deg') {
        const el = r.querySelector('[data-part="heading-accuracy-value"]');
        if (el) {
          const n = Number(value);
          el.textContent = (value !== null && value !== '' && !isNaN(n) && n < 180) ? fmtDegrees(n) : '\\u2014';
        }
      } else if (name === 'x-meters') {
        const el = r.querySelector('[data-part="x-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value))) ? fmtMeters(Number(value)) : '\\u2014';
      } else if (name === 'y-meters') {
        const el = r.querySelector('[data-part="y-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value))) ? fmtMeters(Number(value)) : '\\u2014';
      } else if (name === 'position-accuracy-meters') {
        const el = r.querySelector('[data-part="accuracy-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value))) ? fmtCentimetres(Number(value)) : '\\u2014';
      } else if (name === 'fix-type') {
        const el = r.querySelector('[data-part="fix-value"]');
        if (el) { el.textContent = value || '\\u2014'; el.className = 'fix-pill ' + gnssFixClass(value); }
      } else if (name === 'satellites') {
        const el = r.querySelector('[data-part="sats-value"]');
        if (el) el.textContent = (value !== null && value !== '') ? value : '\\u2014';
      }
      // synced: handled entirely by :host([synced="..."]) CSS — no JS needed
    }
  }

  // ── <motor-odometry-widget> ───────────────────────────────────────────────

  class MotorOdometryWidget extends HTMLElement {
    static get observedAttributes() {
      return ['status','error','heading-deg','x-meters','y-meters','confidence','synced'];
    }
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = \`
        <style>
          \${SHARED_CSS}
          .confidence-track {
            width: 100%; height: 10px;
            background: var(--_bg-tertiary);
            border-radius: 5px;
            overflow: hidden;
            margin-top: 0.25rem;
            border: 1px solid var(--_border-color);
          }
          .confidence-bar {
            height: 100%;
            width: 100%;
            background: linear-gradient(to right, var(--_danger-color) 0%, var(--_warning-color,#f59e0b) 50%, var(--_success-color) 100%);
            transform-origin: left center;
            transform: scaleX(var(--conf, 1));
            transition: transform 0.4s ease-out;
          }
          .conf-row { display: flex; flex-direction: column; gap: 0.3rem; }
          .conf-label { font-size: 0.6875rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--_text-secondary); display: flex; justify-content: space-between; }
        </style>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Motor Odometry</span>
            <span class="status-dot"></span>
          </div>
          <div class="top-row">
            <div class="compass">
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
                <div class="metric-value large" data-part="heading-value">—</div>
              </div>
            </div>
          </div>
          <div class="gnss-section">
            <div class="gnss-row two">
              <div class="metric"><div class="metric-label">X</div><div class="metric-value" data-part="x-value">—</div></div>
              <div class="metric"><div class="metric-label">Y</div><div class="metric-value" data-part="y-value">—</div></div>
            </div>
            <div class="metric conf-row">
              <div class="conf-label">
                <span>DR Confidence</span>
                <span data-part="conf-text">—</span>
              </div>
              <div class="confidence-track">
                <div class="confidence-bar" data-part="conf-bar"></div>
              </div>
            </div>
          </div>
          <div class="error-msg"></div>
        </div>
      \`;
    }
    attributeChangedCallback(name, _old, value) {
      const r = this.shadowRoot;
      if (name === 'status') {
        const dot = r.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot ' + (value || 'idle');
        const err = r.querySelector('.error-msg');
        if (err) err.style.display = value === 'error' ? 'block' : 'none';
      } else if (name === 'error') {
        const err = r.querySelector('.error-msg');
        if (err) err.textContent = value || '';
      } else if (name === 'heading-deg') {
        const nav = (value !== null && value !== '' && !isNaN(Number(value))) ? internalToNavHeading(Number(value)) : null;
        const needle = r.querySelector('.compass-needle');
        if (needle) needle.style.setProperty('--heading-deg', (nav !== null ? nav : 0) + 'deg');
        const hv = r.querySelector('[data-part="heading-value"]');
        if (hv) hv.textContent = nav !== null ? fmtDegrees(nav) : '\\u2014';
      } else if (name === 'x-meters') {
        const el = r.querySelector('[data-part="x-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value))) ? fmtMeters(Number(value)) : '\\u2014';
      } else if (name === 'y-meters') {
        const el = r.querySelector('[data-part="y-value"]');
        if (el) el.textContent = (value !== null && value !== '' && !isNaN(Number(value))) ? fmtMeters(Number(value)) : '\\u2014';
      } else if (name === 'confidence') {
        const n = (value !== null && value !== '' && !isNaN(Number(value))) ? Math.max(0, Math.min(1, Number(value))) : null;
        const bar = r.querySelector('[data-part="conf-bar"]');
        if (bar) bar.style.setProperty('--conf', n !== null ? n : 1);
        const txt = r.querySelector('[data-part="conf-text"]');
        if (txt) txt.textContent = n !== null ? Math.round(n * 100) + '%' : '\\u2014';
      }
      // synced: handled entirely by :host([synced="..."]) CSS
    }
  }

  customElements.define('imu-sensor-widget', ImuSensorWidget);
  customElements.define('gnss-position-widget', GnssPositionWidget);
  customElements.define('motor-odometry-widget', MotorOdometryWidget);
})();
`;

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/**
 * HTML <script> tag that loads the web components.
 * Include once in each page's <head>.
 */
export function getSensorWidgetScriptTag(): string {
  return `<script src="/sensor-widgets.js" defer></script>`;
}

/**
 * Minimal page-level CSS for widget placement.
 * Contains only layout rules — no typography or colour that would override
 * the component's shadow CSS.
 */
export function getSensorWidgetLayoutStyles(): string {
  return `
    imu-sensor-widget,
    gnss-position-widget,
    motor-odometry-widget {
      display: block;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      height: 100%;
    }
  `;
}
