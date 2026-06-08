import React, { useMemo, useState } from 'react';
import { useCrashWatch } from '../hooks/useCrashWatch';

const DEFAULT_SITES = [
  {
    label: 'Degen Coin Flip',
    shortLabel: 'DCF',
    url: 'https://app.degencoinflip.com/crash',
    adapter: 'degencoinflip',
    apiUrl: 'https://api.dealer.degencoinflip.com/v1/game/2/room/1/rounds?limit=100',
    roundsPath: '?limit=100',
    accent: '#00ff88',
  },
  {
    label: 'Bustonaut',
    shortLabel: 'SFB',
    url: 'https://www.solanafatboys.com/bustonaut/',
    adapter: 'sfb',
    apiUrl: 'https://sfb-api-service-mainnet.up.railway.app/api/games/bustonaut/latest?page=0&limit=100',
    roundsPath: '?page=0&limit=100',
    accent: '#00d4ff',
  },
];

const MANAGED_KEYS = new Set(['degencoinflip-crash', 'solanafatboys-bustonaut']);

function fmtCount(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0));
}

function fmtNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRoundTimestamp(round) {
  const raw = Number(round?.timestamp);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const created = round?.createdAt ? Number(new Date(round.createdAt)) : NaN;
  return Number.isFinite(created) ? created : 0;
}

function startOfTodayTs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function countBands(rounds) {
  return rounds.reduce(
    (acc, round) => {
      const value = Number(round?.multiplier);
      if (!Number.isFinite(value)) return acc;
      if (value >= 3) acc.gte3 += 1;
      if (value >= 4) acc.gte4 += 1;
      if (value >= 5) acc.gte5 += 1;
      return acc;
    },
    { gte3: 0, gte4: 0, gte5: 0 },
  );
}

function computeGapStats(rounds, threshold) {
  const hits = [...rounds]
    .filter((round) => Number(round?.multiplier) >= threshold)
    .map((round) => getRoundTimestamp(round))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!hits.length) {
    return { count: 0, avgGap: null, currentGap: null, fit: 0 };
  }

  const gaps = [];
  for (let i = 1; i < hits.length; i += 1) {
    gaps.push(Math.max(1, Math.round((hits[i] - hits[i - 1]) / 1000)));
  }

  const avgGap = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null;
  const currentGap = Math.max(0, Math.round((Date.now() - hits[hits.length - 1]) / 1000));
  const gapBase = Math.max(1, avgGap || currentGap || 1);
  const fit = clamp(1 - (Math.abs(currentGap - gapBase) / Math.max(gapBase, currentGap || 1, 1)), 0, 1);

  return {
    count: hits.length,
    avgGap,
    currentGap,
    fit,
  };
}

function buildSiteInsight(site) {
  const ordered = (Array.isArray(site?.rounds) ? site.rounds : [])
    .filter((round) => Number.isFinite(Number(round?.multiplier)))
    .sort((a, b) => getRoundTimestamp(a) - getRoundTimestamp(b) || Number(a.roundId) - Number(b.roundId));

  const summary = site?.summary || {};
  const totalRounds = Number(summary?.total || ordered.length || 0);
  const todayStart = startOfTodayTs();
  const todayRounds = ordered.filter((round) => getRoundTimestamp(round) >= todayStart);
  const recentRounds = ordered.slice(-40);
  const historicalSample = ordered.slice(-80);

  const todayBands = countBands(todayRounds);
  const recentBands = countBands(recentRounds);
  const overallBands = {
    gte3: Number(summary?.counts?.gte3 || 0),
    gte4: Number(summary?.counts?.gte4 || 0),
    gte5: Number(summary?.counts?.gte5 || 0),
  };

  const totalBandHits = overallBands.gte3 + overallBands.gte4 + overallBands.gte5;
  const bandRate = totalRounds > 0 ? totalBandHits / totalRounds : 0;
  const todayBandHits = todayBands.gte3 + todayBands.gte4 + todayBands.gte5;
  const todayRate = todayRounds.length > 0 ? todayBandHits / todayRounds.length : 0;
  const recentBandHits = recentBands.gte3 + recentBands.gte4 + recentBands.gte5;
  const recentRate = recentRounds.length > 0 ? recentBandHits / recentRounds.length : 0;
  const sampleWeight = clamp(Math.log10(totalRounds + 1) / 2, 0.35, 1);

  const gap3 = computeGapStats(historicalSample.length ? historicalSample : recentRounds, 3);
  const gap4 = computeGapStats(historicalSample.length ? historicalSample : recentRounds, 4);
  const gap5 = computeGapStats(historicalSample.length ? historicalSample : recentRounds, 5);
  const gapFit = clamp((gap3.fit * 0.45) + (gap4.fit * 0.35) + (gap5.fit * 0.2), 0, 1);

  const confidenceBoost = 0.7 + (sampleWeight * 0.3);
  const signalScore = clamp(
    Math.round(
      ((bandRate * 100) * confidenceBoost) +
        (recentRate * 100 * 0.15) +
        (gapFit * 100 * 0.1) +
        (todayRate * 100 * 0.05),
    ),
    0,
    100,
  );

  const pulse = signalScore >= 75 ? 'HOT' : signalScore >= 55 ? 'READY' : signalScore >= 35 ? 'WATCH' : 'COOL';

  return {
    ...site,
    orderedRounds: ordered,
    totalRounds,
    todayRounds,
    todayBands,
    recentBands,
    overallBands,
    gap3,
    gap4,
    gap5,
    bandRate,
    todayRate,
    recentRate,
    gapFit,
    sampleWeight,
    signalScore,
    pulse,
    hasData: ordered.length > 0,
    summary,
  };
}

function MiniStat({ label, value, sublabel, accent }) {
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${accent}2f`,
        display: 'grid',
        gap: 4,
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: '#8aa0bb' }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 900, color: '#f7fbff', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#8aa0bb' }}>{sublabel}</div>
    </div>
  );
}

function SimpleStat({ label, value, accent }) {
  return (
    <div
      style={{
        padding: '13px 14px',
        borderRadius: 14,
        background: 'rgba(12, 18, 28, 0.92)',
        border: `1px solid ${accent}35`,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: '#8aa0bb' }}>{label}</div>
        <div style={{ fontSize: 11, color: '#8aa0bb' }}>{value.total}</div>
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: '#f7fbff', lineHeight: 1 }}>{value.count}</div>
      <div style={{ fontSize: 11, color: '#8aa0bb' }}>{value.rate}</div>
    </div>
  );
}

export default function AllCrashGameTab() {
  const {
    dashboard,
    loading,
    refreshing,
    saving,
    error,
    lastUpdatedAt,
    loadDashboard,
    clearSiteRounds,
    clearAllRounds,
  } = useCrashWatch();

  const [busy, setBusy] = useState(false);

  const sites = useMemo(() => {
    const rawSites = Array.isArray(dashboard?.sites) ? dashboard.sites : [];
    return rawSites.filter((site) => {
      const sourceKey = String(site?.sourceKey || '').toLowerCase();
      if (MANAGED_KEYS.has(sourceKey)) return true;
      const url = String(site?.gameUrl || '').toLowerCase();
      return url.includes('degencoinflip.com/crash') || url.includes('solanafatboys.com/bustonaut');
    });
  }, [dashboard]);

  const insights = useMemo(() => sites.map(buildSiteInsight), [sites]);

  const recommendedSite = useMemo(() => {
    const withData = insights.filter((site) => site.hasData);
    if (!withData.length) return null;
    return [...withData].sort((a, b) => {
      if ((b.signalScore || 0) !== (a.signalScore || 0)) return (b.signalScore || 0) - (a.signalScore || 0);
      if ((b.bandRate || 0) !== (a.bandRate || 0)) return (b.bandRate || 0) - (a.bandRate || 0);
      if ((b.recentRate || 0) !== (a.recentRate || 0)) return (b.recentRate || 0) - (a.recentRate || 0);
      return (b.sampleWeight || 0) - (a.sampleWeight || 0);
    })[0];
  }, [insights]);

  const clearAll = async () => {
    if (!window.confirm('Clear all stored crash rounds for the tracked games?')) return;
    setBusy(true);
    try {
      await clearAllRounds();
    } finally {
      setBusy(false);
    }
  };

  const clearOne = async (site) => {
    if (!site?.id) return;
    if (!window.confirm(`Clear stored rounds for ${site.label}?`)) return;
    setBusy(true);
    try {
      await clearSiteRounds(site.id);
    } finally {
      setBusy(false);
    }
  };

  const heroTitle = recommendedSite
    ? `Play ${recommendedSite.shortLabel || recommendedSite.label}`
    : 'Waiting for live data';

  const heroNote = recommendedSite
    ? `Ranks highest by normalized hit rate, sample balance, and short-gap fit.`
    : 'No reliable rounds yet. The board will rank itself as soon as stored history fills in.';

  return (
    <main style={{ width: '100%', marginTop: 10 }}>
      <section
        className="panel"
        style={{
          margin: '0 16px 14px',
          background: 'linear-gradient(180deg, rgba(8, 12, 20, 0.96) 0%, rgba(12, 18, 30, 0.92) 100%)',
        }}
      >
        <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2>CRASH SIGNAL BOARD</h2>
            <p className="panel-subtitle">3x / 4x / 5x only. No URLs, no noise.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-refresh"
              type="button"
              onClick={() => loadDashboard(false)}
              disabled={loading || refreshing || saving || busy}
            >
              {refreshing ? 'Refreshing...' : 'Refresh now'}
            </button>
            <button className="btn" type="button" onClick={clearAll} disabled={saving || busy || !sites.length}>
              Clear all
            </button>
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.02fr) minmax(320px, 0.72fr)', gap: 14, margin: '0 16px 24px' }}>
        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-header" style={{ marginBottom: 14 }}>
            <h2>SIGNAL CARDS</h2>
            <p className="panel-subtitle">Pure stored history, normalized by total rounds tracked.</p>
          </div>

          {error ? (
            <div
              style={{
                marginTop: 8,
                padding: '10px 12px',
                borderRadius: 10,
                background: '#ff456014',
                border: '1px solid #ff456044',
                color: '#ff93a0',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          ) : null}

          <div style={{ display: 'grid', gap: 12, marginTop: error ? 12 : 0 }}>
            {DEFAULT_SITES.map((site) => {
              const liveSite =
                sites.find((entry) => String(entry?.sourceKey || '').toLowerCase() === `${site.adapter}-crash`) ||
                sites.find((entry) => String(entry?.gameUrl || '').toLowerCase().includes(site.url.toLowerCase()));
              const insight = liveSite ? insights.find((entry) => Number(entry.id) === Number(liveSite.id)) : null;
              const total = insight?.totalRounds || 0;
              const combinedHits = (insight?.overallBands?.gte3 || 0) + (insight?.overallBands?.gte4 || 0) + (insight?.overallBands?.gte5 || 0);
              const combinedRate = total > 0 ? (combinedHits / total) * 100 : 0;
              const shortGap = insight?.gapFit ? insight.gapFit * 100 : 0;

              return (
                <article
                  key={site.label}
                  style={{
                    padding: 16,
                    borderRadius: 20,
                    background: 'linear-gradient(180deg, rgba(12,18,30,0.96) 0%, rgba(10,14,24,0.98) 100%)',
                    border: `1px solid ${site.accent}4a`,
                    boxShadow: `0 0 0 1px ${site.accent}10, 0 18px 36px rgba(0,0,0,0.24)`,
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 18, color: '#f7fbff' }}>{site.label}</strong>
                        <span
                          style={{
                            padding: '4px 8px',
                            borderRadius: 999,
                            fontSize: 10,
                            letterSpacing: 1,
                            textTransform: 'uppercase',
                            color: insight?.hasData ? site.accent : '#8fa0ba',
                            border: `1px solid ${insight?.hasData ? `${site.accent}55` : 'rgba(255,255,255,0.08)'}`,
                            background: insight?.hasData ? `${site.accent}14` : 'rgba(255,255,255,0.02)',
                          }}
                        >
                          {insight?.pulse || 'SYNC'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', color: '#8fa0ba', fontSize: 12 }}>
                        <span>{fmtCount(total)} rounds tracked</span>
                        <span>•</span>
                        <span>{fmtNumber(combinedRate, 1)}% combined hit rate</span>
                      </div>
                    </div>

                    <button
                      className="btn"
                      type="button"
                      onClick={() => clearOne(liveSite)}
                      disabled={busy || saving || !liveSite}
                    >
                      Clear
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                    <SimpleStat
                      label="3x"
                      value={{
                        count: fmtCount(insight?.overallBands?.gte3 || 0),
                        total: `${fmtCount(total)} tracked`,
                        rate: `${fmtNumber(total ? ((insight?.overallBands?.gte3 || 0) / total) * 100 : 0, 1)}%`,
                      }}
                      accent={site.accent}
                    />
                    <SimpleStat
                      label="4x"
                      value={{
                        count: fmtCount(insight?.overallBands?.gte4 || 0),
                        total: `${fmtCount(total)} tracked`,
                        rate: `${fmtNumber(total ? ((insight?.overallBands?.gte4 || 0) / total) * 100 : 0, 1)}%`,
                      }}
                      accent={site.accent}
                    />
                    <SimpleStat
                      label="5x"
                      value={{
                        count: fmtCount(insight?.overallBands?.gte5 || 0),
                        total: `${fmtCount(total)} tracked`,
                        rate: `${fmtNumber(total ? ((insight?.overallBands?.gte5 || 0) / total) * 100 : 0, 1)}%`,
                      }}
                      accent={site.accent}
                    />
                  </div>

                  <div
                    style={{
                      paddingTop: 2,
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                      color: '#8fa0ba',
                      fontSize: 12,
                    }}
                  >
                    <span>Short-gap fit {fmtNumber(shortGap, 0)}%</span>
                    <span>Normalized score {fmtNumber(insight?.signalScore || 0, 0)}%</span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-header" style={{ marginBottom: 14 }}>
            <h2>PLAY NOW</h2>
            <p className="panel-subtitle">Ranks the stronger game from stored history, not raw counts.</p>
          </div>

          <div
            style={{
              padding: 18,
              borderRadius: 22,
              background: 'radial-gradient(circle at top, rgba(0,255,136,0.12), rgba(13,18,28,0.94) 55%)',
              border: '1px solid rgba(0,255,136,0.28)',
              display: 'grid',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#93a6bf' }}>Top pick</div>
            <div style={{ fontSize: 30, fontWeight: 900, color: '#f7fbff', lineHeight: 1.08 }}>{heroTitle}</div>
            <div style={{ fontSize: 14, color: '#a8b8cc', lineHeight: 1.6 }}>{heroNote}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 12 }}>
            <MiniStat
              label="Sample"
              accent="#00d4ff"
              value={recommendedSite ? fmtCount(recommendedSite.totalRounds || 0) : '--'}
              sublabel="Tracked rounds"
            />
            <MiniStat
              label="Rate"
              accent="#00ff88"
              value={recommendedSite ? `${fmtNumber(recommendedSite.bandRate * 100, 1)}%` : '--'}
              sublabel="3x / 4x / 5x combined"
            />
            <MiniStat
              label="Gap"
              accent="#ffd84d"
              value={recommendedSite ? `${fmtNumber(recommendedSite.gapFit * 100, 0)}%` : '--'}
              sublabel="Short-gap fit"
            />
          </div>

          <div
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#93a6bf' }}>
              Play logic
            </div>
            <div style={{ fontSize: 14, color: '#f7fbff', fontWeight: 700, lineHeight: 1.5 }}>
              Highest combined 3x / 4x / 5x hit rate wins, then sample size, then short-gap fit.
            </div>
            <div style={{ fontSize: 12, color: '#8fa0ba', lineHeight: 1.5 }}>
              This keeps a game with 20 hits out of 50 ahead of a game with 30 hits out of 100.
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#93a6bf', marginBottom: 8 }}>
              Last update
            </div>
            <div style={{ fontSize: 14, color: '#f7fbff', fontWeight: 700 }}>
              {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : 'Waiting for backend'}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
