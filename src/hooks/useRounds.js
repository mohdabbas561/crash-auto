import { useState, useEffect, useRef, useCallback } from 'react';
import { computeGaps, computeStats } from '../utils/gapTracker';

const API_URL       = (process.env.REACT_APP_API_URL || '').replace(/\/$/, ''); // strip trailing slash
const POLL_INTERVAL = 10000;

const ALL_LIMIT = 100000;

async function apiFetch(path) {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRounds() {
  const [rounds,       setRounds]       = useState([]);
  const [gaps,         setGaps]         = useState({});
  const [stats,        setStats]        = useState({});
  const [log,          setLog]          = useState([]);
  const [status,       setStatus]       = useState('idle');
  const [storageStats, setStorageStats] = useState(null);
  const [isPolling,    setIsPolling]    = useState(false);
  const [lastUpdated,  setLastUpdated]  = useState(null);
  const [pollCount,    setPollCount]    = useState(0);

  const intervalRef = useRef(null);
  const latestRef   = useRef([]);
  const loadingRef  = useRef(false);

  const addLog = (msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLog(prev => [{ ts, msg, type, id: Date.now() + Math.random() }, ...prev].slice(0, 200));
  };

  const load = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const prevMax = latestRef.current.length
        ? latestRef.current[latestRef.current.length - 1].roundId : 0;

      // Always build path starting with /  — apiFetch prepends API_URL (no trailing slash)
      const path = silent && prevMax > 0
        ? `/rounds?limit=5000&since=${prevMax}`
        : `/rounds?limit=${ALL_LIMIT}`;

      const [data, backendStats] = await Promise.all([
        apiFetch(path),
        apiFetch('/stats').catch(() => null),
      ]);

      const fresh = data?.rounds || [];
      if (!fresh.length) { setLastUpdated(new Date()); return; }

      let sorted;
      if (silent && prevMax > 0) {
        const newOnes = fresh.filter(r => r.roundId > prevMax);
        if (!newOnes.length) { setLastUpdated(new Date()); return; }
        sorted = [...latestRef.current, ...newOnes]
          .sort((a, b) => a.roundId - b.roundId);
        const latest = newOnes[newOnes.length - 1];
        addLog(`+${newOnes.length} new — #${latest.roundId}: ${latest.multiplier}x`, 'success');
      } else {
        sorted = fresh.sort((a, b) => a.roundId - b.roundId);
        addLog(`Loaded ${sorted.length.toLocaleString()} rounds — all engines ready`, 'success');
      }

      latestRef.current = sorted;
      setRounds([...sorted]);

      if (backendStats?.gaps) {
        setGaps(backendStats.gaps);
      } else {
        setGaps(computeGaps(sorted));
      }

      const computed = computeStats(sorted);
      if (backendStats?.ok && backendStats.tracked) {
        computed.tracked      = backendStats.tracked;
        computed.currentRound = backendStats.currentRound || computed.currentRound;
        if (backendStats.highest) computed.highest = backendStats.highest;
        if (backendStats.avg)     computed.avg     = backendStats.avg;
      }
      setStats(computed);
      setLastUpdated(new Date());
      setPollCount(c => c + 1);

      if (!silent) {
        apiFetch('/storage-stats').then(d => setStorageStats(d)).catch(() => {});
      }

    } catch (e) {
      setLastUpdated(new Date());
      if (!silent) { setStatus('error'); addLog(`Connection failed: ${e.message}`, 'error'); }
      else addLog(`Poll error: ${e.message}`, 'warn');
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!API_URL) {
      setStatus('error');
      console.error('[useRounds] REACT_APP_API_URL is not set! Check Render env vars and redeploy.');
      return;
    }
    setStatus('loading');
    load(false).then(() => {
      setStatus('connected');
      intervalRef.current = setInterval(() => load(true), POLL_INTERVAL);
      setIsPolling(true);
    });
    const onOnline     = () => { load(true); };
    const onVisibility = () => { if (document.visibilityState === 'visible') load(true); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalRef.current);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      setIsPolling(false);
    };
  }, [load]);

  const manualRefresh = () => { addLog('Manual refresh...', 'info'); load(false); };

  return { rounds, gaps, stats, log, status, storageStats, isPolling, manualRefresh, lastUpdated, pollCount };
}