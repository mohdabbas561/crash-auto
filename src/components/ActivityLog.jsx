// components/ActivityLog.jsx
import React from 'react';

export default function ActivityLog({ log }) {
  return (
    <div className="panel log-panel">
      <div className="panel-header">
        <span className="panel-icon">📋</span>
        <h2>ACTIVITY LOG</h2>
      </div>
      <div className="log-scroll">
        {log.length === 0 && <div className="no-data">No activity yet</div>}
        {log.map((entry) => (
          <div key={entry.id} className={`log-entry log-${entry.type}`}>
            <span className="log-ts">[{entry.ts}]</span>
            <span className="log-dot">●</span>
            <span className="log-msg">{entry.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
