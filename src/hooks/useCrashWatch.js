import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../config/apiBase';

const API_URL = API_BASE;
const POLL_INTERVAL_MS = 30000;
const MANAGED_SOURCE_KEYS = new Set([
  'degencoinflip-crash',
  'solanafatboys-bustonaut',
]);

function isManagedCrashSite(site) {
  const sourceKey = String(site?.sourceKey || '').trim().toLowerCase();
  if (MANAGED_SOURCE_KEYS.has(sourceKey)) return true;
  const url = String(site?.gameUrl || '').toLowerCase();
  return (
    url.includes('degencoinflip.com/crash') ||
    url.includes('solanafatboys.com/bustonaut')
  );
}

async function apiFetch(path, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickFirstSiteId(payload) {
  const sites = Array.isArray(payload?.sites) ? payload.sites : [];
  return sites[0]?.id ?? null;
}

function normalizeGameKey(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin.toLowerCase()}${url.pathname.toLowerCase()}`;
  } catch {
    return raw.toLowerCase();
  }
}

function choosePreferredSite(current, candidate) {
  if (!current) return candidate;
  const score = (site) => [
    Number(site?.summary?.total || 0) > 0 ? 4 : 0,
    String(site?.apiUrl || '').trim() ? 2 : 0,
    String(site?.lastSuccessAt || '').trim() ? 1 : 0,
    Number(site?.id || 0) / 1000000,
  ].reduce((sum, part) => sum + part, 0);
  return score(candidate) > score(current) ? candidate : current;
}

function normalizeDashboard(payload) {
  const sites = Array.isArray(payload?.sites) ? payload.sites : [];
  const uniqueByGame = new Map();
  for (const site of sites) {
    if (!isManagedCrashSite(site)) continue;
    const key = normalizeGameKey(site?.gameUrl || site?.sourceKey || site?.label);
    uniqueByGame.set(key, choosePreferredSite(uniqueByGame.get(key), site));
  }

  const uniqueSites = [...uniqueByGame.values()];
  const overall = uniqueSites.reduce((acc, site) => {
    const summary = site?.summary || {};
    const total = Number(summary.total || 0);
    const avg = Number(summary.avg || 0);
    acc.total += total;
    acc.counts.gte3 += Number(summary?.counts?.gte3 || 0);
    acc.counts.gte4 += Number(summary?.counts?.gte4 || 0);
    acc.counts.gte5 += Number(summary?.counts?.gte5 || 0);
    if (Number.isFinite(summary.latestRoundId)) {
      acc.latestRoundId = acc.latestRoundId == null ? Number(summary.latestRoundId) : Math.max(acc.latestRoundId, Number(summary.latestRoundId));
    }
    if (Number.isFinite(summary.highest)) {
      acc.highest = acc.highest == null ? Number(summary.highest) : Math.max(acc.highest, Number(summary.highest));
    }
    if (total > 0 && Number.isFinite(avg)) {
      acc.weightedAvg += avg * total;
      acc.weightedTotal += total;
    }
    return acc;
  }, {
    total: 0,
    latestRoundId: null,
    highest: null,
    weightedAvg: 0,
    weightedTotal: 0,
    counts: { gte3: 0, gte4: 0, gte5: 0 },
  });

  overall.avg = overall.weightedTotal > 0 ? Number((overall.weightedAvg / overall.weightedTotal).toFixed(4)) : null;
  delete overall.weightedAvg;
  delete overall.weightedTotal;

  return { ...payload, sites: uniqueSites, overall };
}

export function useCrashWatch() {
  const [dashboard, setDashboard] = useState(null);
  const [selectedSiteId, setSelectedSiteId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const loadDashboard = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const payload = await apiFetch('/crash-dashboard?limitPerSite=200', {}, 15000);
      const normalized = normalizeDashboard(payload);
      setDashboard(normalized);
      setLastUpdatedAt(new Date());
      setError('');
      setSelectedSiteId((current) => current ?? pickFirstSiteId(normalized));
      return normalized;
    } catch (err) {
      setError(err.message || 'Unable to reach the crash watch backend');
      return null;
    } finally {
      if (!silent) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard(false);
    const timer = setInterval(() => {
      loadDashboard(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadDashboard]);

  const addSite = useCallback(async (site) => {
    setSaving(true);
    try {
      const payload = await apiFetch('/crash-sites', {
        method: 'POST',
        body: JSON.stringify(site),
      });
      await loadDashboard(true);
      setSelectedSiteId(payload?.site?.id ?? null);
      return payload?.site ?? null;
    } finally {
      setSaving(false);
    }
  }, [loadDashboard]);

  const updateSite = useCallback(async (siteId, patch) => {
    if (!siteId) return null;
    setSaving(true);
    try {
      const payload = await apiFetch(`/crash-sites/${siteId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadDashboard(true);
      return payload?.site ?? null;
    } finally {
      setSaving(false);
    }
  }, [loadDashboard]);

  const toggleSite = useCallback(async (site, enabled) => {
    if (!site?.id) return null;
    return updateSite(site.id, { enabled: Boolean(enabled) });
  }, [updateSite]);

  const clearSiteRounds = useCallback(async (siteId) => {
    if (!siteId) return null;
    setSaving(true);
    try {
      const payload = await apiFetch(`/crash-sites/${siteId}/rounds`, {
        method: 'DELETE',
      });
      await loadDashboard(true);
      return payload;
    } finally {
      setSaving(false);
    }
  }, [loadDashboard]);

  const clearAllRounds = useCallback(async () => {
    setSaving(true);
    try {
      const payload = await apiFetch('/crash-rounds', {
        method: 'DELETE',
      });
      await loadDashboard(true);
      return payload;
    } finally {
      setSaving(false);
    }
  }, [loadDashboard]);

  const selectedSite = useMemo(() => {
    const sites = Array.isArray(dashboard?.sites) ? dashboard.sites : [];
    if (!sites.length) return null;
    return sites.find((site) => Number(site.id) === Number(selectedSiteId)) || sites[0];
  }, [dashboard, selectedSiteId]);

  const overall = dashboard?.overall || {
    total: 0,
    latestRoundId: null,
    highest: null,
    avg: null,
    counts: { gte3: 0, gte4: 0, gte5: 0 },
  };

  return {
    dashboard,
    selectedSite,
    selectedSiteId,
    setSelectedSiteId,
    loading,
    refreshing,
    saving,
    error,
    lastUpdatedAt,
    overall,
    loadDashboard,
    addSite,
    updateSite,
    toggleSite,
    clearSiteRounds,
    clearAllRounds,
  };
}
