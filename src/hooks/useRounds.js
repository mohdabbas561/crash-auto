import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE } from '../config/apiBase';

const API_URL = API_BASE;
const POLL_INTERVAL = 30000;
const API_TIMEOUT_MS = 12000;
const DASHBOARD_TIMEOUT_MS = 10000;
const LEGACY_TIMEOUT_MS = 12000;
const STORAGE_TIMEOUT_MS = 8000;
const DASHBOARD_RECENT_LIMIT = 80;
const DASHBOARD_LOCAL_CAP = 240;
const LEGACY_DELTA_LIMIT = 2000;

async function apiFetch(path, timeoutMs = API_TIMEOUT_MS) {
  const url = `${API_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStats(raw) {
  return {
    tracked: Number(raw?.tracked || 0),
    avg: raw?.avg ?? '0.00',
    highest: raw?.highest ?? '0.00',
    currentRound: Number(raw?.currentRound || 0),
    distribution: raw?.distribution || {},
  };
}

function sortByRoundIdAsc(rows) {
  return [...(rows || [])].sort((a, b) => Number(a.roundId) - Number(b.roundId));
}

function trimRecent(rows) {
  const sorted = sortByRoundIdAsc(rows);
  if (sorted.length <= DASHBOARD_LOCAL_CAP) return sorted;
  return sorted.slice(-DASHBOARD_LOCAL_CAP);
}

function mergeRecent(existing, incoming) {
  const byId = new Map();
  for (const row of existing || []) {
    const rid = Number(row?.roundId || 0);
    if (rid > 0) byId.set(rid, row);
  }
  for (const row of incoming || []) {
    const rid = Number(row?.roundId || 0);
    if (rid > 0) byId.set(rid, row);
  }
  return trimRecent([...byId.values()]);
}

export function useRounds() {
  const [rounds, setRounds] = useState([]);
  const [gaps, setGaps] = useState({});
  const [stats, setStats] = useState({});
  const [log, setLog] = useState([]);
  const [status, setStatus] = useState('idle');
  const [booting, setBooting] = useState(true);
  const [storageStats, setStorageStats] = useState(null);
  const [isPolling, setIsPolling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [pollCount, setPollCount] = useState(0);

  const intervalRef = useRef(null);
  const latestRef = useRef([]);
  const statsRef = useRef({});
  const loadingRef = useRef(false);
  const failuresRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const logSeqRef = useRef(0);

  const addLog = (msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    logSeqRef.current += 1;
    setLog(prev => [{ ts, msg, type, id: `${Date.now()}-${logSeqRef.current}` }, ...prev].slice(0, 200));
  };

  const load = useCallback(async (silent = false) => {
    if (loadingRef.current) return false;
    loadingRef.current = true;
    try {
      const prevMax = latestRef.current.length
        ? Number(latestRef.current[latestRef.current.length - 1].roundId || 0)
        : 0;
      const dashboardPath = silent && prevMax > 0
        ? `/dashboard?recentLimit=${DASHBOARD_RECENT_LIMIT}&since=${prevMax}`
        : `/dashboard?recentLimit=${DASHBOARD_RECENT_LIMIT}`;

      let source = 'dashboard';
      let payload = null;
      try {
        payload = await apiFetch(dashboardPath, DASHBOARD_TIMEOUT_MS);
      } catch (err) {
        source = 'legacy';
        const legacyRoundsPath = silent && prevMax > 0
          ? `/rounds?limit=${LEGACY_DELTA_LIMIT}&since=${prevMax}`
          : `/rounds?limit=${DASHBOARD_RECENT_LIMIT}`;
        const [legacyStatsRes, legacyRoundsRes] = await Promise.allSettled([
          apiFetch('/stats', LEGACY_TIMEOUT_MS),
          apiFetch(legacyRoundsPath, LEGACY_TIMEOUT_MS),
        ]);
        if (legacyStatsRes.status !== 'fulfilled' && legacyRoundsRes.status !== 'fulfilled') {
          throw err;
        }
        const legacyStats = legacyStatsRes.status === 'fulfilled'
          ? legacyStatsRes.value
          : (statsRef.current || {});
        const legacyRounds = legacyRoundsRes.status === 'fulfilled'
          ? legacyRoundsRes.value
          : { rounds: [] };
        payload = {
          stats: legacyStats,
          gaps: legacyStats?.gaps || {},
          distribution: legacyStats?.distribution || {},
          recentRounds: legacyRounds?.rounds || [],
        };
      }

      const normalizedStats = normalizeStats(payload?.stats || payload);
      setStats(normalizedStats);
      statsRef.current = normalizedStats;
      setGaps(payload?.gaps || {});

      const incoming = sortByRoundIdAsc(payload?.recentRounds || []);
      let nextRounds = latestRef.current;

      if (silent && prevMax > 0) {
        const newOnes = incoming.filter(r => Number(r?.roundId || 0) > prevMax);
        if (newOnes.length > 0) {
          nextRounds = mergeRecent(latestRef.current, newOnes);
          const latest = newOnes[newOnes.length - 1];
          addLog(`+${newOnes.length} new - #${latest.roundId}: ${latest.multiplier}x`, 'success');
        }
      } else {
        nextRounds = trimRecent(incoming);
        addLog(
          `${source === 'dashboard' ? 'Dashboard sync' : 'Legacy sync'} - ${normalizedStats.tracked.toLocaleString()} tracked`,
          'success'
        );
      }

      latestRef.current = nextRounds;
      setRounds([...nextRounds]);
      setLastUpdated(new Date());
      setPollCount(c => c + 1);
      setStatus('connected');
      hasConnectedRef.current = true;
      setBooting(false);

      if (!silent) {
        apiFetch('/storage-stats', STORAGE_TIMEOUT_MS).then(d => setStorageStats(d)).catch(() => {});
      }
    } catch (e) {
      setLastUpdated(new Date());
      if (!silent) {
        if (latestRef.current.length > 0) {
          setStatus('connected');
          addLog(`Network slow (${e.message}) - retrying`, 'warn');
        } else {
          if (hasConnectedRef.current) {
            setStatus('error');
            addLog(`Connection failed: ${e.message}`, 'error');
          } else {
            setStatus('loading');
            addLog(`Boot sync retry: ${e.message}`, 'warn');
          }
        }
      } else {
        addLog(`Poll error: ${e.message}`, 'warn');
      }
      return false;
    } finally {
      loadingRef.current = false;
    }
    return true;
  }, []);

  useEffect(() => {
    if (!API_URL) {
      setStatus('error');
      console.error('[useRounds] REACT_APP_API_URL is not set! Check frontend env vars and redeploy.');
      return;
    }
    if (!latestRef.current.length) setStatus('loading');
    const scheduleNextPoll = (delayMs) => {
      clearTimeout(intervalRef.current);
      intervalRef.current = setTimeout(async () => {
        const ok = await load(true);
        failuresRef.current = ok ? 0 : Math.min(failuresRef.current + 1, 6);
        const nextDelay = ok
          ? POLL_INTERVAL
          : Math.min(20000, 3000 * (failuresRef.current + 1));
        scheduleNextPoll(nextDelay);
      }, delayMs);
    };

    load(false).then((ok) => {
      const hasCached = latestRef.current.length > 0;
      if (ok || hasCached) {
        setStatus('connected');
        hasConnectedRef.current = true;
        setBooting(false);
      } else {
        setStatus(hasConnectedRef.current ? 'error' : 'loading');
        setBooting(true);
      }
      failuresRef.current = ok ? 0 : 1;
      scheduleNextPoll(ok ? POLL_INTERVAL : 3000);
      setIsPolling(true);
    });

    const onOnline = () => {
      failuresRef.current = 0;
      if (!hasConnectedRef.current) setStatus('loading');
      load(true);
      scheduleNextPoll(POLL_INTERVAL);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      failuresRef.current = 0;
      if (!hasConnectedRef.current) setStatus('loading');
      load(true);
      scheduleNextPoll(POLL_INTERVAL);
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(intervalRef.current);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      setIsPolling(false);
    };
  }, [load]);

  const manualRefresh = () => {
    addLog('Manual refresh...', 'info');
    load(false);
  };

  return { rounds, gaps, stats, log, status, booting, storageStats, isPolling, manualRefresh, lastUpdated, pollCount };
}
