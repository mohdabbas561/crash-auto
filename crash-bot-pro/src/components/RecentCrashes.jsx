// components/RecentCrashes.jsx
import React, { memo } from 'react';

function multiplierColor(m) {
  if (m >= 100) return '#ff00ff';
  if (m >= 10)  return '#00ffff';
  if (m >= 5)   return '#00ff88';
  if (m >= 2)   return '#ffaa00';
  return '#ff4444';
}

// FIX: was doing [...rounds].reverse().slice(0,30) — copies the entire array
// (could be 8000+ rounds) on every render. Now slices from the end directly.
const RecentCrashes = memo(function RecentCrashes({ rounds, limit = 30 }) {
  const safeLimit = Math.max(1, Number(limit) || 30);
  const recent = rounds.slice(-safeLimit).reverse();

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">💥</span>
        <h2>RECENT CRASHES</h2>
      </div>
      <p className="panel-subtitle">Last {Math.min(safeLimit, recent.length)} game results</p>
      <div className="crash-grid">
        {recent.length === 0 && <div className="no-data">No data yet — start polling</div>}
        {recent.map((r, i) => (
          <div
            key={r.roundId ?? i}
            className="crash-pill"
            style={{
              '--pill-color': multiplierColor(r.multiplier),
              backgroundColor: multiplierColor(r.multiplier) + '22',
              border: `1px solid ${multiplierColor(r.multiplier)}`,
              color: multiplierColor(r.multiplier),
            }}
            title={`Round #${r.roundId}`}
          >
            {r.multiplier.toFixed(2)}x
          </div>
        ))}
      </div>
    </div>
  );
});

export default RecentCrashes;
