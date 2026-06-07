import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../config/apiBase';

const API_URL = `${API_BASE}/predict/oracle`;
const REFRESH_MS = 25000;
const HISTORY_PAGE_SIZE = 15;

export function clearPredictionReportCache() {}

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Request timeout after ${Math.ceil(timeoutMs / 1000)}s`);
    throw error;
  } finally { clearTimeout(timer); }
}

// ΓöÇΓöÇΓöÇ Utility helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const WHITE_PHASE_MAP = {
  NORMAL: { label: 'Normal', icon: '●', class: 'wp-normal' },
  PRE_WHITE: { label: 'Warning', icon: '⦿', class: 'wp-pre' },
  WHITE_ACTIVE: { label: 'White Active', icon: '◉', class: 'wp-active' },
  WHITE_ENDING: { label: 'Recovery', icon: '◘', class: 'wp-ending' },
};

const REGIME_MAP = {
  RANDOM: { icon: '◫', class: 'regime-random' },
  TRENDING_UP: { icon: '▓', class: 'regime-up' },
  TRENDING_DOWN: { icon: '╝', class: 'regime-down' },
  CLUSTERED_LOW: { icon: 'ú', class: 'regime-clustered' },
  CLUSTERED: { icon: '⌐', class: 'regime-clustered' },
  VOLATILE: { icon: '◈', class: 'regime-volatile' },
  DISPERSED: { icon: '◇', class: 'regime-dispersed' },
};

function getAvoidReasonText(reason) {
  const map = {
    pre_white_cluster: 'Market softening detected — waiting for confirmation.',
    white_cluster: 'White cluster active — all signals suppressed.',
    downtrend: 'Downtrend regime — waiting for reversal.',
    recent_b2b_risk: 'B2B flow unstable — observing.',
    too_early: 'Too early since last hit — setup forming.',
    weak_probability: 'Edge not strong enough yet.',
    random_like: 'Regime appears random — signal quality low.',
    near_threshold: 'Signal is close to lock level — watching for confirmation.',
    observe_only: 'Mixed signals — in observe mode.',
    confidence_drop: 'Live confidence dropped — caution.',
    insufficient_data: 'Not enough data for this target yet.',
    insufficient_gaps: 'Need more gap samples to predict.',
  };
  return map[reason] || 'Observing — waiting for clearer signal.';
}

function getLockStatusInfo(target) {
  const locked = Boolean(target.activePrediction);
  if (locked && target.inWindow) return { label: 'LIVE', class: 'lock-live', glow: true };
  if (locked) return { label: 'LOCKED', class: 'lock-armed', glow: false };
  if (target.issuePrediction) return { label: 'READY', class: 'lock-ready', glow: false };
  const effectiveThreshold = Number(target.effectiveThreshold || target.threshold || 0);
  const confidence = Number(target.confidence || 0);
  if (target.issueMode === 'watch' || (effectiveThreshold > 0 && confidence >= (effectiveThreshold - 4))) {
    return { label: 'WATCH', class: 'lock-ready', glow: false };
  }
  if (target.issueMode === 'prep') return { label: 'PREP', class: 'lock-idle', glow: false };
  return { label: 'IDLE', class: 'lock-idle', glow: false };
}

function getRoundWindowLine(target) {
  const lo = Number(target.windowLo || 0);
  const hi = Number(target.windowHi || 0);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return 'Calculating...';
  if (target.activePrediction) {
    if (target.inWindow) return `LIVE: #${lo.toLocaleString()} → #${hi.toLocaleString()}`;
    return `Locked: #${lo.toLocaleString()} → #${hi.toLocaleString()}`;
  }
  const away = Math.max(0, Number(target.roundsUntilWindowLo || 0));
  return `Window: #${lo.toLocaleString()} → #${hi.toLocaleString()} (${away}r)`;
}

function getLockDriftAlertLine(target) {
  if (!target.lockDriftAlert) return null;
  if (target.lockDriftReason === 'confidence_drop' && Number.isFinite(Number(target.confidence)) && Number.isFinite(Number(target.liveConfidence))) {
    return `⚡ Confidence shifted: ${Math.round(Number(target.confidence))}% → ${Math.round(Number(target.liveConfidence))}%`;
  }
  return `⚡ Live setup changed — ${getAvoidReasonText(target.lockDriftReason || target.liveAvoidReason).toLowerCase()}`;
}

// ΓöÇΓöÇΓöÇ Mini Sparkline (SVG) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ


// ΓöÇΓöÇΓöÇ Confidence Gauge (SVG Arc) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function ConfidenceGauge({ value, size = 72 }) {
  const radius = (size - 8) / 2;
  const circumference = Math.PI * radius; // half circle
  const progress = Math.max(0, Math.min(100, value)) / 100;
  const offset = circumference * (1 - progress);
  const cy = size / 2 + 4;

  const color = value >= 55 ? '#00ff88' : value >= 35 ? '#ffd84d' : '#ff4560';

  return (
    <div className="oracle-gauge-wrap">
      <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`}>
        <path
          d={`M 4,${cy} A ${radius},${radius} 0 0 1 ${size - 4},${cy}`}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" strokeLinecap="round"
        />
        <path
          className="oracle-gauge-arc"
          d={`M 4,${cy} A ${radius},${radius} 0 0 1 ${size - 4},${cy}`}
          fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.4s ease' }}
        />
      </svg>
      <div className="oracle-gauge-label" style={{ color }}>
        <span className="oracle-gauge-value">{Math.round(value)}</span>
        <span className="oracle-gauge-pct">%</span>
      </div>
    </div>
  );
}

// ΓöÇΓöÇΓöÇ B2B Momentum Bar ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function B2BBar({ score }) {
  const s = Math.max(0, Math.min(100, score));
  const color = s >= 70 ? '#00ff88' : s >= 40 ? '#ffd84d' : 'rgba(255,255,255,0.15)';
  return (
    <div className="oracle-b2b-bar-wrap">
      <div className="oracle-b2b-bar-track">
        <div className="oracle-b2b-bar-fill" style={{ width: `${s}%`, background: color, transition: 'width 0.6s ease, background 0.4s ease' }} />
      </div>
      <span className="oracle-b2b-bar-label" style={{ color: s >= 40 ? color : 'rgba(255,255,255,0.3)' }}>{s}%</span>
    </div>
  );
}

// ΓöÇΓöÇΓöÇ Forecast Card (Premium) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function ForecastCard({ target }) {
  const lockInfo = getLockStatusInfo(target);
  const wpInfo = WHITE_PHASE_MAP[target.whitePhase] || WHITE_PHASE_MAP.NORMAL;
  const regimeInfo = REGIME_MAP[target.regimeLabel] || REGIME_MAP.RANDOM;
  const driftAlert = getLockDriftAlertLine(target);
if (target.noData) {
    return (
      <article className="oracle-v3-card oracle-v3-card-empty">
        <div className="oracle-v3-card-accent" style={{ background: target.color }} />
        <div className="oracle-v3-card-header">
          <span className="oracle-v3-target-label" style={{ color: target.color }}>{target.label}</span>
          <span className="oracle-v3-lock-badge lock-idle">NO DATA</span>
        </div>
        <div className="oracle-v3-empty-reason">{target.reason || 'Insufficient data'}</div>
      </article>
    );
  }

  return (
    <article className={`oracle-v3-card ${lockInfo.glow ? 'oracle-v3-card-glow' : ''} ${lockInfo.class}`}>
      <div className="oracle-v3-card-accent" style={{ background: target.color }} />

      {/* Header: label + lock badge */}
      <div className="oracle-v3-card-header">
        <span className="oracle-v3-target-label" style={{ color: target.color }}>{target.label}</span>
        <span className={`oracle-v3-lock-badge ${lockInfo.class}`}>{lockInfo.label}</span>
      </div>

      {/* Gauge + Signals row */}
      <div className="oracle-v3-card-body">
        <ConfidenceGauge value={target.confidence || 0} size={72} />

        <div className="oracle-v3-signals">
          {/* White phase */}
          <div className={`oracle-v3-signal-pill ${wpInfo.class}`}>
            <span className="oracle-v3-signal-icon">{wpInfo.icon}</span>
            <span>{wpInfo.label}</span>
          </div>

          {/* Regime */}
          <div className={`oracle-v3-signal-pill ${regimeInfo.class}`}>
            <span className="oracle-v3-signal-icon">{regimeInfo.icon}</span>
            <span>{target.regimeLabel || 'RANDOM'}</span>
          </div>

          {/* Mode pill */}
          <div className={`oracle-v3-signal-pill oracle-v3-mode-${target.issueMode || 'observe'}`}>
            <span>{(target.issueMode || 'observe').replace(/_/g, ' ').toUpperCase()}</span>
          </div>
        </div>
      </div>

      {/* B2B momentum bar */}
      <div className="oracle-v3-b2b-section">
        <span className="oracle-v3-b2b-title">B2B Momentum</span>
        <B2BBar score={target.b2bScore || 0} />
      </div>

      

      {/* Window info */}
      <div className="oracle-v3-window-line">{getRoundWindowLine(target)}</div>

      

      {/* Drift alert */}
      {driftAlert && <div className="oracle-v3-drift-alert">{driftAlert}</div>}

      {/* Reason line */}
      <div className="oracle-v3-reason-line">
        {target.activePrediction
          ? target.inWindow
            ? 'Lock is LIVE — timing and pattern aligned.'
            : `Locked for scheduled window.`
          : getAvoidReasonText(target.liveAvoidReason || target.avoidReason)
        }
      </div>

      {/* Layer breakdown (collapsible) */}
      {target.layerBreakdown && target.layerBreakdown.length > 0 && (
        <LayerBreakdown layers={target.layerBreakdown} />
      )}
    </article>
  );
}

// ΓöÇΓöÇΓöÇ Layer Breakdown (expandable) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function LayerBreakdown({ layers }) {
  const [open, setOpen] = useState(false);
  if (!layers || !layers.length) return null;
  return (
    <div className="oracle-v3-layers">
      <button className="oracle-v3-layers-toggle" onClick={() => setOpen(o => !o)}>
        {open ? 'Γû╛' : 'Γû╕'} Engine Layers ({layers.length})
      </button>
      {open && (
        <div className="oracle-v3-layers-grid">
          {layers.map((l, i) => (
            <div key={i} className="oracle-v3-layer-row">
              <span className="oracle-v3-layer-name">{l.name}</span>
              <span className="oracle-v3-layer-prob">{l.prob}%</span>
              <div className="oracle-v3-layer-bar">
                <div className="oracle-v3-layer-bar-fill" style={{ width: `${Math.min(100, l.prob)}%` }} />
              </div>
              <span className="oracle-v3-layer-reliability">R:{l.reliability}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ΓöÇΓöÇΓöÇ Dashboard Header Bar ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function DashboardHeader({ report }) {
  const activeLocks = report?.activeLockCount || 0;
  const inWindow = report?.inWindowCount || 0;
  const totalRounds = report?.roundsLoaded || 0;
  const asOf = report?.asOfRound || 0;
  const globalWP = WHITE_PHASE_MAP[report?.globalWhitePhase] || WHITE_PHASE_MAP.NORMAL;
  const regime = report?.dominantRegime || 'RANDOM';
  const regimeInfo = REGIME_MAP[regime] || REGIME_MAP.RANDOM;

  // Win rate from history
  const history = report?.history || [];
  const wins = history.filter(r => r.result === 'WIN').length;
  const losses = history.filter(r => r.result === 'FAILED').length;
  const counted = wins + losses;
  const winRate = counted > 0 ? Math.round((wins / counted) * 100) : null;

  return (
    <div className="oracle-v3-dashboard-bar">
      <div className="oracle-v3-dash-item">
        <span className="oracle-v3-dash-value">{totalRounds.toLocaleString()}</span>
        <span className="oracle-v3-dash-label">Rounds</span>
      </div>
      <div className="oracle-v3-dash-item">
        <span className="oracle-v3-dash-value">#{asOf ? asOf.toLocaleString() : '—'}</span>
        <span className="oracle-v3-dash-label">Live Round</span>
      </div>
      <div className="oracle-v3-dash-item">
        <span className="oracle-v3-dash-value oracle-v3-dash-active">{activeLocks}</span>
        <span className="oracle-v3-dash-label">Active</span>
      </div>
      <div className="oracle-v3-dash-item">
        <span className="oracle-v3-dash-value" style={{ color: inWindow > 0 ? '#00ff88' : 'inherit' }}>{inWindow}</span>
        <span className="oracle-v3-dash-label">In Window</span>
      </div>
      {winRate !== null && (
        <div className="oracle-v3-dash-item">
          <span className="oracle-v3-dash-value" style={{ color: winRate >= 50 ? '#00ff88' : '#ff4560' }}>{winRate}%</span>
          <span className="oracle-v3-dash-label">Accuracy</span>
        </div>
      )}
      <div className={`oracle-v3-dash-item oracle-v3-dash-wp ${globalWP.class}`}>
        <span className="oracle-v3-dash-value">{globalWP.icon} {globalWP.label}</span>
        <span className="oracle-v3-dash-label">White Phase</span>
      </div>
      <div className={`oracle-v3-dash-item ${regimeInfo.class}`}>
        <span className="oracle-v3-dash-value">{regimeInfo.icon} {regime}</span>
        <span className="oracle-v3-dash-label">Regime</span>
      </div>
    </div>
  );
}

// ΓöÇΓöÇΓöÇ History Panel ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function HistoryPanel({ report }) {
  const [targetFilter, setTargetFilter] = useState('ALL');
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
  const historyRows = useMemo(() => report?.history || [], [report]);
  const targetOptions = useMemo(
    () => ['ALL', ...(report?.targets || []).map(t => t.label)],
    [report]
  );

  const filteredRows = useMemo(() => {
    if (targetFilter === 'ALL') return historyRows;
    return historyRows.filter(row => row.target === targetFilter);
  }, [historyRows, targetFilter]);

  const totals = useMemo(() =>
    filteredRows.reduce((acc, row) => {
      if (row.result === 'WIN') acc.wins += 1;
      else if (row.result === 'EARLY') acc.early += 1;
      else acc.failed += 1;
      return acc;
    }, { wins: 0, early: 0, failed: 0 }),
    [filteredRows]
  );

  const counted = totals.wins + totals.failed;
  const winRate = counted ? Math.round((totals.wins / counted) * 100) : null;
  const visibleRows = filteredRows.slice(0, visibleCount);
  const hasMore = filteredRows.length > visibleRows.length;

  useEffect(() => { setVisibleCount(HISTORY_PAGE_SIZE); }, [targetFilter, historyRows.length]);

  return (
    <section className="oracle-v3-history-shell">
      <div className="oracle-v3-history-header">
        <h3>Oracle History</h3>
        <label className="oracle-v3-history-filter">
          <select value={targetFilter} onChange={e => setTargetFilter(e.target.value)}>
            {targetOptions.map(opt => <option key={opt} value={opt}>{opt === 'ALL' ? 'All Targets' : opt}</option>)}
          </select>
        </label>
      </div>

      <div className="oracle-v3-history-summary">
        <div className="oracle-v3-hist-pill green"><strong>{totals.wins}</strong><span>Wins</span></div>
        <div className="oracle-v3-hist-pill cyan"><strong>{totals.early}</strong><span>Early</span></div>
        <div className="oracle-v3-hist-pill red"><strong>{totals.failed}</strong><span>Missed</span></div>
        <div className="oracle-v3-hist-pill gold"><strong>{winRate != null ? `${winRate}%` : '—'}</strong><span>Win Rate</span></div>
      </div>

      <div className="oracle-v3-history-note">
        Early hits are neutral. Accuracy = wins ÷ (wins + missed).
      </div>

      <div className="oracle-v3-history-list">
        {visibleRows.length === 0 && (
          <div className="oracle-v3-empty-state">History appears as locks resolve.</div>
        )}
        {visibleRows.map(row => (
          <article key={`${row.target}-${row.lo}-${row.hi}-${row.generation}-${row.id}`} className="oracle-v3-hist-item">
            <div className="oracle-v3-hist-main">
              <span className="oracle-v3-hist-target">{row.target}</span>
              <span className="oracle-v3-hist-window">#{row.lo?.toLocaleString()} → #{row.hi?.toLocaleString()}</span>
            </div>
            <div className="oracle-v3-hist-meta">
              <span>{row.hitRound ? (row.result === 'EARLY' ? `early #${row.hitRound.toLocaleString()}` : `hit #${row.hitRound.toLocaleString()}`) : 'no hit'}</span>
              <span>gen {row.generation || 1}</span>
              <span className={`oracle-v3-hist-status ${row.result === 'WIN' ? 'green' : row.result === 'EARLY' ? 'cyan' : 'red'}`}>
                {row.result}
              </span>
            </div>
          </article>
        ))}
      </div>
      {hasMore && (
        <div className="oracle-v3-history-more">
          <button className="oracle-v3-btn-more" onClick={() => setVisibleCount(c => c + HISTORY_PAGE_SIZE)}>Show More</button>
        </div>
      )}
    </section>
  );
}

// ΓöÇΓöÇΓöÇ Main Prediction Section ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export default function PredictionSection({ rounds = [] }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState(true);
  const [tab, setTab] = useState('predict');
  const requestSeqRef = useRef(0);
  const reportRef = useRef(null);
  const lagSyncRef = useRef(0);

  const collectorLatestRound = useMemo(() => {
    const last = rounds?.[rounds.length - 1];
    return Number(last?.roundId || last?.id || 0);
  }, [rounds]);

  const targets = report?.targets || [];
  const asOfRound = Number(report?.asOfRound || 0);
  const liveLabel = `LIVE ${Math.round(REFRESH_MS / 1000)}s`;

  useEffect(() => { reportRef.current = report; }, [report]);

  const loadReport = useCallback(async (silent = false) => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    if (silent) setRefreshing(true);
    else if (!reportRef.current) setLoading(true);
    try {
      const data = await fetchJsonWithTimeout(API_URL);
      if (seq !== requestSeqRef.current) return;
      setReport(data);
      setError('');
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err.message || 'Oracle engine request failed');
    } finally {
      if (seq === requestSeqRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => { loadReport(false); }, [loadReport]);
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => loadReport(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [live, loadReport]);

  useEffect(() => {
    if (!live || !report || loading || refreshing) return;
    if (!collectorLatestRound || !asOfRound) return;
    const lag = collectorLatestRound - asOfRound;
    if (lag < 3) return;
    const now = Date.now();
    if ((now - lagSyncRef.current) < REFRESH_MS) return;
    lagSyncRef.current = now;
    loadReport(true);
  }, [live, report, loading, refreshing, collectorLatestRound, asOfRound, loadReport]);

  useEffect(() => {
    const handleCacheCleared = () => loadReport(true);
    window.addEventListener('predictions:cache-cleared', handleCacheCleared);
    return () => window.removeEventListener('predictions:cache-cleared', handleCacheCleared);
  }, [loadReport]);

  return (
    <section className="oracle-v3-root">
      {/* Header */}
      <div className="oracle-v3-header">
        <div className="oracle-v3-header-left">
          <div className="oracle-v3-logo-mark">◎</div>
          <div>
            <h2 className="oracle-v3-title">Oracle Predictor <span className="oracle-v3-version">V3</span></h2>
            <p className="oracle-v3-subtitle">7-Layer Ensemble Engine • {report?.engineVersion || 'oracle_v3'}</p>
          </div>
        </div>
        <div className="oracle-v3-header-actions">
          <button className={`oracle-v3-btn ${live ? 'oracle-v3-btn-live' : 'oracle-v3-btn-off'}`} onClick={() => setLive(v => !v)}>
            {live ? `● ${liveLabel}` : '○ PAUSED'}
          </button>
          <button className="oracle-v3-btn oracle-v3-btn-refresh" onClick={() => loadReport(true)} disabled={loading || refreshing}>
            {refreshing ? '↻ ...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Dashboard bar */}
      {report && <DashboardHeader report={report} />}

      {/* Tab bar */}
      <div className="oracle-v3-tabs">
        <button className={`oracle-v3-tab ${tab === 'predict' ? 'active' : ''}`} onClick={() => setTab('predict')}>PREDICTIONS</button>
        <button className={`oracle-v3-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>HISTORY</button>
      </div>

      {/* Error */}
      {error && (
        <div className="oracle-v3-error">
          {error}
          {report ? ' Showing last good snapshot.' : ''}
        </div>
      )}

      {/* Content */}
      {loading && !report ? (
        <div className="oracle-v3-loading">
          <div className="oracle-v3-loading-spinner" />
          <span>Initializing Oracle V3 engine...</span>
        </div>
      ) : tab === 'predict' ? (
        <div className="oracle-v3-card-grid">
          {targets.map(target => (
            <ForecastCard key={target.label} target={target} />
          ))}
        </div>
      ) : (
        <HistoryPanel report={report} />
      )}
    </section>
  );
}
