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

const DISTRIBUTION_KEYS = ['lt2', 'b2_5', 'b5_10', 'b10_20', 'b20_50', 'b50_100', 'gt100'];

const MultiplierChart = memo(function MultiplierChart({ rounds, totalTracked, distribution }) {
  const data = useMemo(() => {
    const hasDistribution = Boolean(distribution && typeof distribution === 'object');
    if (hasDistribution) {
      const counts = DISTRIBUTION_KEYS.map((k) => Number(distribution[k] || 0));
      const sumCounts = counts.reduce((acc, v) => acc + v, 0);
      const total = Math.max(1, Number(totalTracked || sumCounts));
      const maxCount = Math.max(...counts, 1);
      return BUCKETS.map((b, i) => ({
        ...b,
        count: counts[i],
        pct: (counts[i] / total) * 100,
        barPct: (counts[i] / maxCount) * 100,
      }));
    }

    if (!rounds.length) return BUCKETS.map(b => ({ ...b, count: 0, pct: 0, barPct: 0 }));

    const counts = new Array(BUCKETS.length).fill(0);
    for (let i = 0; i < rounds.length; i++) {
      const m = rounds[i].multiplier;
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
  }, [distribution, rounds, totalTracked]);

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
