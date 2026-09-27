import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  bs58Decode, bs58Encode,
  buildAndSignTransaction,
  getRecentBlockhash, getBalance,
} from '../utils/solana';

const DEFAULT_RPC   = process.env.REACT_APP_RPC_URL || '';
const TX_FEE_BUFFER = 0.001 * 1e9;

function lamportsToSol(l) { return (l / 1e9).toFixed(4); }
function solToLamports(s) { return Math.round(parseFloat(s) * 1e9); }

const API_BASE    = 'https://api.dealer.degencoinflip.com/v1/game/2/room/1';
const CASHOUT_API = 'https://crash-api.degencoinflip.com/api/status/set_cashout_multiplier';

async function setCashoutOnServer(multiplier, token) {
  const formatted = parseFloat(multiplier).toFixed(3);
  const res = await fetch(CASHOUT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify({ multiplier: formatted }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.status);
    throw new Error(`Cashout error (${res.status}): ${err}`);
  }
  return true;
}

async function waitForActiveRound(stopRef, lastPlayedRoundId) {
  while (!stopRef.current) {
    try {
      const res  = await fetch(`${API_BASE}/rounds?limit=1`);
      if (!res.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
      const json = await res.json();

      // Real API: { message: "WAGMI", payload: [ { roundId, gameResult, ... } ] }
      const round = json.payload?.[0];
      if (!round) { await new Promise(r => setTimeout(r, 500)); continue; }

      const { roundId, gameResult } = round;

      // gameResult is null when round is open for bets, number when finished
      const isOpen = gameResult === null;

      if (roundId === lastPlayedRoundId || !isOpen) {
        await new Promise(r => setTimeout(r, 500)); continue;
      }

      return { roundId, playerCount: Object.keys(round.players || {}).length };
    } catch (e) { /* silent retry */ }
    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

async function waitForRoundResult(roundId, cashoutMultiplier, stopRef, timeoutMs = 90000) {
  const start = Date.now();
  while (!stopRef.current && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const res  = await fetch(`${API_BASE}/rounds?limit=10`);
      if (!res.ok) continue;
      const json = await res.json();
      // Real API: { message: "WAGMI", payload: [...] }
      const list = json.payload ?? [];
      const done = list.find(r => r.roundId === roundId && r.gameResult !== null);
      if (done) {
        const crashPoint = parseFloat(done.gameResult);
        return { won: crashPoint >= cashoutMultiplier, crashPoint, roundId: done.roundId };
      }
    } catch {}
  }
  return null;
}

async function sendTx(rpcUrl, txBytes) {
  let b64 = '';
  for (let i = 0; i < txBytes.length; i += 8192)
    b64 += String.fromCharCode(...txBytes.slice(i, i + 8192));
  b64 = btoa(b64);
  const res  = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'TX error');
  return json.result;
}

const API_URL   = process.env.REACT_APP_API_URL || '';
const ADMIN_HDR = { 'Content-Type': 'application/json', 'x-admin-secret': process.env.REACT_APP_ADMIN_SECRET || '' };

export default function WalletBot() {
  const [privateKey, setPrivateKey]             = useState(process.env.REACT_APP_PRIVATE_KEY || '');
  const [rpcUrl, setRpcUrl]                     = useState(DEFAULT_RPC);
  const [playerAccountPDA, setPlayerAccountPDA] = useState(process.env.REACT_APP_PLAYER_PDA || '');
  const [jwtToken, setJwtToken]                 = useState('');
  const [betSol, setBetSol]                     = useState('0.01');
  const [targetMultiplier, setTargetMultiplier] = useState('2');
  const [stopLossCount, setStopLossCount]       = useState('10');
  const [maxRounds, setMaxRounds]               = useState('0');
  const [walletInfo, setWalletInfo]             = useState(null);
  const [isRunning, setIsRunning]               = useState(false);
  const [showKey, setShowKey]                   = useState(false);
  const [showJwt, setShowJwt]                   = useState(false);
  const [stats, setStats]                       = useState({ rounds: 0, wins: 0, losses: 0, pnl: 0 });
  const [botLog, setBotLog]                     = useState([]);

  const stopRef  = useRef(false);
  const statsRef = useRef({ rounds: 0, wins: 0, losses: 0, pnl: 0 });

  const addLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    setBotLog(prev => [{ ts, msg, type, id: Date.now() + Math.random() }, ...prev].slice(0, 150));
  }, []);

  // Load saved wallet config from DB on mount
  useEffect(() => {
    fetch(`${API_URL}/wallets`, { headers: { 'x-admin-secret': process.env.REACT_APP_ADMIN_SECRET || '' } })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.wallets?.length > 0) {
          const w = d.wallets[0]; // load most recent
          if (w.private_key)        setPrivateKey(w.private_key);
          if (w.rpc_url)            setRpcUrl(w.rpc_url);
          if (w.player_account_pda) setPlayerAccountPDA(w.player_account_pda);
        }
      })
      .catch(() => {})
      .finally(() => { if (privateKey && rpcUrl) loadWallet(); });
  }, []); // eslint-disable-line

  const loadWallet = useCallback(async () => {
    if (!privateKey.trim()) { addLog('Wallet key required', 'error'); return; }
    try {
      const kb = bs58Decode(privateKey.trim());
      if (kb.length !== 64) throw new Error('Invalid key length');
      const pubkey  = bs58Encode(kb.slice(32));
      const balance = await getBalance(rpcUrl, pubkey);
      setWalletInfo({ pubkey, balance });
      addLog(`Wallet loaded: ${pubkey.slice(0,8)}...${pubkey.slice(-6)}`, 'success');
      addLog(`Balance: ${lamportsToSol(balance)} SOL`, 'info');
      // Auto-save config to DB
      fetch(`${API_URL}/wallets`, {
        method: 'POST', headers: ADMIN_HDR,
        body: JSON.stringify({ privateKey: privateKey.trim(), rpcUrl, playerAccountPDA, pubkey }),
      }).catch(() => {});
    } catch (e) { addLog('Wallet error: ' + e.message, 'error'); setWalletInfo(null); }
  }, [privateKey, rpcUrl, playerAccountPDA, addLog]); // eslint-disable-line

  const startBot = useCallback(async () => {
    if (!privateKey.trim())       { addLog('Wallet key required', 'error'); return; }
    if (!playerAccountPDA.trim()) { addLog('Player account required', 'error'); return; }
    if (!rpcUrl.trim())           { addLog('RPC endpoint required', 'error'); return; }
    if (!jwtToken.trim())         { addLog('Auth token required', 'error'); return; }

    let keypairBytes;
    try {
      keypairBytes = bs58Decode(privateKey.trim());
      if (keypairBytes.length !== 64) throw new Error('Invalid key');
    } catch (e) { addLog('Key error: ' + e.message, 'error'); return; }

    const betLamports = solToLamports(betSol);
    const cashout     = parseFloat(targetMultiplier);
    const stopLoss    = parseInt(stopLossCount) || 999999;
    const maxR        = parseInt(maxRounds) || 999999;

    if (betLamports < 1000000) { addLog('Min bet 0.001 SOL', 'error'); return; }
    if (cashout < 1.01)        { addLog('Min cashout 1.01x', 'error'); return; }

    const pubkey = bs58Encode(keypairBytes.slice(32));
    stopRef.current  = false;
    statsRef.current = { rounds: 0, wins: 0, losses: 0, pnl: 0 };
    setStats({ ...statsRef.current });
    setIsRunning(true);
    addLog(`Started — ${betSol} SOL @ ${cashout}x | stop loss: ${stopLoss}`, 'success');

    let consecutiveLosses = 0;
    let lastPlayedRoundId = null;

    while (!stopRef.current) {
      const s = statsRef.current;
      if (s.rounds >= maxR && maxR !== 999999)  { addLog(`Max rounds reached`, 'warn'); break; }
      if (consecutiveLosses >= stopLoss)         { addLog(`Stop loss triggered`, 'warn'); break; }

      try {
        const balance = await getBalance(rpcUrl, pubkey);
        setWalletInfo(prev => ({ ...prev, balance }));
        if (balance < betLamports + TX_FEE_BUFFER) {
          addLog(`Insufficient balance: ${lamportsToSol(balance)} SOL`, 'error');
          break;
        }

        addLog('Waiting for next round...', 'info');
        const round = await waitForActiveRound(stopRef, lastPlayedRoundId);
        if (!round || stopRef.current) break;

        lastPlayedRoundId = round.roundId;
        addLog(`Round #${round.roundId} — setting cashout to ${cashout}x...`, 'info');

        try {
          await setCashoutOnServer(targetMultiplier, jwtToken.trim());
          addLog(`Cashout set to ${cashout}x ✓`, 'success');
        } catch (e) {
          addLog(`Cashout warning: ${e.message}`, 'warn');
          if (e.message.includes('401') || e.message.includes('403')) {
            addLog('Auth token expired — please update and restart', 'error');
            break;
          }
          // 500 errors from cashout API are non-fatal — the TX still encodes cashout
        }

        // Wait for betting window to open (typically 3-5s after round detection)
        addLog('Waiting for betting window...', 'info');
        await new Promise(r => setTimeout(r, 3000));
        if (stopRef.current) break;

        // Re-confirm round is still open before sending TX
        try {
          const checkRes   = await fetch(`${API_BASE}/rounds?limit=1`);
          const checkJson  = await checkRes.json();
          const checkRound = checkJson.payload?.[0];
          if (!checkRound || checkRound.roundId !== round.roundId || checkRound.gameResult !== null) {
            addLog(`Round #${round.roundId} already closed — skipping TX`, 'warn');
            continue;
          }
        } catch { /* proceed anyway */ }

        const blockhash = await getRecentBlockhash(rpcUrl);
        const txBytes   = buildAndSignTransaction(keypairBytes, playerAccountPDA, betLamports, cashout, blockhash, round.roundId);
        const sig       = await sendTx(rpcUrl, txBytes);
        addLog(`TX sent: ${sig.slice(0,16)}... — watching for ${cashout}x`, 'success');

        const result = await waitForRoundResult(round.roundId, cashout, stopRef);
        if (!result || stopRef.current) break;

        statsRef.current.rounds++;
        if (result.won) {
          const profit = (betLamports / 1e9) * (cashout - 1);
          statsRef.current.wins++;
          statsRef.current.pnl += profit;
          consecutiveLosses = 0;
          addLog(`WIN — cashed @ ${cashout}x  +${profit.toFixed(4)} SOL`, 'success');
        } else {
          statsRef.current.losses++;
          statsRef.current.pnl -= betLamports / 1e9;
          consecutiveLosses++;
          addLog(`LOSS — crashed @ ${result.crashPoint}x`, 'error');
        }

        setStats({ ...statsRef.current });
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        addLog(`Error: ${e.message}`, 'error');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    stopRef.current = false;
    setIsRunning(false);
    const s = statsRef.current;
    addLog(
      `Stopped — ${s.rounds} rounds | W/L: ${s.wins}/${s.losses} | P&L: ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(4)} SOL`,
      s.pnl >= 0 ? 'success' : 'error'
    );
  }, [privateKey, betSol, targetMultiplier, stopLossCount, maxRounds, playerAccountPDA, rpcUrl, jwtToken, addLog]); // eslint-disable-line

  const stopBot = useCallback(() => {
    stopRef.current = true;
    setIsRunning(false);
    addLog('Stopping...', 'warn');
  }, [addLog]);

  const pnlColor = stats.pnl >= 0 ? '#00ff88' : '#ff4444';

  return (
    <div className="panel wallet-bot-panel">
      <div className="panel-header">
        <span className="panel-icon">🤖</span>
        <h2>AUTO BOT</h2>
        <span className={`bot-status-badge ${isRunning ? 'running' : ''}`}>
          {isRunning ? '● RUNNING' : '○ IDLE'}
        </span>
      </div>

      {/* Wallet */}
      <div className="bot-section">
        <div className="bot-section-title">🔑 WALLET</div>
        <div className="input-group">
          <label>Private Key</label>
          <div className="key-row">
            <input type={showKey ? 'text' : 'password'} value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              placeholder="Enter wallet key" className="bot-input" disabled={isRunning} />
            <button className="btn-icon" onClick={() => setShowKey(s => !s)}>{showKey ? '🙈' : '👁'}</button>
          </div>
        </div>
        <div className="input-group">
          <label>RPC Endpoint</label>
          <input type="text" value={rpcUrl} onChange={e => setRpcUrl(e.target.value)}
            placeholder="https://..." className="bot-input" disabled={isRunning} />
        </div>
        <div className="input-group">
          <label>Player Account</label>
          <input type="text" value={playerAccountPDA} onChange={e => setPlayerAccountPDA(e.target.value)}
            placeholder="Account address" className="bot-input" disabled={isRunning} />
        </div>
        <div className="input-group">
          <label>Auth Token <span className="label-hint">(from browser Network tab)</span></label>
          <div className="key-row">
            <input type={showJwt ? 'text' : 'password'} value={jwtToken}
              onChange={e => setJwtToken(e.target.value)}
              placeholder="Auth token" className="bot-input" disabled={isRunning} />
            <button className="btn-icon" onClick={() => setShowJwt(s => !s)}>{showJwt ? '🙈' : '👁'}</button>
          </div>
        </div>
        <button className="btn btn-refresh" onClick={loadWallet} disabled={isRunning} style={{ width: '100%' }}>
          🔗 LOAD WALLET
        </button>
        {walletInfo && (
          <div className="wallet-info-box">
            <div className="info-row">
              <span>Address</span>
              <span className="green" style={{ fontSize: '10px' }}>
                {walletInfo.pubkey.slice(0,16)}...{walletInfo.pubkey.slice(-8)}
              </span>
            </div>
            <div className="info-row">
              <span>Balance</span>
              <span className="yellow">{lamportsToSol(walletInfo.balance)} SOL</span>
            </div>
          </div>
        )}
      </div>

      {/* Strategy */}
      <div className="bot-section">
        <div className="bot-section-title">⚡ STRATEGY</div>
        <div className="strategy-grid">
          <div className="input-group">
            <label>Bet (SOL)</label>
            <input type="number" value={betSol} onChange={e => setBetSol(e.target.value)}
              step="0.001" min="0.001" className="bot-input" disabled={isRunning} />
          </div>
          <div className="input-group">
            <label>Auto Cashout</label>
            <input type="number" value={targetMultiplier} onChange={e => setTargetMultiplier(e.target.value)}
              step="0.1" min="1.1" className="bot-input" disabled={isRunning} />
          </div>
          <div className="input-group">
            <label>Stop Loss</label>
            <input type="number" value={stopLossCount} onChange={e => setStopLossCount(e.target.value)}
              min="1" className="bot-input" disabled={isRunning} />
          </div>
          <div className="input-group">
            <label>Max Rounds (0=∞)</label>
            <input type="number" value={maxRounds} onChange={e => setMaxRounds(e.target.value)}
              min="0" className="bot-input" disabled={isRunning} />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="bot-section">
        <div className="bot-section-title">📊 SESSION</div>
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(2,1fr)', gap: '8px' }}>
          <div className="stat-cell">
            <div className="stat-label">Rounds</div>
            <div className="stat-value cyan">{stats.rounds}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">W / L</div>
            <div className="stat-value">{stats.wins} / {stats.losses}</div>
          </div>
          <div className="stat-cell" style={{ gridColumn: '1/-1' }}>
            <div className="stat-label">P&L</div>
            <div className="stat-value" style={{ color: pnlColor }}>
              {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(4)} SOL
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="btn-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
        <button className="btn btn-start" onClick={startBot} disabled={isRunning}>
          ▶ START BOT
        </button>
        <button className="btn btn-stop" onClick={stopBot} disabled={!isRunning}>
          ■ STOP
        </button>
      </div>

      {/* Log */}
      <div className="bot-section" style={{ marginTop: '12px' }}>
        <div className="bot-section-title">📋 LOG</div>
        <div className="log-scroll" style={{ maxHeight: '200px' }}>
          {botLog.length === 0 && <div className="no-data">No activity yet</div>}
          {botLog.map(entry => (
            <div key={entry.id} className={`log-entry log-${entry.type}`}>
              <span className="log-ts">[{entry.ts}]</span>
              <span className="log-dot">●</span>
              <span className="log-msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Setup guide — no env/platform hints */}
      <div className="pda-instructions">
        <div className="bot-section-title">ℹ HOW TO GET YOUR AUTH TOKEN</div>
        <ol>
          <li>Open the crash game in your browser</li>
          <li>Open browser developer tools → Network tab</li>
          <li>Change the auto-cashout value on the site</li>
          <li>Find the <strong>set_cashout_multiplier</strong> request</li>
          <li>Copy the <strong>authorization</strong> header value</li>
          <li>Paste it into the Auth Token field above</li>
        </ol>
        <p>⚠ Token expires every ~5 hours. Bot will alert you when it does.</p>
      </div>

      <div className="pda-instructions">
        <div className="bot-section-title">ℹ HOW TO FIND YOUR PLAYER ACCOUNT</div>
        <ol>
          <li>Go to a Solana block explorer</li>
          <li>Search your wallet address</li>
          <li>Click any past Crash bet transaction</li>
          <li>Copy account <strong>[1]</strong> (second writable account)</li>
          <li>Paste it into the Player Account field above</li>
        </ol>
        <p>⚠ Never played before? Make one manual bet first to create your account.</p>
      </div>
    </div>
  );
}
