// components/MultiplierChart.jsx
import React, { useMemo, memo } from 'react';

const BUCKETS = [
  { label: '<2x',    min: 0,   max: 2,        color: '#ff4444' },
  { label: '2-5x',   min: 2,   max: 5,        color: '#ff8844' },
  { label: '5-10x',  min: 5,   max: 10,       color: '#ffaa00' },
  { label: '10-20x', min: 10,  max: 20,       color: '#aaff00' },
  { label: '20-50x', min: 20,  max: 50,       color: '#00ff88' },
  { label: '50-100x',min: 50,  max: 100,      color: '#00ffff' },
  { label: '100x+',  min: 100, max: Infinity, color: '#ff00ff' },
];

const MultiplierChart = memo(function MultiplierChart({ rounds, totalTracked }) {
  const data = useMemo(() => {
    if (!rounds.length) return BUCKETS.map(b => ({ ...b, count: 0, pct: 0, barPct: 0 }));

    // FIX: was running 7 separate .filter() passes over the full array (O(7n)).
    // Now does a single pass O(n) — critical when rounds.length is 8000+.
    const counts = new Array(BUCKETS.length).fill(0);
    for (let i = 0; i < rounds.length; i++) {
      const m = rounds[i].multiplier;
      // Buckets are ordered low→high so we can break early
      for (let b = 0; b < BUCKETS.length; b++) {
        if (m >= BUCKETS[b].min && m < BUCKETS[b].max) {
          counts[b]++;
          break;
        }
      }
    }

    const total    = rounds.length;
    const maxCount = Math.max(...counts, 1);
    return BUCKETS.map((b, i) => ({
      ...b,
      count:  counts[i],
      pct:    (counts[i] / total) * 100,
      barPct: (counts[i] / maxCount) * 100,
    }));
  }, [rounds]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">📈</span>
        <h2>DISTRIBUTION</h2>
      </div>
      <p className="panel-subtitle">
        Multiplier frequency from {(totalTracked || rounds.length).toLocaleString()} rounds
      </p>
      <div className="chart-rows">
        {data.map((d) => (
          <div key={d.label} className="chart-row">
            <div className="chart-label">{d.label}</div>
            <div className="chart-bar-wrap">
              <div
                className="chart-bar"
                style={{ width: `${d.barPct}%`, background: d.color }}
              />
            </div>
            <div className="chart-pct" style={{ color: d.color }}>
              {d.pct.toFixed(1)}%
            </div>
            <div className="chart-count">{d.count.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default MultiplierChart;