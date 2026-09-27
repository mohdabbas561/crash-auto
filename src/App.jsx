import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRounds } from './hooks/useRounds';
import GapTracker from './components/GapTracker';
import GlobalStats from './components/GlobalStats';
import RecentCrashes from './components/RecentCrashes';
import ActivityLog from './components/ActivityLog';
import ControlPanel from './components/ControlPanel';
import MultiplierChart from './components/MultiplierChart';
import WalletBot from './components/WalletBot';
import PredictionSection from './components/PredictionSection';
import './App.css';

const API_URL    = process.env.REACT_APP_API_URL || '';
const ADMIN_CODE = process.env.REACT_APP_ADMIN_CODE || 'iamnoob';
const ADMIN_SEC  = process.env.REACT_APP_ADMIN_SECRET || '';
const BASE_TABS  = ['HOME', 'AI PREDICTOR', 'AUTO BOT'];
// ─── ADMIN AUTH POPUP ─────────────────────────────────────────────────────────
function AdminAuthPopup({ onSuccess, onClose }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    if (value.trim() === ADMIN_CODE) { onSuccess(); }
    else {
      setError('Wrong code'); setShake(true); setValue('');
      setTimeout(() => setShake(false), 500);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#111', border: '1px solid #2a2a2a', borderTop: '2px solid #ff4560', borderRadius: 12, padding: '26px 28px', width: 300, animation: shake ? 'shake 0.4s' : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
          <span style={{ fontSize: 20 }}>🔒</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 900, color: '#ff4560' }}>ADMIN ACCESS</div>
            <div style={{ fontSize: 10, color: '#444' }}>Session only · resets on refresh</div>
          </div>
        </div>
        <input ref={inputRef} type="password" value={value}
          onChange={e => { setValue(e.target.value); setError(''); }}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
          placeholder="Admin code"
          style={{ width: '100%', background: '#0a0a0a', border: `1px solid ${error ? '#ff4560' : '#222'}`, borderRadius: 7, padding: '9px 12px', fontSize: 13, color: '#fff', fontFamily: 'monospace', outline: 'none', marginBottom: 8, boxSizing: 'border-box' }}
        />
        {error && <div style={{ fontSize: 11, color: '#ff4560', fontWeight: 700, marginBottom: 8 }}>✗ {error}</div>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={submit} style={{ flex: 1, background: '#ff456018', border: '1px solid #ff456066', borderRadius: 7, padding: '8px', fontSize: 12, fontWeight: 900, color: '#ff4560', cursor: 'pointer' }}>UNLOCK</button>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid #222', borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 700, color: '#555', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>
    </div>
  );
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
function AdminPanel() {
  const [histConfirm,  setHistConfirm]  = useState(false);
  const [histResult,   setHistResult]   = useState(null);
  const [histClearing, setHistClearing] = useState(false);
  const [locksConfirm, setLocksConfirm] = useState(false);
  const [locksResult,  setLocksResult]  = useState(null);
  const [locksClearing,setLocksClearing]= useState(false);

  const [newCode,     setNewCode]     = useState('');
  const [newNote,     setNewNote]     = useState('');
  const [maxUses,     setMaxUses]     = useState('1');
  const [duration,    setDuration]    = useState('24');
  const [durUnit,     setDurUnit]     = useState('hours');
  const [creating,    setCreating]    = useState(false);
  const [createMsg,   setCreateMsg]   = useState(null);
  const [codes,        setCodes]        = useState([]);
  const [codesLoading, setCodesLoading] = useState(true);
  const [deletingId,   setDeletingId]   = useState(null);

  const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SEC };

  const requestAdminJson = async (url, options = {}) => {
    const res = await fetch(url, options);
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (!data || typeof data !== 'object') {
      if (raw.trim().startsWith('<')) throw new Error('API URL points to frontend HTML, not backend API');
      throw new Error('Invalid API response');
    }
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const r = await fetch(`${API_URL}/access/list`, { headers: { 'x-admin-secret': ADMIN_SEC } });
      const d = await r.json();
      if (d.ok) setCodes(d.codes || []);
    } catch {}
    setCodesLoading(false);
  }, []);

  useEffect(() => { loadCodes(); }, [loadCodes]);
  useEffect(() => {
    const id = setInterval(loadCodes, 30000);
    return () => clearInterval(id);
  }, [loadCodes]);

  const clearHistory = async () => {
    setHistClearing(true);
    try {
      const d = await requestAdminJson(`${API_URL}/clear-history`, { method: 'DELETE', headers: adminHeaders });
      setHistResult({ ok: true, msg: `Prediction history cleared (${d.predictionsCleared || 0} rows)` });
    } catch (e) {
      setHistResult({ ok: false, msg: e.message });
    }
    setHistClearing(false);
    setHistConfirm(false);
  };

  const clearLocks = async () => {
    setLocksClearing(true);
    try {
      const d = await requestAdminJson(`${API_URL}/clear-locks`, { method: 'DELETE', headers: adminHeaders });
      const total = (d.consensusLocksCleared || 0) + (d.advLocksCleared || 0) + (d.engineLocksCleared || 0);
      setLocksResult({ ok: true, msg: `All locks cleared (${total} rows). Engine will compute fresh windows.` });
    } catch (e) {
      setLocksResult({ ok: false, msg: e.message });
    }
    setLocksClearing(false);
    setLocksConfirm(false);
  };

  const createCode = async () => {
    if (!newCode.trim()) return;
    setCreating(true); setCreateMsg(null);
    const mult = { minutes: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000 }[durUnit] ?? 3600;
    const expiresAt = new Date(Date.now() + Number(duration) * mult * 1000).toISOString();
    try {
      const r = await fetch(`${API_URL}/access/create`, {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ code: newCode.trim(), expiresAt, note: newNote.trim(), maxUses: parseInt(maxUses) || 1 }),
      });
      const d = await r.json();
      if (d.ok) { setCreateMsg({ ok: true, msg: `Code "${newCode}" created ✓` }); setNewCode(''); setNewNote(''); loadCodes(); }
      else setCreateMsg({ ok: false, msg: d.error });
    } catch (e) { setCreateMsg({ ok: false, msg: e.message }); }
    setCreating(false);
  };

  const deleteCode = async (id) => {
    setDeletingId(id);
    try {
      await fetch(`${API_URL}/access/${id}`, { method: 'DELETE', headers: { 'x-admin-secret': ADMIN_SEC } });
      loadCodes();
    } catch {}
    setDeletingId(null);
  };

  const formatExpiry = (exp) => {
    const d = new Date(exp);
    const diff = d - Date.now();
    if (diff <= 0) return { text: 'EXPIRED', color: '#ff4560' };
    const s = Math.floor(diff / 1000);
    if (s < 3600)  return { text: `${Math.floor(s/60)}m left`, color: '#ffd84d' };
    if (s < 86400) return { text: `${Math.floor(s/3600)}h left`, color: '#00d4ff' };
    return { text: `${Math.floor(s/86400)}d left`, color: '#00ff88' };
  };

  const S = {
    card:  { background: '#0a0a0a', border: '1px solid #1e1e1e', borderRadius: 10, padding: '16px 18px', marginBottom: 12 },
    label: { fontSize: 11, fontWeight: 800, color: '#777', letterSpacing: 1, marginBottom: 8 },
    desc:  { fontSize: 12, color: '#555', marginBottom: 12 },
    input: { background: '#111', border: '1px solid #2a2a2a', borderRadius: 7, padding: '8px 11px', fontSize: 13, color: '#fff', outline: 'none', fontFamily: 'monospace' },
    btn:   (col) => ({ background: col + '18', border: `1px solid ${col}55`, borderRadius: 7, padding: '8px 14px', fontSize: 12, fontWeight: 800, color: col, cursor: 'pointer' }),
  };

  return (
    <main style={{ maxWidth: 680, margin: '32px auto', padding: '0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <span style={{ fontSize: 22 }}>⚙️</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 900, color: '#ff4560' }}>ADMIN PANEL</div>
          <div style={{ fontSize: 11, color: '#444' }}>Session only — gone on refresh</div>
        </div>
      </div>

      {/* Clear prediction history */}
      <div style={S.card}>
        <div style={S.label}>CLEAR PREDICTION HISTORY</div>
        <div style={S.desc}>Deletes all resolved prediction records (wins/losses/early). Win rate stats reset to zero.</div>
        {!histConfirm && !histResult && <button onClick={() => setHistConfirm(true)} style={S.btn('#ff8c42')}>CLEAR HISTORY</button>}
        {histConfirm && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={clearHistory} disabled={histClearing} style={S.btn('#ff8c42')}>{histClearing ? 'Working...' : 'CONFIRM CLEAR HISTORY'}</button>
            <button onClick={() => setHistConfirm(false)} style={S.btn('#888')}>Cancel</button>
          </div>
        )}
        {histResult && (
          <div style={{ fontSize: 12, fontWeight: 700, color: histResult.ok ? '#00ff88' : '#ff4560' }}>
            {histResult.ok ? 'OK' : 'ERR'} {histResult.msg}
            {histResult.ok && <button onClick={() => setHistResult(null)} style={{ marginLeft: 10, background: 'none', border: '1px solid #333', borderRadius: 4, padding: '2px 7px', fontSize: 10, color: '#666', cursor: 'pointer' }}>dismiss</button>}
          </div>
        )}

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #1f1f1f' }}>
          <div style={{ ...S.label, marginBottom: 6 }}>RESET LOCK WINDOWS</div>
          <div style={{ ...S.desc, marginBottom: 8 }}>Clears all lock tables so the engine computes brand-new windows from current data.</div>
          {!locksConfirm && !locksResult && (
            <button onClick={() => setLocksConfirm(true)} style={S.btn('#00d4ff')}>CLEAR ALL LOCKS</button>
          )}
          {locksConfirm && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={clearLocks} disabled={locksClearing} style={S.btn('#00d4ff')}>
                {locksClearing ? 'Working...' : 'CONFIRM CLEAR LOCKS'}
              </button>
              <button onClick={() => setLocksConfirm(false)} style={S.btn('#888')}>Cancel</button>
            </div>
          )}
          {locksResult && (
            <div style={{ fontSize: 12, fontWeight: 700, color: locksResult.ok ? '#00ff88' : '#ff4560' }}>
              {locksResult.ok ? 'OK' : 'ERR'} {locksResult.msg}
              {locksResult.ok && <button onClick={() => setLocksResult(null)} style={{ marginLeft: 10, background: 'none', border: '1px solid #333', borderRadius: 4, padding: '2px 7px', fontSize: 10, color: '#666', cursor: 'pointer' }}>dismiss</button>}
            </div>
          )}
        </div>
      </div>

      {/* Access codes */}
      <div style={S.card}>
        <div style={S.label}>🔑 CREATE SITE ACCESS CODE</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Access code (e.g. user123abc)"
            style={{ ...S.input, width: '100%', boxSizing: 'border-box' }} />
          <input value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="Note (optional)"
            style={{ ...S.input, width: '100%', boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#777' }}>Max uses:</span>
            <input type="number" value={maxUses} onChange={e => setMaxUses(e.target.value)} min="1" max="999" style={{ ...S.input, width: 60 }} />
            <span style={{ fontSize: 11, color: '#555' }}>(1 = single use)</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#777' }}>Expires in:</span>
            <input type="number" value={duration} onChange={e => setDuration(e.target.value)} min="1" style={{ ...S.input, width: 64 }} />
            <select value={durUnit} onChange={e => setDurUnit(e.target.value)} style={{ ...S.input, cursor: 'pointer' }}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
            </select>
            <button onClick={createCode} disabled={creating || !newCode.trim()} style={{ ...S.btn('#00ff88'), marginLeft: 4 }}>
              {creating ? 'Creating...' : '+ CREATE'}
            </button>
          </div>
          {createMsg && <div style={{ fontSize: 12, fontWeight: 700, color: createMsg.ok ? '#00ff88' : '#ff4560' }}>{createMsg.ok ? '✓' : '✗'} {createMsg.msg}</div>}
        </div>
      </div>

      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={S.label}>📋 ACTIVE ACCESS CODES</div>
          <button onClick={loadCodes} style={{ background: 'none', border: '1px solid #222', borderRadius: 5, padding: '3px 9px', fontSize: 10, color: '#666', cursor: 'pointer' }}>↻ refresh</button>
        </div>
        {codesLoading ? (
          <div style={{ fontSize: 12, color: '#555', textAlign: 'center', padding: 16 }}>Loading...</div>
        ) : codes.length === 0 ? (
          <div style={{ fontSize: 12, color: '#444', textAlign: 'center', padding: 16 }}>No access codes yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 60px 90px 90px auto', gap: 8, fontSize: 10, fontWeight: 800, color: '#555', padding: '0 4px', letterSpacing: 0.5 }}>
              <span>CODE / NOTE</span><span>IP</span><span>USES</span><span>CREATED</span><span>EXPIRY</span><span></span>
            </div>
            {codes.map(row => {
              const expiry = formatExpiry(row.expires_at);
              const expired = expiry.color === '#ff4560';
              return (
                <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 60px 90px 90px auto', gap: 8, alignItems: 'center', background: expired ? '#ff45600a' : '#111', border: `1px solid ${expired ? '#ff456033' : '#1e1e1e'}`, borderRadius: 7, padding: '8px 10px' }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#ddd', fontFamily: 'monospace' }}>{row.code}</div>
                    {row.note && <div style={{ fontSize: 10, color: '#555' }}>{row.note}</div>}
                  </div>
                  <div style={{ fontSize: 10, color: '#666', fontFamily: 'monospace' }}>{row.ip || '—'}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: row.use_count >= row.max_uses ? '#ff4560' : '#aaa' }}>{row.use_count}/{row.max_uses}</div>
                  <div style={{ fontSize: 10, color: '#666' }}>{new Date(row.created_at).toLocaleDateString()}</div>
                  <div><span style={{ fontSize: 11, fontWeight: 800, color: expiry.color }}>{expiry.text}</span></div>
                  <button onClick={() => deleteCode(row.id)} disabled={deletingId === row.id}
                    style={{ background: '#ff456010', border: '1px solid #ff456033', borderRadius: 5, padding: '4px 8px', fontSize: 11, color: '#ff4560', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {deletingId === row.id ? '...' : '✕ Del'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

const PREDICTOR_TARGETS = [1.5, 2, 3, 5, 10, 20, 50];

function CrashPredictor({ rounds, status, onRefresh }) {
  const [windowSize, setWindowSize] = useState(500);
  const [target, setTarget] = useState(2);
  const [manualValue, setManualValue] = useState('');
  const sample = rounds.slice(-windowSize);
  const values = sample.map((round) => Number(round.multiplier)).filter(Number.isFinite);
  const hits = values.filter((value) => value >= target).length;
  // Jeffreys smoothing avoids reporting 0% or 100% from a small sample.
  const estimate = values.length ? (hits + 0.5) / (values.length + 1) : 0;
  const baselineHits = values.filter((value) => value >= 2).length;
  const baseline = values.length ? (baselineHits + 0.5) / (values.length + 1) : 0;
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const targetGap = (() => {
    let gap = 0;
    for (let i = values.length - 1; i >= 0 && values[i] < target; i--) gap++;
    return gap;
  })();
  const confidence = Math.min(95, Math.round(100 * values.length / (values.length + 120)));
  const nextRound = rounds.length ? rounds[rounds.length - 1].roundId + 1 : null;
  const applyManual = () => {
    const parsed = Number(manualValue);
    if (Number.isFinite(parsed) && parsed >= 1) {
      setTarget(parsed);
    }
  };

  return (
    <main className="predictor-page">
      <div className="predictor-heading">
        <div>
          <div className="predictor-eyebrow"><span className="predictor-pulse" /> DCF CRASH · LIVE ANALYSIS</div>
          <h2>AI crash predictor</h2>
          <p>Read the history. Set a target. Keep the odds in view.</p>
        </div>
        <button className="predictor-refresh" onClick={onRefresh}>↻ Refresh data</button>
      </div>

      <div className="predictor-notice"><span>ⓘ</span><div><strong>Each round is independent.</strong> History can describe past frequencies, but cannot know or guarantee the next crash. Treat these numbers as estimates, not betting advice.</div></div>

      <section className="predictor-controls">
        <div className="predictor-control-label">ANALYSIS WINDOW</div>
        <div className="predictor-choice-row">
          {[100, 500, 1000, 5000].map((size) => <button key={size} className={windowSize === size ? 'selected' : ''} onClick={() => setWindowSize(size)}>{size.toLocaleString()} rounds</button>)}
        </div>
        <div className="predictor-control-label target-label">TARGET MULTIPLIER</div>
        <div className="predictor-choice-row">
          {PREDICTOR_TARGETS.map((value) => <button key={value} className={target === value ? 'selected' : ''} onClick={() => setTarget(value)}>{value}×</button>)}
          <label className="predictor-custom">Custom <input value={manualValue} onChange={(event) => setManualValue(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && applyManual()} type="number" min="1" step="0.1" placeholder="1.0" /><button onClick={applyManual}>Set</button></label>
        </div>
      </section>

      {values.length === 0 ? (
        <section className="predictor-empty"><div className="predictor-empty-icon">◷</div><h3>{status === 'loading' ? 'Connecting to round history…' : 'Waiting for round data'}</h3><p>Connect the collector API to see live DCF crash history and estimates.</p><span>Configure REACT_APP_API_URL to point at the crash collector.</span></section>
      ) : (
        <>
          <section className="predictor-grid">
            <article className="predictor-card predictor-main-card">
              <div className="predictor-card-top"><span>HISTORICAL HIT RATE</span><span className="predictor-live-tag">● LIVE DATA</span></div>
              <div className="predictor-big-number">{(estimate * 100).toFixed(1)}<small>%</small></div>
              <div className="predictor-card-copy">of observed rounds reached <strong>{target}×</strong> or above</div>
              <div className="predictor-meter"><span style={{ width: `${Math.min(100, estimate * 100)}%` }} /></div>
              <div className="predictor-card-foot"><span>{hits.toLocaleString()} hits</span><span>{values.length.toLocaleString()} rounds sampled</span></div>
            </article>
            <article className="predictor-card predictor-next-card">
              <div className="predictor-card-top"><span>NEXT ROUND CONTEXT</span><span>#{nextRound || '—'}</span></div>
              <div className="predictor-next-title">{(estimate * 100).toFixed(1)}% historical chance</div>
              <div className="predictor-card-copy">to reach {target}×, based on this window</div>
              <div className="predictor-prob-row"><span>Under {target}×</span><strong>{((1 - estimate) * 100).toFixed(1)}%</strong></div>
              <div className="predictor-card-foot"><span>Smoothed estimate</span><span>Not a live round prediction</span></div>
            </article>
            <article className="predictor-card">
              <div className="predictor-card-top"><span>SAMPLE CONFIDENCE</span><span>ⓘ</span></div>
              <div className="predictor-stat-number">{confidence}<small>%</small></div>
              <div className="predictor-card-copy">data volume indicator · {values.length.toLocaleString()} valid results</div>
              <div className="predictor-confidence-track"><span style={{ width: `${confidence}%` }} /></div>
              <div className="predictor-card-foot"><span>{values.length < 100 ? 'Early sample' : values.length < 500 ? 'Building sample' : 'Useful sample'}</span><span>More rounds improve stability</span></div>
            </article>
          </section>

          <section className="predictor-lower-grid">
            <article className="predictor-panel">
              <div className="predictor-panel-title"><div><span>01</span><h3>Recent crash history</h3></div><span className="predictor-muted">Latest {Math.min(30, values.length)} rounds</span></div>
              <div className="predictor-history">{sample.slice(-30).reverse().map((round, index) => {
                const value = Number(round.multiplier) || 0;
                const color = value < 2 ? 'low' : value < 10 ? 'mid' : 'high';
                return <div className={`predictor-history-chip ${color}`} key={`${round.roundId}-${index}`} title={`Round #${round.roundId}`}><small>#{round.roundId}</small>{value.toFixed(2)}×</div>;
              })}</div>
              <div className="predictor-legend"><span><i className="low" />Under 2×</span><span><i className="mid" />2–9.99×</span><span><i className="high" />10×+</span></div>
            </article>
            <article className="predictor-panel predictor-stats-panel">
              <div className="predictor-panel-title"><div><span>02</span><h3>Window insights</h3></div></div>
              <div className="predictor-insight-row"><span>Current round</span><strong>#{rounds.at(-1)?.roundId ?? '—'}</strong></div>
              <div className="predictor-insight-row"><span>Average crash</span><strong>{average.toFixed(2)}×</strong></div>
              <div className="predictor-insight-row"><span>Median crash</span><strong>{median.toFixed(2)}×</strong></div>
              <div className="predictor-insight-row"><span>Rounds since {target}×</span><strong>{targetGap}</strong></div>
              <div className="predictor-insight-row"><span>2× hit rate in window</span><strong>{(baseline * 100).toFixed(1)}%</strong></div>
              <div className="predictor-insight-row"><span>Data status</span><strong className="predictor-connected">● Connected</strong></div>
            </article>
          </section>
          <div className="predictor-footer-note">Method: Jeffreys-smoothed frequency from the selected recent window. Historical outcomes do not change the odds of a future independent round.</div>
        </>
      )}
    </main>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab,     setActiveTab]     = useState('HOME');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [showAuthPopup, setShowAuthPopup] = useState(false);
  const [menuOpen,      setMenuOpen]      = useState(false);

  const clickTimesRef = useRef([]);

  const { rounds, gaps, stats, log, status, isPolling, manualRefresh } = useRounds();

  const TABS = adminUnlocked ? [...BASE_TABS, 'ADMIN'] : BASE_TABS;

  const handleLiveBadgeClick = () => {
    const now = Date.now();
    clickTimesRef.current = [...clickTimesRef.current.filter(t => now - t < 800), now];
    if (clickTimesRef.current.length >= 3) {
      clickTimesRef.current = [];
      if (adminUnlocked) setActiveTab('ADMIN');
      else setShowAuthPopup(true);
    }
  };

  const handleAuthSuccess = () => {
    setAdminUnlocked(true);
    setShowAuthPopup(false);
    setActiveTab('ADMIN');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="header-logo">🤖</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="header-title">CRASH BOT PRO</h1>
            <p className="header-sub">On-Chain Crash Tracker</p>
          </div>

          <div className="header-tabs desktop-tabs">
            {TABS.map(tab => (
              <button key={tab}
                className={`tab-btn ${activeTab === tab ? 'active' : ''} ${tab === 'ADMIN' ? 'tab-admin' : ''}`}
                onClick={() => setActiveTab(tab)}>
                {tab === 'ADMIN' ? '⚙️ ADMIN' : tab}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span
              className={`live-badge ${isPolling ? 'live' : ''}`}
              onClick={handleLiveBadgeClick}
              style={{ cursor: 'pointer', userSelect: 'none' }}
              title="Triple-click for admin"
            >
              {isPolling ? '● LIVE' : '○ OFFLINE'}
            </span>

            <button
              className="mobile-menu-btn"
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Menu"
            >
              <span style={{ fontSize: 18 }}>{menuOpen ? '✕' : '☰'}</span>
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="mobile-dropdown">
            {TABS.map(tab => (
              <button key={tab}
                className={`mobile-tab-btn ${activeTab === tab ? 'mobile-tab-active' : ''} ${tab === 'ADMIN' ? 'tab-admin' : ''}`}
                onClick={() => { setActiveTab(tab); setMenuOpen(false); }}>
                {tab === 'ADMIN' ? '⚙️ ADMIN' : tab}
              </button>
            ))}
          </div>
        )}
      </header>

      {showAuthPopup && <AdminAuthPopup onSuccess={handleAuthSuccess} onClose={() => setShowAuthPopup(false)} />}

      {activeTab === 'AI PREDICTOR' && <CrashPredictor rounds={rounds} status={status} onRefresh={manualRefresh} />}

      {activeTab === 'HOME' && (
        <main className="main-grid">
          <div className="col col-left">
            <ControlPanel status={status} isPolling={isPolling} onRefresh={manualRefresh} />
            <GlobalStats stats={stats} />
          </div>
          <div className="col col-center">
            <RecentCrashes rounds={rounds} />
            <MultiplierChart rounds={rounds} totalTracked={stats.tracked} />
          </div>
          <div className="col col-right">
            <GapTracker gaps={gaps} />
            <ActivityLog log={log} />
          </div>
        </main>
      )}

      {activeTab === 'AUTO BOT' && (
        <main className="bot-grid">
          <div className="col col-bot-left"><WalletBot /></div>
          <div className="col col-bot-right">
            <GapTracker gaps={gaps} />
            <RecentCrashes rounds={rounds} />
            <MultiplierChart rounds={rounds} totalTracked={stats.tracked} />
            <ActivityLog log={log} />
          </div>
        </main>
      )}

      {activeTab === 'PREDICTION' && (
        <PredictionSection rounds={rounds} />
      )}

      {activeTab === 'ADMIN' && adminUnlocked && <AdminPanel />}
    </div>
  );
}


