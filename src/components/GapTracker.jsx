// components/GapTracker.jsx
import React from 'react';

const TARGETS = [2, 5, 10, 20, 25, 30, 50, 100, 200, 500, 1000];

function getGapColor(target, gap) {
  const thresholds = {
    2: [10, 20], 5: [15, 30], 10: [20, 40], 20: [25, 50],
    25: [30, 60], 30: [35, 70], 50: [40, 80], 100: [50, 100],
    200: [60, 120], 500: [80, 160], 1000: [100, 200],
  };
  const [warn, hot] = thresholds[target] || [50, 100];
  if (gap >= hot) return '#ff4444';
  if (gap >= warn) return '#ffaa00';
  return '#00ff88';
}

export default function GapTracker({ gaps }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">🎯</span>
        <h2>GAP TRACKER</h2>
      </div>
      <p className="panel-subtitle">Rounds since last hit</p>
      <div className="gap-grid">
        {TARGETS.map((target) => {
          const gap = gaps[target] ?? '—';
          const color = typeof gap === 'number' ? getGapColor(target, gap) : '#555';
          return (
            <div key={target} className="gap-cell" style={{ '--gap-color': color }}>
              <div className="gap-label">Since {target}x</div>
              <div className="gap-value" style={{ color }}>{gap}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
