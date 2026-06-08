import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../config/apiBase';

const ORACLE_URL    = `${API_BASE}/predict/oracle`;
const REFRESH_MS    = 25000;
const HISTORY_PAGE  = 20;
const TOWER_PAGE    = 30;

export function clearPredictionReportCache() {}

// ─── Fetch helper ─────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, ...opts });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Timeout after ${Math.ceil(ms / 1000)}s`);
    throw e;
  } finally { clearTimeout(t); }
}

// ─── Colour helpers ───────────────────────────────────────────────────────────
const LETTER_COLOR = { A: '#00d4ff', B: '#00ff88', C: '#ffd84d' };

function confColor(v) {
  return v >= 60 ? '#00ff88' : v >= 38 ? '#ffd84d' : '#ff6b6b';
}

// ─── Confidence arc ───────────────────────────────────────────────────────────
function ConfArc({ value = 0, size = 64 }) {
  const r = (size - 10) / 2;
  const circ = Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const cy = size / 2 + 6;
  const col = confColor(value);
  return (
    <div style={{ position: 'relative', width: size, height: size / 2 + 14, flexShrink: 0 }}>
      <svg width={size} height={size / 2 + 14} viewBox={`0 0 ${size} ${size / 2 + 14}`}>
        <path d={`M 5,${cy} A ${r},${r} 0 0 1 ${size-5},${cy}`}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" strokeLinecap="round"/>
        <path d={`M 5,${cy} A ${r},${r} 0 0 1 ${size-5},${cy}`}
          fill="none" stroke={col} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 0.7s ease, stroke 0.4s' }}/>
      </svg>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center',
        fontSize: 15, fontWeight: 900, color: col, fontFamily: 'monospace', letterSpacing: -1 }}>
        {Math.round(value)}<span style={{ fontSize: 9, opacity: 0.7 }}>%</span>
      </div>
    </div>
  );
}

// ─── Tower Sequence Display ───────────────────────────────────────────────────
function TowerSeq({ seq = '', dim = false }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {seq.split('').map((l, i) => (
        <span key={i} style={{
          width: 22, height: 22, borderRadius: 5, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 11, fontWeight: 900, fontFamily: 'monospace',
          background: dim ? 'rgba(255,255,255,0.04)' : `${LETTER_COLOR[l] || '#888'}18`,
          color: dim ? '#555' : (LETTER_COLOR[l] || '#888'),
          border: `1px solid ${dim ? '#222' : `${LETTER_COLOR[l] || '#888'}44`}`,
        }}>{l}</span>
      ))}
    </div>
  );
}

// ─── Oracle: ForecastCard ─────────────────────────────────────────────────────
function statusBadge(t) {
  if (t.activePrediction && t.inWindow) return { label: 'LIVE', color: '#00ff88', glow: true };
  if (t.activePrediction) return { label: 'LOCKED', color: '#00d4ff', glow: false };
  if (t.issuePrediction)  return { label: 'READY',  color: '#ffd84d', glow: false };
  return { label: 'IDLE', color: '#444', glow: false };
}

function windowLine(t) {
  const lo = Number(t.windowLo || 0), hi = Number(t.windowHi || 0);
  if (!lo) return 'Calculating...';
  if (t.activePrediction && t.inWindow) return `LIVE #${lo.toLocaleString()} → #${hi.toLocaleString()}`;
  if (t.activePrediction) return `Locked #${lo.toLocaleString()} → #${hi.toLocaleString()}`;
  const away = Math.max(0, Number(t.roundsUntilWindowLo || 0));
  return `#${lo.toLocaleString()} → #${hi.toLocaleString()} · ${away}r away`;
}

function ForecastCard({ target: t }) {
  const st = statusBadge(t);
  if (t.noData) return (
    <div style={CARD_STYLE}>
      <div style={{ ...ACCENT_BAR, background: t.color || '#333' }}/>
      <div style={CARD_HEADER}>
        <span style={{ fontWeight: 900, color: t.color || '#888', fontSize: 15 }}>{t.label}</span>
        <span style={{ ...BADGE_STYLE, background: '#1a1a1a', color: '#555', border: '1px solid #2a2a2a' }}>NO DATA</span>
      </div>
      <div style={{ fontSize: 12, color: '#444', marginTop: 8 }}>{t.reason || 'Insufficient data'}</div>
    </div>
  );

  return (
    <div style={{ ...CARD_STYLE, ...(st.glow ? { boxShadow: `0 0 24px ${st.color}22, 0 0 0 1px ${st.color}33` } : {}) }}>
      <div style={{ ...ACCENT_BAR, background: t.color || '#333' }}/>

      <div style={CARD_HEADER}>
        <span style={{ fontWeight: 900, color: t.color || '#eee', fontSize: 15 }}>{t.label}</span>
        <span style={{ ...BADGE_STYLE, color: st.color, background: `${st.color}15`, border: `1px solid ${st.color}40` }}>
          {st.glow && <span style={{ marginRight: 4 }}>●</span>}{st.label}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginTop: 10 }}>
        <ConfArc value={t.confidence || 0} size={64} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 11, color: '#555', fontWeight: 700 }}>CONFIDENCE</div>
          {/* Regime + mode chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {t.regimeLabel && (
              <span style={CHIP_STYLE}>{t.regimeLabel}</span>
            )}
            {t.issueMode && (
              <span style={{ ...CHIP_STYLE, background: '#00d4ff10', color: '#00d4ff', borderColor: '#00d4ff30' }}>
                {t.issueMode.replace(/_/g, ' ').toUpperCase()}
              </span>
            )}
          </div>
          {/* B2B bar */}
          {t.b2bScore != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#555', whiteSpace: 'nowrap' }}>B2B</span>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: '#1a1a1a', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, t.b2bScore))}%`, height: '100%', borderRadius: 2,
                  background: t.b2bScore >= 60 ? '#00ff88' : t.b2bScore >= 35 ? '#ffd84d' : '#333',
                  transition: 'width 0.5s ease',
                }}/>
              </div>
              <span style={{ fontSize: 10, color: '#555', width: 28, textAlign: 'right' }}>{t.b2bScore}%</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: '#666', fontFamily: 'monospace' }}>{windowLine(t)}</div>

      {t.lockDriftAlert && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#ffd84d', background: '#ffd84d0a',
          border: '1px solid #ffd84d22', borderRadius: 5, padding: '4px 8px' }}>
          ⚡ {t.liveAvoidReason || t.lockDriftReason || 'Setup changed'}
        </div>
      )}
    </div>
  );
}

// ─── Oracle History ───────────────────────────────────────────────────────────
function OracleHistory({ report }) {
  const [filter, setFilter] = useState('ALL');
  const [page, setPage]     = useState(HISTORY_PAGE);
  const rows   = report?.history || [];
  const labels = ['ALL', ...(report?.targets || []).map(t => t.label)];
  const filtered = filter === 'ALL' ? rows : rows.filter(r => r.target === filter);
  const { wins, missed } = filtered.reduce((a, r) => {
    if (r.result === 'WIN') a.wins++; else if (r.result === 'FAILED') a.missed++;
    return a;
  }, { wins: 0, missed: 0 });
  const wr = wins + missed > 0 ? Math.round(wins / (wins + missed) * 100) : null;

  return (
    <div>
      {/* Summary pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { label: 'Wins', value: wins, color: '#00ff88' },
          { label: 'Missed', value: missed, color: '#ff6b6b' },
          { label: 'Win Rate', value: wr != null ? `${wr}%` : '—', color: wr >= 50 ? '#00ff88' : '#ff6b6b' },
        ].map(p => (
          <div key={p.label} style={{ background: '#0d0d0d', border: `1px solid ${p.color}22`,
            borderRadius: 8, padding: '6px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: p.color, fontFamily: 'monospace' }}>{p.value}</div>
            <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{p.label}</div>
          </div>
        ))}
        <select value={filter} onChange={e => { setFilter(e.target.value); setPage(HISTORY_PAGE); }}
          style={{ marginLeft: 'auto', background: '#111', border: '1px solid #222', borderRadius: 6,
            padding: '6px 10px', fontSize: 12, color: '#aaa', outline: 'none' }}>
          {labels.map(l => <option key={l} value={l}>{l === 'ALL' ? 'All Targets' : l}</option>)}
        </select>
      </div>

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.slice(0, page).map(row => (
          <div key={`${row.target}-${row.lo}-${row.hi}-${row.id}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#0a0a0a', border: '1px solid #191919', borderRadius: 7, padding: '8px 12px',
              fontSize: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 900, color: '#ccc', minWidth: 40 }}>{row.target}</span>
              <span style={{ color: '#444', fontFamily: 'monospace', fontSize: 11 }}>
                #{row.lo?.toLocaleString()} → #{row.hi?.toLocaleString()}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {row.hitRound && <span style={{ fontSize: 11, color: '#555' }}>#{row.hitRound?.toLocaleString()}</span>}
              <span style={{
                fontWeight: 800, fontSize: 11, padding: '2px 8px', borderRadius: 4,
                background: row.result === 'WIN' ? '#00ff8815' : row.result === 'EARLY' ? '#00d4ff15' : '#ff456015',
                color: row.result === 'WIN' ? '#00ff88' : row.result === 'EARLY' ? '#00d4ff' : '#ff6b6b',
              }}>{row.result}</span>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: '#333', fontSize: 13, padding: '32px 0' }}>
            History appears as locks resolve.
          </div>
        )}
      </div>
      {filtered.length > page && (
        <button onClick={() => setPage(p => p + HISTORY_PAGE)}
          style={{ marginTop: 10, width: '100%', background: 'none', border: '1px solid #222',
            borderRadius: 7, padding: '8px', fontSize: 12, color: '#555', cursor: 'pointer' }}>
          Show more ({filtered.length - page} left)
        </button>
      )}
    </div>
  );
}

// ─── Tower Tab ────────────────────────────────────────────────────────────────
function TowerTab({ adminSecret }) {
  const [sites,      setSites]      = useState([]);
  const [siteId,     setSiteId]     = useState(null);
  const [history,    setHistory]    = useState([]);
  const [site,       setSite]       = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [clearing,   setClearing]   = useState(false);
  const [clearMsg,   setClearMsg]   = useState(null);
  const [err,        setErr]        = useState('');
  const [page,       setPage]       = useState(TOWER_PAGE);
  const [stats,      setStats]      = useState(null);

  // Load tower sites
  useEffect(() => {
    apiFetch(`${API_BASE}/crash-sites`)
      .then(d => {
        const tower = (d.sites || d || []).filter(s =>
          String(s.gameUrl || '').toLowerCase().includes('/tower'));
        setSites(tower);
        if (tower.length) setSiteId(tower[0].id);
      })
      .catch(() => {});
  }, []);

  // Load history for selected site
  const loadHistory = useCallback(async () => {
    if (!siteId) return;
    setLoading(true); setErr('');
    try {
      const d = await apiFetch(`${API_BASE}/crash-sites/${siteId}/tower-history?limit=200&refresh=1`);
      setHistory(d.history || []);
      setSite(d.site || null);

      // compute local stats
      const rows = d.history || [];
      const wins = rows.filter(r => r.outcome === 'WIN').length;
      const total = rows.length;
      const byPos = [0, 0, 0, 0];
      const byPosTotal = [0, 0, 0, 0];
      rows.forEach(r => {
        const f = String(r.forecast || '');
        const a = String(r.actual || '');
        for (let i = 0; i < 4; i++) {
          if (f[i] && a[i]) { byPosTotal[i]++; if (f[i] === a[i]) byPos[i]++; }
        }
      });
      setStats({ wins, total, byPos, byPosTotal });
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [siteId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const clearRounds = async () => {
    if (!siteId || !adminSecret) return;
    setClearing(true); setClearMsg(null);
    try {
      const d = await apiFetch(
        `${API_BASE}/crash-sites/${siteId}/rounds`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret } }
      );
      setClearMsg({ ok: true, text: `Cleared ${d.deleted || 0} rounds` });
      setHistory([]);
      setStats(null);
    } catch (e) {
      setClearMsg({ ok: false, text: e.message });
    }
    setClearing(false);
  };

  const nextForecast = useMemo(() => {
    // The most recent row's forecast predicts the next real round
    if (!history.length) return null;
    const last = history[history.length - 1];
    return last?.forecast || null;
  }, [history]);

  return (
    <div>
      {/* Site selector */}
      {sites.length > 1 && (
        <div style={{ marginBottom: 14, display: 'flex', gap: 6 }}>
          {sites.map(s => (
            <button key={s.id} onClick={() => { setSiteId(s.id); setPage(TOWER_PAGE); }}
              style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: siteId === s.id ? '#00d4ff18' : '#0d0d0d',
                color: siteId === s.id ? '#00d4ff' : '#555',
                border: `1px solid ${siteId === s.id ? '#00d4ff44' : '#1e1e1e'}` }}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {sites.length === 0 && !loading && (
        <div style={{ color: '#444', fontSize: 13, textAlign: 'center', padding: '32px 0' }}>
          No Tower sites found. Add a tower game URL in collector settings.
        </div>
      )}

      {/* Next forecast box */}
      {nextForecast && (
        <div style={{ background: '#0a0f0a', border: '1px solid #00ff8830', borderRadius: 10,
          padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#00ff8888', letterSpacing: 1, marginBottom: 8 }}>
            NEXT ROUND FORECAST
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TowerSeq seq={nextForecast.slice(0, 4)} />
            <span style={{ fontSize: 11, color: '#555' }}>positions 1–4</span>
          </div>
          <div style={{ fontSize: 11, color: '#445', marginTop: 6 }}>
            Based on {history.length} training rounds · pure frequency model
          </div>
        </div>
      )}

      {/* Stats row */}
      {stats && stats.total > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', value: stats.total, color: '#aaa' },
            { label: 'Full Match', value: stats.wins, color: '#00ff88' },
            { label: 'Accuracy', value: `${Math.round(stats.wins / stats.total * 100)}%`, color: stats.wins/stats.total >= 0.33 ? '#00ff88' : '#ff6b6b' },
          ].map(p => (
            <div key={p.label} style={{ background: '#0d0d0d', border: '1px solid #1a1a1a',
              borderRadius: 8, padding: '6px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 900, color: p.color, fontFamily: 'monospace' }}>{p.value}</div>
              <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{p.label}</div>
            </div>
          ))}
          {/* Per-position accuracy */}
          {stats.byPos.map((hits, i) => {
            const tot = stats.byPosTotal[i];
            const pct = tot > 0 ? Math.round(hits / tot * 100) : 0;
            return (
              <div key={i} style={{ background: '#0d0d0d', border: '1px solid #1a1a1a',
                borderRadius: 8, padding: '6px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: pct >= 40 ? '#00ff88' : pct >= 30 ? '#ffd84d' : '#ff6b6b', fontFamily: 'monospace' }}>{pct}%</div>
                <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>Pos {i + 1}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Clear button (admin only) */}
      {adminSecret && siteId && (
        <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={clearRounds} disabled={clearing}
            style={{ background: '#ff456010', border: '1px solid #ff456033', borderRadius: 6,
              padding: '6px 14px', fontSize: 12, fontWeight: 800, color: '#ff6b6b', cursor: 'pointer' }}>
            {clearing ? 'Clearing...' : '✕ Clear Rounds & History'}
          </button>
          <button onClick={loadHistory} disabled={loading}
            style={{ background: '#0d0d0d', border: '1px solid #1e1e1e', borderRadius: 6,
              padding: '6px 14px', fontSize: 12, color: '#555', cursor: 'pointer' }}>
            {loading ? '...' : '↻ Refresh'}
          </button>
          {clearMsg && (
            <span style={{ fontSize: 12, fontWeight: 700, color: clearMsg.ok ? '#00ff88' : '#ff6b6b' }}>
              {clearMsg.ok ? '✓' : '✗'} {clearMsg.text}
            </span>
          )}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: '#ff6b6b', marginBottom: 10 }}>⚠ {err}</div>}
      {loading && <div style={{ fontSize: 12, color: '#444', textAlign: 'center', padding: '24px 0' }}>Loading tower history...</div>}

      {/* History table */}
      {!loading && history.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr 60px 60px',
            gap: 8, padding: '0 12px', marginBottom: 4 }}>
            {['Round', 'Forecast', 'Actual', 'Hits', 'Result'].map(h => (
              <span key={h} style={{ fontSize: 10, fontWeight: 800, color: '#444', letterSpacing: 0.5 }}>{h}</span>
            ))}
          </div>
          {[...history].reverse().slice(0, page).map(row => (
            <div key={row.roundId}
              style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr 60px 60px',
                gap: 8, alignItems: 'center', background: '#0a0a0a',
                border: `1px solid ${row.outcome === 'WIN' ? '#00ff8820' : '#191919'}`,
                borderRadius: 7, padding: '7px 12px' }}>
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#555' }}>
                #{Number(row.roundId).toLocaleString()}
              </span>
              <TowerSeq seq={row.forecast || ''} />
              <TowerSeq seq={row.actual || ''} dim />
              <span style={{ fontSize: 12, fontWeight: 900, fontFamily: 'monospace',
                color: row.matches === 4 ? '#00ff88' : row.matches >= 2 ? '#ffd84d' : '#555' }}>
                {row.matches}/4
              </span>
              <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 6px', borderRadius: 4, textAlign: 'center',
                background: row.outcome === 'WIN' ? '#00ff8815' : '#ff456010',
                color: row.outcome === 'WIN' ? '#00ff88' : '#ff6b6b' }}>
                {row.outcome}
              </span>
            </div>
          ))}
        </div>
      )}
      {!loading && history.length > page && (
        <button onClick={() => setPage(p => p + TOWER_PAGE)}
          style={{ marginTop: 10, width: '100%', background: 'none', border: '1px solid #1e1e1e',
            borderRadius: 7, padding: '8px', fontSize: 12, color: '#555', cursor: 'pointer' }}>
          Show more ({history.length - page} left)
        </button>
      )}
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const CARD_STYLE = {
  position: 'relative', background: '#0a0a0a', border: '1px solid #1a1a1a',
  borderRadius: 12, padding: '16px 16px 14px 20px', overflow: 'hidden',
};
const ACCENT_BAR = {
  position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: '12px 0 0 12px',
};
const CARD_HEADER = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
};
const BADGE_STYLE = {
  fontSize: 10, fontWeight: 900, letterSpacing: 0.5, padding: '3px 8px',
  borderRadius: 5, flexShrink: 0,
};
const CHIP_STYLE = {
  fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
  background: 'rgba(255,255,255,0.05)', color: '#666', border: '1px solid #222',
};

// ─── Dashboard stat bar ───────────────────────────────────────────────────────
function StatBar({ report }) {
  const h      = report?.history || [];
  const wins   = h.filter(r => r.result === 'WIN').length;
  const missed = h.filter(r => r.result === 'FAILED').length;
  const wr     = wins + missed > 0 ? Math.round(wins / (wins + missed) * 100) : null;
  const items  = [
    { label: 'Rounds', value: (report?.roundsLoaded || 0).toLocaleString() },
    { label: 'Round', value: report?.asOfRound ? `#${Number(report.asOfRound).toLocaleString()}` : '—' },
    { label: 'Active', value: report?.activeLockCount ?? '—', highlight: true },
    { label: 'Live', value: report?.inWindowCount ?? '—', color: '#00ff88' },
    ...(wr != null ? [{ label: 'Win Rate', value: `${wr}%`, color: wr >= 50 ? '#00ff88' : '#ff6b6b' }] : []),
    { label: 'Regime', value: report?.dominantRegime || '—' },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {items.map(item => (
        <div key={item.label} style={{ background: '#0a0a0a', border: '1px solid #1a1a1a',
          borderRadius: 8, padding: '7px 14px', textAlign: 'center', minWidth: 64 }}>
          <div style={{ fontSize: 14, fontWeight: 900, fontFamily: 'monospace',
            color: item.color || (item.highlight ? '#00d4ff' : '#ccc') }}>{item.value}</div>
          <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{item.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Main PredictionSection ───────────────────────────────────────────────────
export default function PredictionSection({ rounds = [], adminSecret = '' }) {
  const [report,     setReport]     = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState('');
  const [live,       setLive]       = useState(true);
  const [tab,        setTab]        = useState('predict');
  const seqRef   = useRef(0);
  const repRef   = useRef(null);
  const lagRef   = useRef(0);

  const latestRound = useMemo(() => {
    const last = rounds?.[rounds.length - 1];
    return Number(last?.roundId || last?.id || 0);
  }, [rounds]);

  useEffect(() => { repRef.current = report; }, [report]);

  const load = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (silent) setRefreshing(true);
    else if (!repRef.current) setLoading(true);
    try {
      const data = await apiFetch(ORACLE_URL);
      if (seq !== seqRef.current) return;
      setReport(data); setError('');
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e.message || 'Oracle engine error');
    } finally {
      if (seq === seqRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(id);
  }, [live, load]);

  // Sync if round lag detected
  useEffect(() => {
    if (!live || !report || loading || refreshing) return;
    const asOf = Number(report?.asOfRound || 0);
    if (!latestRound || !asOf || latestRound - asOf < 3) return;
    const now = Date.now();
    if (now - lagRef.current < REFRESH_MS) return;
    lagRef.current = now;
    load(true);
  }, [live, report, loading, refreshing, latestRound, load]);

  useEffect(() => {
    const fn = () => load(true);
    window.addEventListener('predictions:cache-cleared', fn);
    return () => window.removeEventListener('predictions:cache-cleared', fn);
  }, [load]);

  const targets = report?.targets || [];
  const TABS = [
    { id: 'predict', label: 'PREDICTIONS' },
    { id: 'tower',   label: 'TOWERS' },
    { id: 'history', label: 'HISTORY' },
  ];

  return (
    <section style={{ maxWidth: 960, margin: '0 auto', padding: '16px 12px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#00ff8815',
            border: '1px solid #00ff8833', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16 }}>◎</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 900, color: '#eee', letterSpacing: 0.5 }}>
              ORACLE PREDICTOR
              <span style={{ fontSize: 10, fontWeight: 700, color: '#00ff88', marginLeft: 6,
                background: '#00ff8815', border: '1px solid #00ff8833', borderRadius: 4,
                padding: '1px 5px' }}>V3</span>
            </div>
            <div style={{ fontSize: 11, color: '#555' }}>
              {report?.engineVersion || 'oracle_v3'} · Pure frequency model
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setLive(v => !v)}
            style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 800, cursor: 'pointer',
              background: live ? '#00ff8815' : '#1a1a1a', color: live ? '#00ff88' : '#555',
              border: `1px solid ${live ? '#00ff8840' : '#222'}` }}>
            {live ? `● LIVE ${REFRESH_MS / 1000}s` : '○ PAUSED'}
          </button>
          <button onClick={() => load(true)} disabled={loading || refreshing}
            style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
              background: '#0d0d0d', border: '1px solid #1e1e1e', color: '#666' }}>
            {refreshing ? '↻' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Stat bar */}
      {report && <StatBar report={report} />}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14, background: '#0a0a0a',
        border: '1px solid #1a1a1a', borderRadius: 9, padding: 3 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 12, fontWeight: 800,
              cursor: 'pointer', border: 'none', transition: 'all 0.2s',
              background: tab === t.id ? '#161616' : 'transparent',
              color: tab === t.id ? '#eee' : '#555',
              boxShadow: tab === t.id ? '0 1px 4px #0008' : 'none' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ background: '#ff456010', border: '1px solid #ff456033', borderRadius: 8,
          padding: '10px 14px', fontSize: 12, color: '#ff6b6b', marginBottom: 12 }}>
          ⚠ {error}{report ? ' — showing last snapshot.' : ''}
        </div>
      )}

      {/* Content */}
      {loading && !report ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 12, padding: '48px 0', color: '#444', fontSize: 13 }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid #00ff8833',
            borderTopColor: '#00ff88', animation: 'spin 0.8s linear infinite' }}/>
          Initializing Oracle engine...
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      ) : tab === 'predict' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {targets.map(t => <ForecastCard key={t.label} target={t} />)}
        </div>
      ) : tab === 'tower' ? (
        <TowerTab adminSecret={adminSecret} />
      ) : (
        <OracleHistory report={report} />
      )}
    </section>
  );
}