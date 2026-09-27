import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API_URL = (process.env.REACT_APP_API_URL || '').replace(/\/$/, '');
const POLL_INTERVAL = 12000;
const HISTORY_STEP = 10;
const TARGET_ORDER = ['5x', '10x', '20x', '50x', '100x', '500x', '1000x'];

function pct(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function statusColor(status) {
  if (status === 'window-open') return '#00d4ff';
  if (status === 'locked') return '#00ff88';
  return '#ffd84d';
}

function statusLabel(status) {
  if (status === 'window-open') return 'OPEN';
  if (status === 'locked') return 'LOCKED';
  return 'WAIT';
}

function outcomeColor(outcome) {
  if (outcome === 'win') return '#00ff88';
  if (outcome === 'early') return '#ff8c42';
  if (outcome === 'loss') return '#ff4560';
  return '#777';
}

function targetColor(target) {
  const map = {
    5: '#00ff88',
    10: '#00d4ff',
    20: '#ffd84d',
    50: '#ff8c42',
    100: '#ff4560',
    500: '#c084fc',
    1000: '#7aa2ff',
  };
  return map[Number(target)] || '#00ff88';
}

function describeStatus(target) {
  if (target.status === 'window-open') {
    return `Window open now (${target.window.roundsLeftInWindow} rounds left)`;
  }
  if (target.status === 'locked') {
    return `Re-locked: +${target.window.aheadLo} to +${target.window.aheadHi} rounds`;
  }
  return `Starts in ${target.window.roundsUntilWindow} rounds`;
}

export default function PredictionSection() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [historyTargetFilter, setHistoryTargetFilter] = useState('all');
  const [historyVisible, setHistoryVisible] = useState(HISTORY_STEP);

  const loadLockedPreds = useCallback(async (silent = false) => {
    if (!API_URL) {
      setError('REACT_APP_API_URL is not configured');
      setLoading(false);
      return;
    }

    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const params = new URLSearchParams();
      if (historyTargetFilter !== 'all') params.set('historyTarget', historyTargetFilter);
      const qs = params.toString();
      const res = await fetch(`${API_URL}/predict/locked${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Locked prediction request failed');
      setReport(data);
      setError('');
    } catch (e) {
      setError(e.message || 'Locked prediction request failed');
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, [historyTargetFilter]);

  useEffect(() => {
    loadLockedPreds(false);
    const id = setInterval(() => loadLockedPreds(true), POLL_INTERVAL);
    return () => clearInterval(id);
  }, [loadLockedPreds]);

  useEffect(() => {
    setHistoryVisible(HISTORY_STEP);
  }, [historyTargetFilter]);

  const generatedAt = useMemo(() => {
    if (!report?.generatedAt) return '-';
    try {
      return new Date(report.generatedAt).toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return '-';
    }
  }, [report?.generatedAt]);

  const targets = report?.targets || [];
  const filteredHistory = useMemo(() => report?.history || [], [report?.history]);
  const visibleHistoryRows = filteredHistory.slice(0, historyVisible);
  const canShowMoreHistory = historyVisible < filteredHistory.length;

  const historyStats = useMemo(() => {
    const rows = filteredHistory;
    const counts = rows.reduce((acc, h) => {
      if (h.outcome === 'win') acc.win++;
      else if (h.outcome === 'loss') acc.loss++;
      else if (h.outcome === 'early') acc.early++;
      return acc;
    }, { win: 0, loss: 0, early: 0 });
    const denom = counts.win + counts.loss;
    return {
      ...counts,
      total: rows.length,
      accuracy: denom > 0 ? counts.win / denom : null,
    };
  }, [filteredHistory]);

  const historySummary = report?.historySummary || historyStats;
  const targetStatMap = report?.historyByTarget || {};

  return (
    <main className="pred-v2-page">
      <div className="panel pred-v2-panel pred-lock-panel">
        <div className="panel-header">
          <span className="panel-icon">AI</span>
          <h2>LOCKED RANGE ENGINE</h2>
          <div className="pred-v2-meta-tag">{refreshing ? 'UPDATING' : 'LIVE LOCKS'}</div>
        </div>

        <p className="panel-subtitle">
          Locked windows auto re-calc from real history on each hit, miss, or early hit.
        </p>

        {loading && !report && (
          <div className="pred-v2-empty">Building locked windows from historical data...</div>
        )}

        {!loading && error && !report && (
          <div className="pred-v2-empty pred-v2-error">Prediction offline: {error}</div>
        )}

        {report && (
          <>
            {error && <div className="pred-v2-inline-error">Last update error: {error}</div>}

            <section className="pred-lock-meta-strip">
              <div className="pred-lock-meta-cell">
                <span>Round</span>
                <b>#{report.asOfRound}</b>
              </div>
              <div className="pred-lock-meta-cell">
                <span>Generated</span>
                <b>{generatedAt}</b>
              </div>
              <div className="pred-lock-meta-cell">
                <span>Model</span>
                <b>{report.model}</b>
              </div>
              <div className="pred-lock-meta-cell">
                <span>History</span>
                <b>{String(report.historyStorage || 'postgres').toUpperCase()}</b>
              </div>
              <div className="pred-lock-meta-cell">
                <span>Trained</span>
                <b>{report.sampleSize?.toLocaleString?.() || 0}</b>
              </div>
              <div className="pred-lock-meta-cell">
                <span>Saved This Tick</span>
                <b>{report.savedResolvedCount || 0}</b>
              </div>
            </section>

            <section className="pred-lock-strip-list">
              {targets.map((t) => (
                <article
                  key={t.target}
                  className="pred-lock-strip"
                  style={{ '--target-color': targetColor(t.target) }}
                >
                  <div className="pred-lock-strip-main">
                    <div className="pred-lock-strip-target">{t.targetLabel}</div>
                    <div className="pred-lock-strip-window">R{t.window.lo} - R{t.window.hi}</div>
                  </div>
                  <div className="pred-lock-strip-status-wrap">
                    <div className="pred-lock-strip-status" style={{ color: statusColor(t.status), borderColor: `${statusColor(t.status)}66` }}>
                      {statusLabel(t.status)}
                    </div>
                    <div className="pred-lock-strip-sub">{describeStatus(t)}</div>
                  </div>
                  <div className="pred-lock-strip-right">
                    <div className="pred-lock-strip-conf">Conf {pct(t.confidence)}</div>
                    {t.previousOutcome && (
                      <div className="pred-lock-strip-last" style={{ color: outcomeColor(t.previousOutcome.outcome) }}>
                        Last {String(t.previousOutcome.outcome).toUpperCase()}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>

            <section className="pred-v2-card pred-lock-history-card">
              <div className="pred-lock-history-top">
                <div className="pred-v2-card-title">History + Accuracy</div>
                <select
                  className="pred-lock-filter"
                  value={historyTargetFilter}
                  onChange={(e) => setHistoryTargetFilter(e.target.value)}
                >
                  <option value="all">All Targets</option>
                  <option value="5x">5x</option>
                  <option value="10x">10x</option>
                  <option value="20x">20x</option>
                  <option value="50x">50x</option>
                  <option value="100x">100x</option>
                  <option value="500x">500x</option>
                  <option value="1000x">1000x</option>
                </select>
              </div>

              <div className="pred-lock-history-stats">
                <div className="pred-lock-history-stat">
                  <span>Accuracy (Hit/Miss)</span>
                  <b>{historySummary.accuracy == null ? '-' : pct(historySummary.accuracy)}</b>
                </div>
                <div className="pred-lock-history-stat"><span>Win</span><b>{historySummary.win || 0}</b></div>
                <div className="pred-lock-history-stat"><span>Miss</span><b>{historySummary.loss || 0}</b></div>
                <div className="pred-lock-history-stat"><span>Early</span><b>{historySummary.early || 0}</b></div>
                <div className="pred-lock-history-stat"><span>Rows</span><b>{historySummary.total || 0}</b></div>
              </div>

              <div className="pred-lock-mini-acc-strip">
                {TARGET_ORDER.map((label) => {
                  const s = targetStatMap[label] || { win: 0, loss: 0, early: 0, accuracy: null };
                  return (
                    <div key={label} className="pred-lock-mini-acc-item">
                      <span>{label}</span>
                      <b>{s.accuracy == null ? '-' : pct(s.accuracy)}</b>
                    </div>
                  );
                })}
              </div>

              {visibleHistoryRows.length === 0 && <div className="pred-v2-small">No resolved locks yet.</div>}
              {visibleHistoryRows.map((h) => (
                <div key={h.id} className="pred-lock-history-row">
                  <span>{h.target}</span>
                  <span>R{h.lo}-R{h.hi}</span>
                  <span style={{ color: outcomeColor(h.outcome), fontWeight: 800 }}>{String(h.outcome).toUpperCase()}</span>
                  <span>{h.hitRound ? `hit R${h.hitRound}` : '-'}</span>
                  <span>G{h.generation}</span>
                </div>
              ))}

              {canShowMoreHistory && (
                <button
                  className="pred-lock-show-more"
                  onClick={() => setHistoryVisible(v => v + HISTORY_STEP)}
                >
                  Show More
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
