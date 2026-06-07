import React, { useCallback, useEffect, useRef, useState } from 'react';

const LIVE_PHASE = {
  IDLE: 0,
  WAITING: 1,
  RUNNING: 2,
  CRASHED: 3,
  UNKNOWN: 999,
};

const LIVE_PHASE_LABEL = {
  [LIVE_PHASE.IDLE]: 'IDLE',
  [LIVE_PHASE.WAITING]: 'WAITING',
  [LIVE_PHASE.RUNNING]: 'RUNNING',
  [LIVE_PHASE.CRASHED]: 'CRASHED',
  [LIVE_PHASE.UNKNOWN]: 'SYNCING',
};

const PAD = { left: 48, right: 20, top: 28, bottom: 20 };
const GRID_MULTS = [1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000];

function fmtMult(value) {
  const n = Number(value || 1);
  if (!Number.isFinite(n) || n <= 0) return '1.00x';
  return `${n.toFixed(2)}x`;
}

function fmtRecent(multiplier) {
  const n = Number(multiplier || 0);
  if (!Number.isFinite(n) || n <= 0) return '--';
  return fmtMult(n);
}

function fmtCountdown(ms) {
  const s = Math.ceil(Math.max(0, Number(ms || 0)) / 1000);
  if (s <= 0) return '0s';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function nextYMax(currentPeak) {
  const thresholds = [2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000];
  for (const threshold of thresholds) {
    if (currentPeak * 1.1 < threshold) return threshold;
  }
  return currentPeak * 2;
}

export default function CrashLivePanel({
  liveState,
  recentResolved,
  botRunning,
  canCashout = false,
  cashoutBusy = false,
  onCashout = null,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const liveStateRef = useRef(liveState);
  const resizeTimerRef = useRef(null);
  const scaleRef = useRef({ yMax: 2, tSpan: 3000 });
  const prevPhaseRef = useRef(null);

  liveStateRef.current = liveState;

  useEffect(() => {
    const phase = liveState?.phase;
    if (phase === LIVE_PHASE.RUNNING && prevPhaseRef.current !== LIVE_PHASE.RUNNING) {
      scaleRef.current = { yMax: 2, tSpan: 3000 };
    }
    prevPhaseRef.current = phase;
  }, [liveState?.phase]);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 0;
    const height = canvas.parentElement?.clientHeight || 0;
    if (!width || !height) return;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }, []);

  useEffect(() => {
    setupCanvas();
    const onResize = () => {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(setupCanvas, 60);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimerRef.current);
    };
  }, [setupCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const draw = (now) => {
      rafRef.current = requestAnimationFrame(draw);

      const ls = liveStateRef.current;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      const chartWidth = width - PAD.left - PAD.right;
      const chartHeight = height - PAD.top - PAD.bottom;
      const floorY = PAD.top + chartHeight;
      const originX = PAD.left;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      const phase = ls?.phase;
      const isRunning = phase === LIVE_PHASE.RUNNING;
      const isCrashed = phase === LIVE_PHASE.CRASHED;
      const trace = Array.isArray(ls?.trace) ? ls.trace : [];
      const points = trace.map((point) => ({
        t: Number(point.ts || 0),
        v: Math.max(1, Number(point.value || 1)),
      }));

      if (points.length) {
        const peak = Math.max(...points.map((point) => point.v));
        const neededY = nextYMax(peak);
        if (neededY > scaleRef.current.yMax) scaleRef.current.yMax = neededY;
      }

      if (points.length >= 2) {
        const span = points[points.length - 1].t - points[0].t;
        const neededSpan = Math.max(span * 1.05, 3000);
        if (neededSpan > scaleRef.current.tSpan) scaleRef.current.tSpan = neededSpan;
      }

      const { yMax, tSpan } = scaleRef.current;
      const tStart = points.length ? points[0].t : 0;

      const toY = (value) => {
        const logV = Math.log(Math.max(value, 1));
        const logMax = Math.log(yMax);
        const norm = logMax > 0 ? Math.min(logV / logMax, 1) : 0;
        return floorY - norm * chartHeight;
      };

      const toX = (value) => PAD.left + (((value - tStart) / tSpan) * chartWidth);

      ctx.save();
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const gridValue of GRID_MULTS) {
        if (gridValue > yMax * 1.05) break;
        const y = toY(gridValue);
        if (y < PAD.top - 4 || y > floorY + 4) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + chartWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(gridValue >= 10 ? `${gridValue}x` : `${gridValue.toFixed(1)}x`, PAD.left - 6, y);
      }
      ctx.restore();

      if (points.length < 2) {
        const pulse = 0.5 + (0.5 * Math.sin(now * 0.004));
        ctx.beginPath();
        ctx.arc(originX, floorY, 6 + (2 * pulse), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,255,136,${0.08 + (0.06 * pulse)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(originX, floorY, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#00ff88';
        ctx.fill();
        return;
      }

      const chartPoints = points.map((point) => ({ x: toX(point.t), y: toY(point.v) }));
      const tip = chartPoints[chartPoints.length - 1];
      const GREEN = '#00ff88';
      const RED = '#ff3333';
      const lineColor = isCrashed ? RED : GREEN;

      const fillGradient = ctx.createLinearGradient(0, PAD.top, 0, floorY);
      if (isCrashed) {
        fillGradient.addColorStop(0, 'rgba(255,51,51,0.14)');
        fillGradient.addColorStop(0.7, 'rgba(255,51,51,0.03)');
        fillGradient.addColorStop(1, 'rgba(255,51,51,0.00)');
      } else {
        fillGradient.addColorStop(0, 'rgba(0,255,136,0.10)');
        fillGradient.addColorStop(0.7, 'rgba(0,255,136,0.02)');
        fillGradient.addColorStop(1, 'rgba(0,255,136,0.00)');
      }

      ctx.beginPath();
      ctx.moveTo(originX, floorY);
      for (const point of chartPoints) ctx.lineTo(point.x, point.y);
      ctx.lineTo(tip.x, floorY);
      ctx.lineTo(originX, floorY);
      ctx.closePath();
      ctx.fillStyle = fillGradient;
      ctx.fill();

      if (!isCrashed) {
        ctx.beginPath();
        ctx.moveTo(originX, floorY);
        for (const point of chartPoints) ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = 'rgba(0,255,136,0.12)';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      ctx.save();
      ctx.shadowColor = isCrashed ? 'rgba(255,51,51,0.5)' : 'rgba(0,255,136,0.5)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(originX, floorY);
      for (const point of chartPoints) ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      if (isCrashed && tip) {
        ctx.save();
        ctx.shadowColor = 'rgba(255,51,51,0.5)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x, floorY);
        ctx.strokeStyle = RED;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }

      if (isRunning && tip) {
        const pulse = 0.5 + (0.5 * Math.sin(now * 0.005));
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 9 + (2 * pulse), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,255,136,${0.05 + (0.04 * pulse)})`;
        ctx.fill();
        ctx.save();
        ctx.shadowColor = GREEN;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = GREEN;
        ctx.fill();
        ctx.restore();
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const phase = liveState?.phase;
  const isCrashed = phase === LIVE_PHASE.CRASHED;
  const isRunning = phase === LIVE_PHASE.RUNNING;
  const phaseLabel = LIVE_PHASE_LABEL[phase] ?? LIVE_PHASE_LABEL[LIVE_PHASE.UNKNOWN];
  const connectionLabel = liveState?.connectionOpen ? 'LIVE' : (liveState?.connectionState || 'SYNCING');
  const currentValue = Math.max(1, Number(liveState?.multiplier || 1));
  const recentItems = (recentResolved || []).slice(0, 12);

  const timeLeftMs = liveState?.nextGameDelayMs
    ? Math.max(0, liveState.nextGameDelayMs - (now - (liveState.nextGameDelayStartedAt || now)))
    : liveState?.betsClosingAt
      ? Math.max(0, liveState.betsClosingAt - now)
      : 0;

  const countdownTotal = Math.max(
    0,
    Number(liveState?.countdownTotalMs || 0),
    Number(liveState?.nextGameDelayMs || 0),
    timeLeftMs
  );
  const countdownRatio = countdownTotal > 0
    ? Math.max(0, Math.min(1, 1 - (timeLeftMs / countdownTotal)))
    : 0;

  let timerLabel = 'WAITING';
  if (isRunning) timerLabel = 'RUNNING';
  else if (timeLeftMs) timerLabel = `NEXT ROUND IN ${fmtCountdown(timeLeftMs)}`;

  const showCashoutAction = typeof onCashout === 'function';
  const multStyle = {
    fontSize: 'clamp(36px, 5vw, 54px)',
    fontWeight: 900,
    lineHeight: 1,
    letterSpacing: '-0.5px',
    color: isCrashed ? '#ff4444' : '#ffffff',
    textShadow: isCrashed
      ? '0 0 12px rgba(255,68,68,0.5)'
      : '0 0 12px rgba(0,255,136,0.35)',
  };

  return (
    <div className="panel bot-live-panel">
      <div className="panel-header">
        <span className="panel-icon">LIVE</span>
        <h2>LIVE CRASH</h2>
        <span className={`bot-status-badge ${botRunning ? 'running' : ''}`}>
          {botRunning ? 'BOT ARMED' : 'VIEW ONLY'}
        </span>
      </div>

      <div className="bot-live-shell bot-live-shell-wide">
        <div className="bot-live-topbar">
          <div className="bot-live-strip">
            {recentItems.map((item) => (
              <div key={item.roundId} className="bot-live-chip">
                {fmtRecent(item.multiplier)}
              </div>
            ))}
          </div>
          <div className="bot-live-meta bot-live-meta-top">
            <span className={`bot-live-badge ${liveState?.connectionOpen ? 'online' : 'offline'}`}>
              {connectionLabel}
            </span>
            <span className={`bot-live-badge phase-${String(phaseLabel).toLowerCase()}`}>
              {phaseLabel}
            </span>
          </div>
        </div>

        <div className={`bot-live-stage bot-live-stage-wide${isCrashed ? ' phase-crashed' : isRunning ? ' phase-running' : ''}`}>
          {countdownTotal > 0 ? (
            <div className="bot-live-progress">
              <div
                className="bot-live-progress-fill"
                style={{ width: `${Math.max(6, countdownRatio * 100)}%` }}
              />
            </div>
          ) : null}

          <div className="bot-live-readout">
            <div className="bot-live-official-tag">OFFICIAL DCF</div>
            <div style={multStyle}>{fmtMult(currentValue)}</div>
            {isCrashed
              ? <div className="bot-live-crashed-label" style={{ marginTop: 8 }}>CRASHED</div>
              : <div className="bot-live-sub" style={{ marginTop: 8 }}>{timerLabel}</div>}
          </div>

          <div className="bot-live-canvas-wrap">
            <canvas ref={canvasRef} />
          </div>
        </div>

        {showCashoutAction ? (
          <div className="bot-live-actions">
            <button
              type="button"
              className={`bot-live-cashout-btn${canCashout ? ' active' : ''}`}
              onClick={onCashout}
              disabled={!canCashout || cashoutBusy}
            >
              {cashoutBusy ? 'SENDING...' : canCashout ? 'CASHOUT' : 'WAITING'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
