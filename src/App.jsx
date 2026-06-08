import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useRounds } from './hooks/useRounds';
import GapTracker from './components/GapTracker';
import RecentCrashes from './components/RecentCrashes';
import ControlPanel from './components/ControlPanel';
import MultiplierChart from './components/MultiplierChart';
import WalletBot from './components/WalletBot';
import CrashLivePanel from './components/CrashLivePanel';
import PredictionSection, { clearPredictionReportCache } from './components/PredictionSection';
import { API_BASE } from './config/apiBase';
import './App.css';

const API_URL    = API_BASE;
const BASE_TABS  = ['HOME', 'PREDICTION', 'AUTO BOT'];
const ACCESS_KEY    = 'site_access_token';
const BYPASS_ACCESS = process.env.REACT_APP_BYPASS_ACCESS === 'true';
const PROD_API_FALLBACK = 'https://crash-collector-production-3672.up.railway.app';
const LOCAL_API_FALLBACK = 'http://localhost:8080';

function writeAccessToken(payload) {
  const value = JSON.stringify(payload);
  try { localStorage.setItem(ACCESS_KEY, value); } catch {}
  try { sessionStorage.setItem(ACCESS_KEY, value); } catch {}
}

function readAccessToken() {
  try {
    const fromLocal = localStorage.getItem(ACCESS_KEY);
    if (fromLocal) return fromLocal;
  } catch {}
  try {
    return sessionStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

function clearAccessToken() {
  try { localStorage.removeItem(ACCESS_KEY); } catch {}
  try { sessionStorage.removeItem(ACCESS_KEY); } catch {}
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { res, data, raw };
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Request timeout after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeApiRoot(input) {
  const raw = String(input || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

function extractApiHostname(apiRoot) {
  try {
    return new URL(apiRoot).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalApiRoot(apiRoot) {
  const host = extractApiHostname(apiRoot);
  return host === 'localhost' || host === '127.0.0.1';
}

function resolveClearTargets(activeApiRoot) {
  const targets = [];
  const addTarget = (base, label) => {
    const normalized = normalizeApiRoot(base);
    if (!normalized) return;
    if (targets.some((t) => t.base === normalized)) return;
    targets.push({ base: normalized, label });
  };

  const current = normalizeApiRoot(activeApiRoot);
  addTarget(current, 'Current');

  const prodBase = normalizeApiRoot(process.env.REACT_APP_PROD_API_URL || PROD_API_FALLBACK);
  const localBase = normalizeApiRoot(process.env.REACT_APP_LOCAL_API_URL || LOCAL_API_FALLBACK);

  if (isLocalApiRoot(current)) {
    addTarget(prodBase, 'Prod');
  } else if (current === prodBase) {
    addTarget(localBase, 'Local');
  } else {
    addTarget(prodBase, 'Prod');
    addTarget(localBase, 'Local');
  }

  return targets;
}

const BOOT_TERMS = [
  'Syncing collector heartbeat',
  'Rebuilding crash distribution',
  'Mapping gap pressure surface',
  'Validating round integrity',
  'Locking historical drift',
  'Aligning volatility regime',
  'Linking prediction channels',
  'Calibrating live signal stack',
  'Hydrating dashboard panels',
  'Verifying storage snapshots',
];

const DEFAULT_BOT_LIVE = {
  liveState: {
    connectionState: 'CONNECTING',
    connectionOpen: false,
    phase: 999,
    multiplier: 1,
    currentBar: null,
    pingMs: null,
    playerCount: 0,
    nextGameDelayMs: 0,
    countdownTotalMs: 0,
    betsClosingAt: null,
    trace: [],
    lastMessageAt: 0,
  },
  recentResolved: [],
  currentRoundId: null,
  targetMultiplier: '2',
  botRunning: false,
  canCashout: false,
  cashoutBusy: false,
  onCashout: null,
};

function BootLoaderOverlay({ attempt = 0 }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 900);
    return () => clearInterval(id);
  }, []);

  const lines = Array.from({ length: 8 }, (_, i) => {
    const idx = (tick + i) % BOOT_TERMS.length;
    return `${BOOT_TERMS[idx]} ... ${60 + ((tick + (i * 7)) % 39)}%`;
  });

  return (
    <div className="boot-loader-screen">
      <div className="boot-loader-frame">
        <div className="boot-loader-logo">AI</div>
        <div className="boot-loader-title">CRASH BOT PRO</div>
        <div className="boot-loader-sub">Booting dashboard and syncing live rounds...</div>
        <div className="boot-loader-meta">Attempt #{Math.max(1, Number(attempt) + 1)}</div>
        <div className="boot-loader-lines">
          {lines.map((line, idx) => (
            <div key={`${idx}-${line}`} className="boot-loader-line">{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── SITE ACCESS GATE ────────────────────────────────────────────────────────
function AccessGate({ onGranted }) {
  const [code,    setCode]    = useState('');
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [shake,   setShake]   = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    if (!code.trim()) return;
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/access/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        setError(`Server error ${res.status} — try again`);
        setShake(true); setCode('');
        setTimeout(() => setShake(false), 500);
        setLoading(false); return;
      }
      const data = await res.json();
      if (data.ok) {
        writeAccessToken({ code: code.trim(), expiresAt: data.expiresAt });
        onGranted();
      } else {
        const msg = data.reason === 'expired'  ? 'Access code expired'
                  : data.reason === 'used_up'  ? 'Code already used'
                  : data.reason === 'no_code'  ? 'Please enter a code'
                  : data.error                 ? `Server error: ${data.error}`
                  : 'Invalid access code';
        setError(msg);
        setShake(true); setCode('');
        setTimeout(() => setShake(false), 500);
      }
    } catch (e) {
      setError(`Cannot reach server: ${e.message}`);
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#080808', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
      <div style={{ width: 340, background: '#111', border: '1px solid #2a2a2a', borderTop: '3px solid #00ff88', borderRadius: 14, padding: '32px 28px', animation: shake ? 'shake 0.4s' : 'none' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🤖</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#00ff88' }}>CRASH BOT PRO</div>
          <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>Enter your access code to continue</div>
        </div>
        <input ref={inputRef} type="password" value={code}
          onChange={e => { setCode(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Access code"
          style={{ width: '100%', background: '#0a0a0a', border: `1px solid ${error ? '#ff4560' : '#2a2a2a'}`, borderRadius: 8, padding: '11px 14px', fontSize: 14, color: '#fff', fontFamily: 'monospace', outline: 'none', marginBottom: 8, boxSizing: 'border-box' }}
        />
        {error && <div style={{ fontSize: 11, color: '#ff4560', fontWeight: 700, marginBottom: 8 }}>✗ {error}</div>}
        <button onClick={submit} disabled={loading} style={{ width: '100%', background: '#00ff8818', border: '1px solid #00ff8866', borderRadius: 8, padding: '11px', fontSize: 13, fontWeight: 900, color: '#00ff88', cursor: 'pointer' }}>
          {loading ? 'Verifying...' : 'ENTER →'}
        </button>
      </div>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>
    </div>
  );
}

// ─── ADMIN AUTH POPUP ─────────────────────────────────────────────────────────
function AdminAuthPopup({ onSuccess, onClose }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const secret = value.trim();
    if (!secret) {
      setError('Admin secret required');
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }
    onSuccess(secret);
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
function AdminPanel({ adminSecret, onAuthExpired }) {
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
  const [codesError,   setCodesError]   = useState('');
  const [deletingId,   setDeletingId]   = useState(null);

  const adminHeaders = useMemo(
    () => ({ 'Content-Type': 'application/json', 'x-admin-secret': adminSecret }),
    [adminSecret]
  );
  const clearFrontendPredictionCaches = () => {
    clearPredictionReportCache();
  };
  const runtimeApiRoot = useMemo(() => {
    const configured = normalizeApiRoot(API_URL);
    if (configured) return configured;
    if (typeof window !== 'undefined') return normalizeApiRoot(window.location.origin);
    return '';
  }, []);
  const clearTargets = useMemo(() => resolveClearTargets(runtimeApiRoot), [runtimeApiRoot]);

  const requestAdminJson = useCallback(async (url, options = {}, timeoutMs = 35000, { expireOnMismatch = true } = {}) => {
    if (!adminSecret) {
      throw new Error('Admin session missing. Re-open ADMIN and unlock again.');
    }
    const { res, data, raw } = await fetchJsonWithTimeout(url, options, timeoutMs);
    if (!res.ok) {
      const code = String(data?.error || '').toUpperCase();
      if (code === 'ADMIN_SECRET_NOT_SET') {
        throw new Error('Backend ADMIN_SECRET is not set. Set ADMIN_SECRET in crash-collector env and redeploy backend.');
      }
      if (code === 'ADMIN_SECRET_MISSING') {
        throw new Error('Admin secret not sent. Unlock ADMIN again and retry.');
      }
      if (code === 'ADMIN_SECRET_MISMATCH') {
        if (expireOnMismatch) onAuthExpired?.();
        throw new Error('Admin secret mismatch. Re-enter correct backend ADMIN_SECRET.');
      }
      if (res.status === 403) {
        throw new Error('Forbidden: backend rejected this admin request.');
      }
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    if (!data || typeof data !== 'object') {
      if (raw.trim().startsWith('<')) throw new Error('API URL points to frontend HTML, not backend API');
      throw new Error('Invalid API response');
    }
    if (!data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }, [adminSecret, onAuthExpired]);

  const clearAcrossTargets = useCallback(async (endpoint) => {
    const results = await Promise.all(
      clearTargets.map(async (target) => {
        try {
          const data = await requestAdminJson(
            `${target.base}${endpoint}`,
            { method: 'DELETE', headers: adminHeaders },
            45000,
            { expireOnMismatch: target.base === runtimeApiRoot }
          );
          return { target, ok: true, data };
        } catch (e) {
          return { target, ok: false, error: e.message || 'Request failed' };
        }
      })
    );
    return results;
  }, [adminHeaders, clearTargets, requestAdminJson, runtimeApiRoot]);

  const loadCodes = useCallback(async () => {
    if (!adminSecret) {
      setCodes([]);
      setCodesLoading(false);
      setCodesError('Admin session missing. Unlock again.');
      return;
    }
    setCodesLoading(true);
    setCodesError('');
    try {
      const data = await requestAdminJson(
        `${API_URL}/access/list`,
        { headers: { 'x-admin-secret': adminSecret } },
        25000
      );
      setCodes(data.codes || []);
    } catch (e) {
      setCodes([]);
      setCodesError(e.message || 'Failed to load access codes');
    }
    setCodesLoading(false);
  }, [adminSecret, requestAdminJson]);

  useEffect(() => { loadCodes(); }, [loadCodes]);
  useEffect(() => {
    const id = setInterval(loadCodes, 30000);
    return () => clearInterval(id);
  }, [loadCodes]);

  const clearHistory = async () => {
    if (locksClearing) return;
    setHistClearing(true);
    try {
      const results = await clearAcrossTargets('/clear-history');
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      if (successes.length > 0) {
        clearFrontendPredictionCaches();
        window.dispatchEvent(new CustomEvent('predictions:cache-cleared', { detail: { scope: 'history' } }));
      }
      const successText = successes
        .map((r) => `${r.target.label}: ${r.data?.predictionsCleared || 0}`)
        .join(' | ');
      const failureText = failures
        .map((r) => `${r.target.label}: ${r.error}`)
        .join(' | ');
      if (successes.length > 0) {
        setHistResult({
          ok: true,
          msg: `History cleared -> ${successText}${failureText ? ` | mirror failed -> ${failureText}` : ''}`,
        });
      } else {
        setHistResult({ ok: false, msg: failureText || 'No clear target reachable' });
      }
    } catch (e) {
      setHistResult({ ok: false, msg: e.message });
    }
    setHistClearing(false);
    setHistConfirm(false);
  };

  const clearLocks = async () => {
    if (histClearing) return;
    setLocksClearing(true);
    try {
      const results = await clearAcrossTargets('/clear-locks');
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      if (successes.length > 0) {
        clearFrontendPredictionCaches();
        window.dispatchEvent(new CustomEvent('predictions:cache-cleared', { detail: { scope: 'locks' } }));
      }
      const successText = successes
        .map((r) => {
          const d = r.data || {};
          const total = (d.consensusLocksCleared || 0)
            + (d.advLocksCleared || 0)
            + (d.engineLocksCleared || 0)
            + (d.oracleLocksCleared || 0);
          return `${r.target.label}: ${total} (oracle ${d.oracleLocksCleared || 0})`;
        })
        .join(' | ');
      const failureText = failures
        .map((r) => `${r.target.label}: ${r.error}`)
        .join(' | ');
      if (successes.length > 0) {
        setLocksResult({
          ok: true,
          msg: `Locks cleared -> ${successText}${failureText ? ` | mirror failed -> ${failureText}` : ''}`,
        });
      } else {
        setLocksResult({ ok: false, msg: failureText || 'No clear target reachable' });
      }
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
      await fetch(`${API_URL}/access/${id}`, { method: 'DELETE', headers: { 'x-admin-secret': adminSecret } });
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
        <div style={S.desc}>Deletes resolved prediction records on both current and mirror backend targets.</div>
        <div style={{ fontSize: 11, color: '#666', marginBottom: 10 }}>
          Targets: {clearTargets.map((t) => `${t.label} (${t.base})`).join(' | ')}
        </div>
        {!histConfirm && !histResult && <button onClick={() => setHistConfirm(true)} style={S.btn('#ff8c42')}>CLEAR HISTORY</button>}
        {histConfirm && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={clearHistory} disabled={histClearing || locksClearing} style={S.btn('#ff8c42')}>{histClearing ? 'Working...' : 'CONFIRM CLEAR HISTORY'}</button>
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
          <div style={{ ...S.desc, marginBottom: 8 }}>Clears lock tables on both current and mirror backend targets.</div>
          {!locksConfirm && !locksResult && (
            <button onClick={() => setLocksConfirm(true)} style={S.btn('#00d4ff')}>CLEAR ALL LOCKS</button>
          )}
          {locksConfirm && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={clearLocks} disabled={locksClearing || histClearing} style={S.btn('#00d4ff')}>
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
        ) : codesError ? (
          <div style={{ fontSize: 12, color: '#ff4560', textAlign: 'center', padding: 16 }}>
            {codesError}
          </div>
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

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab,     setActiveTab]     = useState('HOME');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminSecret,   setAdminSecret]   = useState('');
  const [showAuthPopup, setShowAuthPopup] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const [menuOpen,      setMenuOpen]      = useState(false);
  const [botLive,       setBotLive]       = useState(DEFAULT_BOT_LIVE);

  const clickTimesRef = useRef([]);

  const { rounds, gaps, stats, status, booting, isPolling, manualRefresh, pollCount } = useRounds();

  // ── Site access check on mount ──────────────────────────────────────────
  useEffect(() => {
    if (BYPASS_ACCESS) { setAccessGranted(true); setAccessChecked(true); return; }
    const stored = readAccessToken();
    if (!stored) { setAccessChecked(true); return; }

    try {
      const { code, expiresAt } = JSON.parse(stored);
      if (!code || !expiresAt || new Date(expiresAt) < new Date()) {
        clearAccessToken();
        setAccessChecked(true);
        return;
      }

      // Fast-path: unblock UI immediately when a non-expired token exists.
      // Verify in background so refresh doesn't sit on "Verifying access...".
      setAccessGranted(true);
      setAccessChecked(true);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      fetch(`${API_URL}/access/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ code }),
      })
        .then(async (r) => {
          const txt = await r.text();
          try { return JSON.parse(txt); } catch { return { ok: false }; }
        })
        .then(d => {
          if (d.ok) {
            if (d.expiresAt) {
              writeAccessToken({ code, expiresAt: d.expiresAt });
            }
            return;
          }
          clearAccessToken();
          setAccessGranted(false);
        })
        .catch(() => {})
        .finally(() => { clearTimeout(timeout); });

      return () => {
        clearTimeout(timeout);
        controller.abort();
      };
    } catch {
      clearAccessToken();
      setAccessChecked(true);
    }
  }, []);

  useEffect(() => {
    if (!accessGranted) return;
    const check = () => {
      const stored = readAccessToken();
      if (!stored) { setAccessGranted(false); return; }
      try {
        const { expiresAt } = JSON.parse(stored);
        if (new Date(expiresAt) <= new Date()) {
          clearAccessToken();
          setAccessGranted(false);
          window.location.reload();
        }
      } catch {
        clearAccessToken();
        setAccessGranted(false);
      }
    };
    const first = setTimeout(check, 500);
    const id    = setInterval(check, 10000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [accessGranted]);

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

  const handleAuthSuccess = (secret) => {
    setAdminSecret(String(secret || '').trim());
    setAdminUnlocked(true);
    setShowAuthPopup(false);
    setActiveTab('ADMIN');
  };

  const handleAdminAuthExpired = useCallback(() => {
    setAdminUnlocked(false);
    setAdminSecret('');
    setShowAuthPopup(true);
    setActiveTab('HOME');
  }, []);

  if (!accessChecked) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#080808', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 13, color: '#444' }}>Verifying access...</div>
      </div>
    );
  }

  if (!accessGranted) {
    return <AccessGate onGranted={() => setAccessGranted(true)} />;
  }

  if (booting) {
    return <BootLoaderOverlay attempt={pollCount} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="header-logo">🤖</div>
          <div className="header-brand-copy" style={{ flex: 1, minWidth: 0 }}>
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

          <div className="header-right-actions" style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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

      {activeTab === 'HOME' && (
        <main className="main-grid">
          <div className="col col-left">
            <GapTracker gaps={gaps} />
            <ControlPanel status={status} isPolling={isPolling} onRefresh={manualRefresh} />
          </div>
          <div className="col col-center">
            <RecentCrashes rounds={rounds} limit={50} />
            <MultiplierChart rounds={rounds} totalTracked={stats.tracked} distribution={stats.distribution} />
          </div>
        </main>
      )}

      {activeTab === 'AUTO BOT' && (
        <main className="bot-grid bot-grid-split">
          <div className="col col-bot-left">
            <WalletBot onLiveStateChange={setBotLive} adminSecret={adminSecret} />
          </div>
          <div className="col col-bot-right">
            <CrashLivePanel
              liveState={botLive.liveState}
              recentResolved={botLive.recentResolved}
              currentRoundId={botLive.currentRoundId}
              targetMultiplier={botLive.targetMultiplier}
              botRunning={botLive.botRunning}
              canCashout={botLive.canCashout}
              cashoutBusy={botLive.cashoutBusy}
              onCashout={botLive.onCashout}
            />
            <GapTracker gaps={gaps} />
          </div>
        </main>
      )}

      {activeTab === 'PREDICTION' && (
        <PredictionSection rounds={rounds} adminSecret={adminSecret} />
      )}

      {activeTab === 'ADMIN' && adminUnlocked && (
        <AdminPanel
          adminSecret={adminSecret}
          onAuthExpired={handleAdminAuthExpired}
        />
      )}
    </div>
  );
}