import React from 'react';

export default function GlobalStats({ stats }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">📊</span>
        <h2>GLOBAL STATS</h2>
      </div>
      <div className="stats-grid">
        <div className="stat-cell">
          <div className="stat-label">Tracked Rounds</div>
          <div className="stat-value green">{stats.tracked ?? 0}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Avg Multiplier</div>
          <div className="stat-value yellow">{stats.avg ?? '—'}x</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Highest Crash</div>
          <div className="stat-value red">{stats.highest ?? '—'}x</div>
        </div>
        <div className="stat-cell">
          <div className="stat-label">Current Round</div>
          <div className="stat-value cyan">#{stats.currentRound ?? '—'}</div>
        </div>
      </div>
    </div>
  );
}