import React, { useState } from 'react';

export default function ControlPanel({ status, isPolling, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    onRefresh();
    setTimeout(() => setRefreshing(false), 1500);
  };

  const statusColor = {
    idle: '#666', loading: '#ffaa00', connected: '#00ff88', error: '#ff4444',
  }[status] || '#666';

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-icon">🤖</span>
        <h2>BOT CONTROL</h2>
      </div>

      <div className="status-bar" style={{ borderColor: statusColor }}>
        <span className="status-dot" style={{ background: statusColor }} />
        <span style={{ color: statusColor, textTransform: 'uppercase', fontSize: 12, fontWeight: 700 }}>
          {status}
        </span>
        {isPolling && <span className="polling-badge">● LIVE</span>}
      </div>

      <button
        className={`btn btn-refresh ${refreshing ? 'btn-refreshing' : ''}`}
        onClick={handleRefresh}
        disabled={refreshing}
        style={{ width: '100%', marginTop: 12 }}>
        {refreshing ? '↻ Refreshing...' : '↻ REFRESH NOW'}
      </button>
    </div>
  );
}