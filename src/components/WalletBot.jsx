import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../V3.css';
import { API_BASE as BACKEND_API_BASE } from '../config/apiBase';
import {
  bs58Decode,
  bs58Encode,
  buildAndSignTransaction,
  getBalance,
  getWalletTrackingAddresses,
  getRecentBlockhash,
  sendRawTransaction,
} from '../utils/solana';

const TX_FEE_BUFFER = 0.001 * 1e9;
const GAME_API_BASE = 'https://api.dealer.degencoinflip.com/v1/game/2/room/1';
const WALLET_AUTH_API = `${BACKEND_API_BASE}/bot/site-auth`;
const SITE_CASHOUT_API = `${BACKEND_API_BASE}/bot/site-cashout`;
const ORACLE_PREDICT_API = `${BACKEND_API_BASE}/predict/oracle`;
const NONCE_MESSAGE_PREFIX = 'I am signing my one-time nonce: ';
const LIVE_VIEW_WS_URL = 'wss://crashview-api.degencoinflip.com';
const LIVE_PHASE = {
  IDLE: 0,
  WAITING: 1,
  RUNNING: 2,
  CRASHED: 3,
  UNKNOWN: 999,
};
const UI_BUILD_STAMP = '2026-04-01-ui-v16';
const BOT_SESSION_STORAGE_KEY = 'crash-bot-active-session-v1';
const ACCESS_TOKEN_STORAGE_KEY = 'site_access_token';
const PLAY_TARGET_OPTIONS = ['5x', '10x', '15x', '30x', '50x', '100x', '200x', '500x', '1000x'];
const JOIN_WINDOW_SAFETY_MS = 850;
const POST_GATE_SEND_DELAY_MS = 90;
let preferredJoinLayout = 'joinLive';
const cashoutSyncCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCashoutCacheKey(walletId, multiplier) {
  return `${String(walletId || '').trim()}::${String(multiplier || '').trim()}`;
}

function isCashoutAlreadySynced(walletId, multiplier) {
  return cashoutSyncCache.has(getCashoutCacheKey(walletId, multiplier));
}

function rememberCashoutSynced(walletId, multiplier) {
  if (!walletId) return;
  for (const key of [...cashoutSyncCache.keys()]) {
    if (key.startsWith(`${String(walletId).trim()}::`)) {
      cashoutSyncCache.delete(key);
    }
  }
  cashoutSyncCache.set(getCashoutCacheKey(walletId, multiplier), Date.now());
}

function lamportsToSol(lamports) {
  return (lamports / 1e9).toFixed(4);
}

function solToLamports(sol) {
  return Math.round(parseFloat(sol) * 1e9);
}

function bytesToBase64(bytes) {
  let raw = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    raw += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(raw);
}

function normalizeExpiry(exp) {
  if (!exp) return 0;
  const numeric = Number(exp);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1e12 ? numeric : numeric * 1000;
}

function isSessionFresh(session, walletId, minRemainingMs = 120000) {
  if (!session?.idToken || !walletId || session.walletId !== walletId) return false;
  const expiresAt = normalizeExpiry(session.exp);
  if (expiresAt) return expiresAt - Date.now() > minRemainingMs;
  return Date.now() - (session.issuedAt || 0) < 10 * 60 * 1000;
}

function readPersistedBotSession() {
  try {
    const raw = localStorage.getItem(BOT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedBotSession(payload) {
  try {
    localStorage.setItem(BOT_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

function clearPersistedBotSession() {
  try {
    localStorage.removeItem(BOT_SESSION_STORAGE_KEY);
  } catch {}
}

function readAccessCodeFromStorage() {
  const parseCode = (raw) => {
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      return String(parsed?.code || '').trim();
    } catch {
      return '';
    }
  };

  try {
    const fromLocal = parseCode(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY));
    if (fromLocal) return fromLocal;
  } catch {}

  try {
    const fromSession = parseCode(sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY));
    if (fromSession) return fromSession;
  } catch {}

  return '';
}

function extractWalletNonce(json) {
  return (
    json?.payload?.nonce ||
    json?.payload?.challenge ||
    json?.payload ||
    json?.data?.nonce ||
    json?.nonce ||
    ''
  );
}

function extractAuthSession(json) {
  return json?.payload || json?.data || json || null;
}

async function fetchRounds(limit = 10) {
  const url = `${GAME_API_BASE}/rounds?limit=${limit}&_ts=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Rounds API ${res.status}`);
  const json = await res.json();
  return json.payload ?? [];
}

function parseTargetLabelToMultiplier(label) {
  const normalized = String(label || '').trim().toLowerCase().replace(/\s+/g, '');
  const parsed = Number.parseFloat(normalized.replace('x', ''));
  if (!Number.isFinite(parsed) || parsed < 1.01) return 2;
  return parsed;
}

async function fetchOracleTargetSnapshot(targetLabel, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ORACLE_PREDICT_API}?_ts=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Oracle API ${response.status}${text ? `: ${text}` : ''}`);
    }
    const payload = await response.json();
    const targets = Array.isArray(payload?.targets) ? payload.targets : [];
    const target = targets.find((item) => String(item?.label || '').toLowerCase() === String(targetLabel || '').toLowerCase());
    if (!target) return null;
    const windowLo = Number(target.windowLo || 0);
    const windowHi = Number(target.windowHi || 0);
    const asOfRound = Number(payload?.asOfRound || 0);
    const activePrediction = Boolean(target.activePrediction);
    const inWindow = Boolean(target.inWindow);
    const lockKey = windowLo > 0 && windowHi > 0 ? `${target.label}:${windowLo}-${windowHi}` : null;
    return {
      asOfRound,
      label: target.label,
      confidence: Number(target.confidence || 0),
      activePrediction,
      inWindow,
      windowLo,
      windowHi,
      roundsUntilWindowLo: Number(target.roundsUntilWindowLo || 0),
      roundsUntilWindowHi: Number(target.roundsUntilWindowHi || 0),
      lockKey,
      issueMode: String(target.issueMode || 'observe'),
      avoidReason: String(target.liveAvoidReason || target.avoidReason || ''),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBotConfig() {
  const url = `${BACKEND_API_BASE}/bot/config?_ts=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Bot config error (${res.status}): ${err}`);
  }
  const json = await res.json();
  const config = json?.config || {};
  if (!config.rpcUrl) {
    throw new Error('Bot config missing rpcUrl');
  }
  return {
    rpcUrl: String(config.rpcUrl).trim(),
    playerAccountPDA: String(config.playerAccountPDA || '').trim(),
  };
}

async function saveWalletConfigOnBackend({
  privateKey,
  rpcUrl,
  playerAccountPDA,
  pubkey,
  adminSecret,
}) {
  if (!BACKEND_API_BASE) return { ok: false, skipped: true, reason: 'api-base-missing' };

  const headers = { 'Content-Type': 'application/json' };
  const trimmedAdmin = String(adminSecret || '').trim();
  if (trimmedAdmin) headers['x-admin-secret'] = trimmedAdmin;
  const accessCode = readAccessCodeFromStorage();
  if (accessCode) headers['x-access-code'] = accessCode;

  const res = await fetch(`${BACKEND_API_BASE}/wallets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      privateKey,
      rpcUrl,
      playerAccountPDA,
      pubkey,
    }),
  });

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = String(json?.error || text || `HTTP ${res.status}`);
    return {
      ok: false,
      status: res.status,
      error: err,
    };
  }

  return { ok: true, data: json };
}

async function setCashoutOnServer(multiplier, token) {
  const formatted = parseFloat(multiplier).toFixed(3);
  const res = await fetch(`${SITE_CASHOUT_API}/multiplier`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token, multiplier: formatted }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Cashout error (${res.status}): ${err}`);
  }

  return true;
}

async function stopCashoutOnServer(multiplier, token) {
  const formatted = parseFloat(multiplier).toFixed(3);
  const res = await fetch(`${SITE_CASHOUT_API}/cashout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token, mult: formatted }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Manual cashout error (${res.status}): ${err}`);
  }

  return true;
}

async function authorizeWalletOnSite(walletId, keypairBytes) {
  const nonceRes = await fetch(`${WALLET_AUTH_API}/nonce/${encodeURIComponent(walletId)}`);
  if (!nonceRes.ok) {
    const err = await nonceRes.text().catch(() => String(nonceRes.status));
    throw new Error(`Nonce fetch failed (${nonceRes.status}): ${err}`);
  }

  const nonceJson = await nonceRes.json();
  const nonce = extractWalletNonce(nonceJson);
  if (!nonce) throw new Error('Nonce missing from wallet auth response');

  const nacl = window.nacl;
  if (!nacl?.sign?.detached) throw new Error('TweetNaCl not loaded');

  const encoder = new TextEncoder();
  const message = encoder.encode(`${NONCE_MESSAGE_PREFIX}${nonce}`);
  const signatureBytes = nacl.sign.detached(message, keypairBytes);
  const signature = bytesToBase64(signatureBytes);

  const authRes = await fetch(`${WALLET_AUTH_API}/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ walletId, signature }),
  });

  if (!authRes.ok) {
    const err = await authRes.text().catch(() => String(authRes.status));
    throw new Error(`Wallet auth failed (${authRes.status}): ${err}`);
  }

  const authJson = await authRes.json();
  const rawSession = extractAuthSession(authJson);
  const idToken = rawSession?.idToken || rawSession?.token || rawSession?.authKey || '';
  if (!idToken) throw new Error('Wallet auth succeeded but idToken is missing');

  return {
    idToken,
    exp: rawSession?.exp || 0,
    username: rawSession?.username || '',
    walletId,
    issuedAt: Date.now(),
  };
}

async function waitForActiveRound(stopRef, lastPlayedRoundId, canUseRound = null) {
  while (!stopRef.current) {
    try {
      const round = (await fetchRounds(1))[0];
      if (!round) {
        await sleep(300);
        continue;
      }

      const isOpen = round.gameResult === null;
      if (!isOpen || round.roundId === lastPlayedRoundId) {
        await sleep(300);
        continue;
      }

      if (typeof canUseRound === 'function') {
        let allowed = false;
        try {
          allowed = Boolean(canUseRound(round));
        } catch {
          allowed = false;
        }
        if (!allowed) {
          await sleep(150);
          continue;
        }
      }

      return round;
    } catch {
      await sleep(500);
    }
  }

  return null;
}

async function waitForRoundResult(roundId, cashoutMultiplier, stopRef, timeoutMs = 90000) {
  const start = Date.now();
  while (!stopRef.current && Date.now() - start < timeoutMs) {
    await sleep(1500);
    try {
      const rounds = await fetchRounds(10);
      const done = rounds.find(round => Number(round?.roundId) === Number(roundId) && round.gameResult !== null);
      if (done) {
        const crashPoint = parseFloat(done.gameResult);
        return {
          won: crashPoint >= cashoutMultiplier,
          crashPoint,
          roundId: done.roundId,
        };
      }
    } catch {}
  }
  return null;
}

function roundHasPlayer(round, playerAccountPDA, walletPubkey) {
  const players = round?.players;
  if (!players || typeof players !== 'object') return false;

  const needles = getWalletTrackingAddresses(walletPubkey, playerAccountPDA);
  if (!needles.length) return false;

  const values = [];
  Object.entries(players).forEach(([key, value]) => {
    values.push(String(key || ''));
    if (value && typeof value === 'object') {
      Object.values(value).forEach(inner => values.push(String(inner || '')));
    } else {
      values.push(String(value || ''));
    }
  });

  return values.some(value => needles.some(needle => value.includes(needle)));
}

function summarizeTxSendError(error) {
  const message = String(error || '').replace(/\s+/g, ' ').trim();
  const lower = message.toLowerCase();
  if (!message) return 'Unknown send error';
  if (lower.includes('already joined')) return 'already joined';
  if (
    message.includes('WrongGameState') ||
    lower.includes('wrong game state') ||
    lower.includes('bet window not open') ||
    lower.includes('bets are closed') ||
    lower.includes('game is already running') ||
    lower.includes('round already started')
  ) {
    return 'Wrong game state (bet window not open)';
  }
  if (
    message.includes('InstructionDidNotDeserialize') ||
    message.includes('custom program error: 0x66') ||
    lower.includes('instruction did not deserialize') ||
    lower.includes('failed to deserialize') ||
    lower.includes('invalid instruction data') ||
    lower.includes('account did not deserialize') ||
    (lower.includes('deserialize') && lower.includes('instruction'))
  ) {
    return 'Instruction did not deserialize';
  }
  if (lower.includes('blockhash not found')) return 'Blockhash expired';
  if (lower.includes('insufficient funds') || lower.includes('insufficient lamports')) return 'Insufficient balance';
  if (lower.includes('compute budget exceeded') || lower.includes('exceeded maximum number of instructions allowed') || lower.includes('computational budget exceeded')) {
    return 'Compute budget exceeded';
  }
  if (message.length > 280) return `${message.slice(0, 280)}...`;
  return message;
}

function getJoinLayoutAttemptOrder(cashoutMultiplier = 2) {
  return preferredJoinLayout === 'joinLive' ? ['joinLive'] : ['joinLive'];
}

function rememberJoinLayoutSuccess(layout) {
  if (layout === 'joinLive') {
    preferredJoinLayout = layout;
  }
}

function shouldTryAlternateJoinLayout(rawError, normalized, layout) {
  if (
    normalized === 'already joined' ||
    normalized === 'Wrong game state (bet window not open)' ||
    normalized === 'Blockhash expired' ||
    normalized === 'Insufficient balance' ||
    normalized === 'Compute budget exceeded'
  ) {
    return false;
  }
  return false;
}

async function waitForSignatureConfirmation(rpcUrl, signature, stopRef, timeoutMs = 20000) {
  const start = Date.now();
  while (!stopRef.current && Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    });

    const json = await res.json();
    const status = json?.result?.value?.[0];
    if (status?.err) {
      throw new Error(typeof status.err === 'string' ? status.err : JSON.stringify(status.err));
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return status;
    }

    await sleep(600);
  }

  return null;
}

async function waitForBetJoin(roundId, playerAccountPDA, walletPubkey, stopRef, timeoutMs = 8000) {
  const start = Date.now();
  while (!stopRef.current && Date.now() - start < timeoutMs) {
    try {
      const rounds = await fetchRounds(10);
      const round = rounds.find(item => Number(item?.roundId) === Number(roundId));
      if (round && roundHasPlayer(round, playerAccountPDA, walletPubkey)) return round;
      if (round && round.gameResult !== null) return null;
    } catch {}

    await sleep(350);
  }

  return null;
}

function buildDefaultMultiWalletLanes(count = 2) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  const defaults = ['2', '3', '4', '5', '10'];
  return Array.from({ length: safeCount }, (_, index) => ({
    id: `lane${index + 1}`,
    privateKey: '',
    betSol: '0.001',
    cashout: defaults[index] || String(2 + index),
  }));
}

export default function WalletBot({
  onLiveStateChange,
  adminSecret = '',
  forceMode = null,
  fixedMultiLaneCount = 0,
  hideModeSelector = false,
}) {
  const normalizedForceMode = forceMode === 'single' || forceMode === 'multi' ? forceMode : null;
  const normalizedFixedLaneCount = Math.max(0, Math.floor(Number(fixedMultiLaneCount) || 0));
  const initialMode = normalizedForceMode || 'multi';
  const initialLaneCount = normalizedFixedLaneCount > 0 ? normalizedFixedLaneCount : 2;
  const [privateKey, setPrivateKey] = useState('');
  const [strategyMode, setStrategyMode] = useState(initialMode);
  const [betSol, setBetSol] = useState('0.01');
  const [targetMultiplier, setTargetMultiplier] = useState('2');
  const [playTarget, setPlayTarget] = useState('10x');
  const [stopLossCount, setStopLossCount] = useState('10');
  const [maxRounds, setMaxRounds] = useState('0');
  const [multiWalletLanes, setMultiWalletLanes] = useState(() => buildDefaultMultiWalletLanes(initialLaneCount));
  const [multiWalletMeta, setMultiWalletMeta] = useState({});
  const [laneCashoutBusy, setLaneCashoutBusy] = useState({});
  const [activeLaneBets, setActiveLaneBets] = useState({});
  const [walletInfo, setWalletInfo] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isWalletLoading, setIsWalletLoading] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [stats, setStats] = useState({ rounds: 0, wins: 0, losses: 0, pnl: 0 });
  const [botLog, setBotLog] = useState([]);
  const [recentResolved, setRecentResolved] = useState([]);
  const [currentRoundId, setCurrentRoundId] = useState(null);
  const [liveState, setLiveState] = useState({
    connectionState: 'CONNECTING',
    connectionOpen: false,
    phase: LIVE_PHASE.UNKNOWN,
    multiplier: 1,
    currentBar: null,
    pingMs: null,
    playerCount: 0,
    nextGameDelayMs: 0,
    countdownTotalMs: 0,
    betsClosingAt: null,
    trace: [],
    lastMessageAt: 0,
  });
  const [manualCashoutBusy, setManualCashoutBusy] = useState(false);
  const [recoveredSession, setRecoveredSession] = useState(false);

  const stopRef = useRef(false);
  const runRef = useRef(false);
  const startLockRef = useRef(false);
  const walletLoadRef = useRef(false);
  const botConfigRef = useRef(null);
  const authSessionRef = useRef(null);
  const statsRef = useRef({ rounds: 0, wins: 0, losses: 0, pnl: 0 });
  const logSeqRef = useRef(0);
  const lastLogRef = useRef({ msg: '', type: '', at: 0 });
  const recentLogMapRef = useRef(new Map());
  const liveSocketRef = useRef(null);
  const livePingRef = useRef(null);
  const lastPingAtRef = useRef(0);
  const traceRef = useRef([]);
  const liveStateRef = useRef(liveState);
  const currentRoundIdRef = useRef(currentRoundId);
  const activeBetRef = useRef(null);
  const authRequestRef = useRef({ walletId: '', promise: null, startedAt: 0 });
  const [hasActiveBet, setHasActiveBet] = useState(false);

  useEffect(() => {
    if (!normalizedForceMode || isRunning) return;
    if (strategyMode !== normalizedForceMode) {
      setStrategyMode(normalizedForceMode);
    }
  }, [isRunning, normalizedForceMode, strategyMode]);

  useEffect(() => {
    if (normalizedForceMode !== 'multi' || normalizedFixedLaneCount <= 0 || isRunning) return;
    setMultiWalletLanes((prev) => {
      if (prev.length === normalizedFixedLaneCount) return prev;
      if (prev.length > normalizedFixedLaneCount) return prev.slice(0, normalizedFixedLaneCount);
      const next = [...prev];
      const defaults = ['2', '3', '4', '5', '10'];
      while (next.length < normalizedFixedLaneCount) {
        const idx = next.length;
        next.push({
          id: `lane${idx + 1}`,
          privateKey: '',
          betSol: '0.001',
          cashout: defaults[idx] || String(2 + idx),
        });
      }
      return next;
    });
  }, [isRunning, normalizedFixedLaneCount, normalizedForceMode]);

  const updateMultiWalletLane = useCallback((laneId, field, value) => {
    setMultiWalletLanes(prev => prev.map((lane) => (
      lane.id === laneId ? { ...lane, [field]: value } : lane
    )));
    if (field === 'privateKey') {
      setMultiWalletMeta(prev => ({
        ...prev,
        [laneId]: {
          ...(prev[laneId] || {}),
          loaded: false,
          pubkey: '',
          balance: 0,
          status: '',
          error: '',
          loading: false,
        },
      }));
    }
  }, []);

  const addMultiWalletLane = useCallback(() => {
    if (normalizedForceMode === 'multi' && normalizedFixedLaneCount > 0) return;
    const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setMultiWalletLanes(prev => [
      ...prev,
      { id: laneId, privateKey: '', betSol: '0.001', cashout: '2' },
    ]);
  }, [normalizedFixedLaneCount, normalizedForceMode]);

  const removeMultiWalletLane = useCallback((laneId) => {
    if (normalizedForceMode === 'multi' && normalizedFixedLaneCount > 0) return;
    setMultiWalletLanes(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter((lane) => lane.id !== laneId);
    });
    setMultiWalletMeta(prev => {
      const next = { ...prev };
      delete next[laneId];
      return next;
    });
  }, [normalizedFixedLaneCount, normalizedForceMode]);

  const addLog = useCallback((msg, type = 'info') => {
    const nowMs = Date.now();
    const normalizedMsg = (
      msg.startsWith('Balance: ') ? 'Balance' :
      msg.startsWith('Wallet loaded: ') ? 'Wallet loaded' :
      msg.startsWith('Site cashout session ready') ? 'Site cashout session ready' :
      msg.startsWith('Site session live') ? 'Site session live' :
      msg.startsWith('Waiting for next round...') ? 'Waiting for next round' :
      msg.startsWith('Bet window confirmed - sending TX now...') ? 'Bet window confirmed' :
      msg.startsWith('TX sent: ') ? 'TX sent' :
      msg.startsWith('Bet joined round #') ? 'Bet joined round' :
      msg
    );
    const quietWindowMs = (
      msg.startsWith('Authenticating wallet for site cashout') ||
      msg.startsWith('Balance: ') ||
      msg.startsWith('Wallet loaded: ') ||
      msg.startsWith('Site cashout session ready') ||
      msg.startsWith('Site session live') ||
      msg.startsWith('Waiting for next round...') ||
      msg.startsWith('Bet window confirmed - sending TX now...') ||
      msg.startsWith('TX sent: ') ||
      msg.startsWith('Bet joined round #')
    )
      ? 60000
      : 1200;
    const cacheKey = `${type}:${normalizedMsg}`;
    const lastSameAt = recentLogMapRef.current.get(cacheKey) || 0;
    if (nowMs - lastSameAt < quietWindowMs) {
      return;
    }
    if (
      lastLogRef.current.msg === msg &&
      lastLogRef.current.type === type &&
      nowMs - lastLogRef.current.at < quietWindowMs
    ) {
      return;
    }
    recentLogMapRef.current.set(cacheKey, nowMs);
    if (recentLogMapRef.current.size > 80) {
      const threshold = nowMs - 10000;
      for (const [key, at] of recentLogMapRef.current.entries()) {
        if (at < threshold) recentLogMapRef.current.delete(key);
      }
    }
    lastLogRef.current = { msg, type, at: nowMs };
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    logSeqRef.current += 1;
    const uniqueId = `${nowMs}-${logSeqRef.current}-${Math.random().toString(36).slice(2, 8)}`;
    setBotLog(prev => [{ ts, msg, type, id: uniqueId }, ...prev].slice(0, 150));
  }, []);

  const syncPersistedSession = useCallback((nextSession) => {
    if (!walletInfo?.pubkey) {
      if (!nextSession) clearPersistedBotSession();
      return;
    }
    if (!nextSession) {
      clearPersistedBotSession();
      setRecoveredSession(false);
      return;
    }
    writePersistedBotSession({
      walletId: walletInfo.pubkey,
      ...nextSession,
      updatedAt: Date.now(),
    });
  }, [walletInfo?.pubkey]);

  const clearActiveBet = useCallback(() => {
    activeBetRef.current = null;
    setHasActiveBet(false);
    if (runRef.current && walletInfo?.pubkey) {
      writePersistedBotSession({
        walletId: walletInfo.pubkey,
        running: true,
        activeRoundId: null,
        updatedAt: Date.now(),
      });
      return;
    }
    syncPersistedSession(null);
  }, [syncPersistedSession, walletInfo?.pubkey]);

  const markActiveBet = useCallback((roundId, signature) => {
    activeBetRef.current = {
      roundId: Number(roundId),
      signature: signature || '',
      startedAt: Date.now(),
    };
    setHasActiveBet(true);
    syncPersistedSession({
      running: true,
      activeRoundId: Number(roundId),
      signature: signature || '',
    });
  }, [syncPersistedSession]);

  const refreshLiveRounds = useCallback(async () => {
    try {
      const rounds = await fetchRounds(12);
      const latestOpen = rounds.find(round => round?.gameResult === null);
      const latestResolved = rounds.filter(round => round?.gameResult !== null);
      const newestRoundId = latestOpen?.roundId || latestResolved[0]?.roundId || null;
      setCurrentRoundId(newestRoundId);
      setRecentResolved(
        latestResolved.slice(0, 8).map(round => ({
          roundId: round.roundId,
          multiplier: Number.parseFloat(round.gameResult || '0'),
        }))
      );
    } catch {}
  }, []);

  const pushTracePoint = useCallback((value, reset = false) => {
    const numeric = Math.max(1, Number(value || 1));
    const point = { ts: Date.now(), value: numeric };
    const nextTrace = reset
      ? [{ ts: point.ts - 1, value: 1 }, point]
      : [...traceRef.current, point].slice(-70);
    traceRef.current = nextTrace;
    setLiveState(prev => ({ ...prev, trace: nextTrace, multiplier: numeric }));
  }, []);

  const waitForBetWindow = useCallback(async (targetRoundId, stopSignalRef, timeoutMs = 12000) => {
    const start = Date.now();
    let sawLiveConnection = false;
    while (!stopSignalRef.current && Date.now() - start < timeoutMs) {
      const liveSnap = liveStateRef.current || {};
      const liveRound = Number(currentRoundIdRef.current || 0);
      const phase = Number(liveSnap.phase);
      const connected = Boolean(liveSnap.connectionOpen);
      const isTargetRound = liveRound === Number(targetRoundId);

      if (!connected) {
        await sleep(120);
        continue;
      }
      sawLiveConnection = true;

      const isJoinState = phase === LIVE_PHASE.WAITING || phase === LIVE_PHASE.IDLE;
      if (isTargetRound && isJoinState) {
        const closeAt = Number(liveSnap.betsClosingAt || 0);
        if (!closeAt || Date.now() < closeAt - JOIN_WINDOW_SAFETY_MS) {
          return { ok: true };
        }
        return { ok: false, reason: 'closed' };
      }

      if (isTargetRound && (phase === LIVE_PHASE.RUNNING || phase === LIVE_PHASE.CRASHED)) {
        return { ok: false, reason: 'running' };
      }

      if (liveRound > Number(targetRoundId)) {
        return { ok: false, reason: 'running' };
      }

      await sleep(90);
    }

    return { ok: false, reason: sawLiveConnection ? 'timeout' : 'no-live' };
  }, []);

  const isRoundJoinableNow = useCallback((round) => {
    const candidateRoundId = Number(round?.roundId || 0);
    if (!candidateRoundId) return false;

    const liveSnap = liveStateRef.current || {};
    const liveRound = Number(currentRoundIdRef.current || 0);
    const phase = Number(liveSnap.phase);
    const connected = Boolean(liveSnap.connectionOpen);

    // If live stream is not ready yet, allow fallback to REST round polling.
    if (!connected || liveRound <= 0) return true;

    // If live stream already moved past this candidate, it is stale.
    if (liveRound > candidateRoundId) return false;

    // If stream is still behind, allow; a second gate check will guard send time.
    if (liveRound < candidateRoundId) return true;

    const inJoinPhase = phase === LIVE_PHASE.WAITING || phase === LIVE_PHASE.IDLE;
    if (!inJoinPhase) return false;

    const closeAt = Number(liveSnap.betsClosingAt || 0);
    if (closeAt && Date.now() >= closeAt - JOIN_WINDOW_SAFETY_MS) return false;

    return true;
  }, []);

  const waitForOracleLiveLock = useCallback(async (targetLabel, stopSignalRef, skipLockKey = null) => {
    let lastStatusKey = '';
    while (!stopSignalRef.current) {
      try {
        const snapshot = await fetchOracleTargetSnapshot(targetLabel, 12000);
        if (snapshot) {
          const statusKey = `${snapshot.lockKey || 'none'}:${snapshot.activePrediction ? 1 : 0}:${snapshot.inWindow ? 1 : 0}`;
          if (snapshot.activePrediction && snapshot.inWindow && snapshot.lockKey && snapshot.lockKey !== skipLockKey) {
            addLog(
              `Oracle ${snapshot.label} lock is live: #${snapshot.windowLo.toLocaleString()} - #${snapshot.windowHi.toLocaleString()} (${Math.round(snapshot.confidence)}% confidence)`,
              'success'
            );
            return snapshot;
          }
          if (statusKey !== lastStatusKey) {
            if (snapshot.activePrediction && snapshot.lockKey) {
              const away = Math.max(0, Number(snapshot.roundsUntilWindowLo || 0));
              addLog(
                `Oracle ${snapshot.label} lock is scheduled (#${snapshot.windowLo.toLocaleString()} - #${snapshot.windowHi.toLocaleString()}, ${away}r away). Waiting...`,
                'info'
              );
            } else {
              addLog(`Waiting for next live Oracle ${targetLabel} lock...`, 'info');
            }
            lastStatusKey = statusKey;
          }
        }
      } catch (error) {
        addLog(`Oracle lock check failed: ${error.message}`, 'warn');
      }
      await sleep(1200);
    }
    return null;
  }, [addLog]);

  useEffect(() => {
    authSessionRef.current = null;
    setRecoveredSession(false);
  }, [privateKey]);

  useEffect(() => {
    liveStateRef.current = liveState;
  }, [liveState]);

  useEffect(() => {
    currentRoundIdRef.current = currentRoundId;
  }, [currentRoundId]);

  useEffect(() => {
    const active = activeBetRef.current;
    if (!active) return;
    if (currentRoundId && Number(currentRoundId) !== Number(active.roundId)) {
      clearActiveBet();
    }
  }, [clearActiveBet, currentRoundId]);

  const ensureBotConfig = useCallback(async (forceRefresh = false) => {
    if (!forceRefresh && botConfigRef.current?.rpcUrl) {
      return botConfigRef.current;
    }
    const config = await fetchBotConfig();
    botConfigRef.current = config;
    return config;
  }, []);

  const ensureSiteSession = useCallback(async (walletId, keypairBytes, forceRefresh = false) => {
    if (!forceRefresh && isSessionFresh(authSessionRef.current, walletId)) {
      return authSessionRef.current;
    }

    if (
      !forceRefresh &&
      authRequestRef.current.walletId === walletId &&
      authRequestRef.current.promise
    ) {
      return authRequestRef.current.promise;
    }

    const authPromise = authorizeWalletOnSite(walletId, keypairBytes)
      .then(session => {
        authSessionRef.current = session;
        return session;
      })
      .finally(() => {
        if (authRequestRef.current.promise === authPromise) {
          authRequestRef.current = { walletId: '', promise: null, startedAt: 0 };
        }
      });

    authRequestRef.current = {
      walletId,
      promise: authPromise,
      startedAt: Date.now(),
    };

    return authPromise;
  }, []);

  const loadMultiWalletLane = useCallback(async (laneId) => {
    const lane = multiWalletLanes.find(item => item.id === laneId);
    if (!lane) return;
    const rawKey = String(lane.privateKey || '').trim();
    if (!rawKey) {
      addLog('Enter lane private key first', 'warn');
      setMultiWalletMeta(prev => ({
        ...prev,
        [laneId]: { ...(prev[laneId] || {}), loaded: false, status: 'Key required', loading: false },
      }));
      return;
    }

    setMultiWalletMeta(prev => ({
      ...prev,
      [laneId]: { ...(prev[laneId] || {}), loading: true, status: 'Loading...' },
    }));

    try {
      const botConfig = await ensureBotConfig();
      const keyBytes = bs58Decode(rawKey);
      if (!keyBytes || keyBytes.length !== 64) {
        throw new Error('Private key must decode to 64 bytes');
      }
      const pubkey = bs58Encode(keyBytes.slice(32));
      const balance = await getBalance(botConfig.rpcUrl, pubkey);

      let laneStatus = 'Ready';
      try {
        await saveWalletConfigOnBackend({
          privateKey: rawKey,
          rpcUrl: botConfig.rpcUrl,
          playerAccountPDA: botConfig.playerAccountPDA,
          pubkey,
          adminSecret,
        });
      } catch {
        laneStatus = 'Ready';
      }

      setMultiWalletMeta(prev => ({
        ...prev,
        [laneId]: {
          ...(prev[laneId] || {}),
          loaded: true,
          loading: false,
          pubkey,
          balance,
          status: laneStatus,
          error: '',
        },
      }));
      addLog(`Lane wallet loaded: ${pubkey.slice(0, 8)}...${pubkey.slice(-6)} (${lamportsToSol(balance)} SOL)`, 'success');
    } catch (error) {
      setMultiWalletMeta(prev => ({
        ...prev,
        [laneId]: {
          ...(prev[laneId] || {}),
          loaded: false,
          loading: false,
          pubkey: '',
          balance: 0,
          status: '',
          error: String(error.message || 'Load failed'),
        },
      }));
      addLog(`Lane load failed: ${error.message}`, 'error');
    }
  }, [addLog, adminSecret, ensureBotConfig, multiWalletLanes]);

  const manualCashoutLane = useCallback(async (laneId) => {
    const lane = multiWalletLanes.find(item => item.id === laneId);
    if (!lane) return;
    if (laneCashoutBusy[laneId]) return;
    if (!activeLaneBets[laneId]) {
      addLog(`Lane ${laneId} has no active bet`, 'warn');
      return;
    }
    if (liveState?.phase !== LIVE_PHASE.RUNNING) {
      addLog('Lane cashout is only available while round is running', 'warn');
      return;
    }

    let keypairBytes;
    let pubkey;
    try {
      keypairBytes = bs58Decode(String(lane.privateKey || '').trim());
      if (!keypairBytes || keypairBytes.length !== 64) throw new Error('Invalid keypair');
      pubkey = bs58Encode(keypairBytes.slice(32));
    } catch (error) {
      addLog(`Lane cashout key error: ${error.message}`, 'error');
      return;
    }

    const liveMult = Math.max(1.01, Number(liveState?.multiplier || lane.cashout || 1.01));
    setLaneCashoutBusy(prev => ({ ...prev, [laneId]: true }));
    try {
      let session = await ensureSiteSession(pubkey, keypairBytes);
      try {
        await stopCashoutOnServer(liveMult, session.idToken);
      } catch (error) {
        const authExpired = String(error.message || '').includes('401') || String(error.message || '').includes('403');
        if (!authExpired) throw error;
        session = await ensureSiteSession(pubkey, keypairBytes, true);
        await stopCashoutOnServer(liveMult, session.idToken);
      }
      setActiveLaneBets(prev => {
        const next = { ...prev };
        delete next[laneId];
        return next;
      });
      addLog(`Lane ${pubkey.slice(0, 8)}... cashout sent @ ${liveMult.toFixed(3)}x`, 'success');
    } catch (error) {
      addLog(`Lane cashout failed: ${error.message}`, 'error');
    } finally {
      setLaneCashoutBusy(prev => ({ ...prev, [laneId]: false }));
    }
  }, [activeLaneBets, addLog, ensureSiteSession, laneCashoutBusy, liveState?.multiplier, liveState?.phase, multiWalletLanes]);

  const manualCashout = useCallback(async () => {
    if (manualCashoutBusy) return;
    if (!walletInfo?.pubkey) {
      addLog('Load wallet first before manual cashout', 'warn');
      return;
    }
    if (!activeBetRef.current) {
      addLog('Manual cashout is only available after your bet joins the live round', 'warn');
      return;
    }
    if (liveState?.phase !== LIVE_PHASE.RUNNING) {
      addLog('Manual cashout is only available while the round is running', 'warn');
      return;
    }

    let keypairBytes;
    try {
      keypairBytes = bs58Decode(privateKey.trim());
      if (!keypairBytes || keypairBytes.length !== 64) throw new Error('Invalid keypair');
    } catch (error) {
      addLog(`Manual cashout key error: ${error.message}`, 'error');
      return;
    }

    const configuredCashout = strategyMode === 'play-target'
      ? parseTargetLabelToMultiplier(playTarget)
      : Number(targetMultiplier || 1.01);
    const liveMult = Math.max(1.01, Number(liveState?.multiplier || configuredCashout || 1.01));
    setManualCashoutBusy(true);
    try {
      let session = await ensureSiteSession(walletInfo.pubkey, keypairBytes);
      try {
        await stopCashoutOnServer(liveMult, session.idToken);
      } catch (error) {
        const authExpired = error.message.includes('401') || error.message.includes('403');
        if (!authExpired) throw error;
        addLog('Manual cashout auth expired - refreshing...', 'warn');
        session = await ensureSiteSession(walletInfo.pubkey, keypairBytes, true);
        await stopCashoutOnServer(liveMult, session.idToken);
      }
      addLog(`Manual cashout sent @ ${liveMult.toFixed(3)}x`, 'success');
      clearActiveBet();
    } catch (error) {
      addLog(`Manual cashout failed: ${error.message}`, 'error');
    } finally {
      setManualCashoutBusy(false);
    }
  }, [addLog, clearActiveBet, ensureSiteSession, liveState?.multiplier, liveState?.phase, manualCashoutBusy, playTarget, privateKey, strategyMode, targetMultiplier, walletInfo?.pubkey]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer = null;

    const clearPingLoop = () => {
      if (livePingRef.current) {
        clearInterval(livePingRef.current);
        livePingRef.current = null;
      }
    };

    const connect = () => {
      if (cancelled) return;
      setLiveState(prev => ({ ...prev, connectionState: 'CONNECTING', connectionOpen: false }));
      // Do not force a subprotocol; some gateways reject unknown protocols
      // and trigger noisy "closed before established" errors.
      const ws = new WebSocket(LIVE_VIEW_WS_URL);
      liveSocketRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setLiveState(prev => ({ ...prev, connectionState: 'LIVE', connectionOpen: true }));
        refreshLiveRounds();
        clearPingLoop();
        livePingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            lastPingAtRef.current = Date.now();
            try { ws.send(JSON.stringify({ message: 'PING' })); } catch {}
          }
        }, 10000);
        lastPingAtRef.current = Date.now();
        try { ws.send(JSON.stringify({ message: 'PING' })); } catch {}
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload?.type === 'PING') {
          const pingMs = lastPingAtRef.current ? Date.now() - lastPingAtRef.current : null;
          setLiveState(prev => ({ ...prev, pingMs }));
          return;
        }

        setLiveState(prev => {
          const next = { ...prev, lastMessageAt: Date.now() };
          if (payload?.nextGameNoMoreBetsAt > 0) {
            next.betsClosingAt = Number(payload.nextGameNoMoreBetsAt);
          } else if (prev.betsClosingAt) {
            next.betsClosingAt = null;
          }
          if (typeof payload?.nextGameDelay === 'number') {
            next.nextGameDelayMs = payload.nextGameDelay;
            if (
              !prev.countdownTotalMs ||
              payload.gameState !== prev.phase ||
              payload.nextGameDelay > prev.countdownTotalMs
            ) {
              next.countdownTotalMs = payload.nextGameDelay;
            }
          }
          if (typeof payload?.bar !== 'undefined') {
            next.currentBar = payload.bar;
          }
          if (Array.isArray(payload?.playerUpdate) && payload.playerUpdate.length > 0) {
            next.playerCount = payload.playerUpdate.length;
          }
          if (typeof payload?.gameState !== 'undefined') {
            next.phase = payload.gameState;
            if (payload.gameState === LIVE_PHASE.WAITING || payload.gameState === LIVE_PHASE.IDLE) {
              traceRef.current = [{ ts: Date.now() - 1, value: 1 }, { ts: Date.now(), value: 1 }];
              next.trace = traceRef.current;
              next.multiplier = 1;
            }
            if (payload.gameState === LIVE_PHASE.RUNNING || payload.gameState === LIVE_PHASE.CRASHED) {
              next.countdownTotalMs = prev.countdownTotalMs || next.nextGameDelayMs || 0;
            }
          }
          return next;
        });

        if (typeof payload?.currentValue !== 'undefined') {
          const nextMultiplier = Number(payload.currentValue) / 1e5;
          const shouldResetTrace = (
            traceRef.current.length === 0 ||
            (traceRef.current.length <= 2 && traceRef.current.every(point => Number(point.value || 0) <= 1.001))
          );
          pushTracePoint(nextMultiplier, shouldResetTrace);
        }

        if (typeof payload?.gameState !== 'undefined') {
          refreshLiveRounds();
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        setLiveState(prev => ({ ...prev, connectionState: 'ERROR', connectionOpen: false }));
      };

      ws.onclose = () => {
        if (cancelled) return;
        clearPingLoop();
        setLiveState(prev => ({ ...prev, connectionState: 'RECONNECTING', connectionOpen: false }));
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    const roundTimer = setInterval(() => {
      refreshLiveRounds();
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(roundTimer);
      clearPingLoop();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (liveSocketRef.current) {
        const socket = liveSocketRef.current;
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        // Avoid closing during CONNECTING to prevent browser noise:
        // "WebSocket is closed before the connection is established."
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
          try { socket.close(); } catch {}
        } else if (socket.readyState === WebSocket.CONNECTING) {
          const closeWhenOpen = () => {
            try { socket.close(); } catch {}
          };
          try { socket.addEventListener('open', closeWhenOpen, { once: true }); } catch {}
        }
      }
      liveSocketRef.current = null;
    };
  }, [pushTracePoint, refreshLiveRounds]);

  useEffect(() => {
    if (!onLiveStateChange) return undefined;
    const singleModeActive = strategyMode !== 'multi';
    onLiveStateChange({
      liveState,
      recentResolved,
      currentRoundId,
      targetMultiplier: strategyMode === 'play-target'
        ? String(parseTargetLabelToMultiplier(playTarget))
        : targetMultiplier,
      botRunning: isRunning,
      canCashout: singleModeActive && Boolean(walletInfo?.pubkey) && hasActiveBet && liveState?.phase === LIVE_PHASE.RUNNING && liveState?.connectionOpen,
      cashoutBusy: singleModeActive ? manualCashoutBusy : false,
      onCashout: singleModeActive ? manualCashout : null,
    });
    return () => {};
  }, [currentRoundId, hasActiveBet, isRunning, liveState, manualCashout, manualCashoutBusy, onLiveStateChange, playTarget, recentResolved, strategyMode, targetMultiplier, walletInfo?.pubkey]);

  const loadWallet = useCallback(async () => {
    if (walletLoadRef.current) return;
    if (!privateKey.trim()) {
      addLog('Wallet key required', 'error');
      return;
    }

    const rawKey = privateKey.trim();

    walletLoadRef.current = true;
    setIsWalletLoading(true);

    try {
      clearActiveBet();
      const botConfig = await ensureBotConfig();

      let keyBytes;

      try {
        keyBytes = bs58Decode(rawKey);

        if (!keyBytes || keyBytes.length !== 64) {
          throw new Error('Private key must decode to 64 bytes');
        }
      } catch (error) {
        addLog(`Wallet key error: ${error.message}`, 'error');
        return;
      }

      const pubkey = bs58Encode(keyBytes.slice(32));
      const balance = await getBalance(botConfig.rpcUrl, pubkey);

      setWalletInfo({ pubkey, balance });

      addLog(`Wallet loaded: ${pubkey.slice(0, 8)}...${pubkey.slice(-6)}`, 'success');
      addLog(`Balance: ${lamportsToSol(balance)} SOL`, 'info');

      try {
        await saveWalletConfigOnBackend({
          privateKey: rawKey,
          rpcUrl: botConfig.rpcUrl,
          playerAccountPDA: botConfig.playerAccountPDA,
          pubkey,
          adminSecret,
        });
      } catch {}

      const persisted = readPersistedBotSession();
      if (persisted?.walletId === pubkey) {
        setRecoveredSession(true);
      }

      try {
        const rounds = await fetchRounds(12);
        const openRound = rounds.find(round => round?.gameResult === null);
        if (openRound && roundHasPlayer(openRound, botConfig.playerAccountPDA, pubkey)) {
          markActiveBet(openRound.roundId, 'recovered');
          setRecoveredSession(true);
          addLog(`Recovered active round #${openRound.roundId}. Use STOP to clear if needed.`, 'warn');
        } else if (persisted?.walletId === pubkey) {
          addLog('Recovered previous wallet session. Press STOP once to clear stale lock.', 'warn');
        }
      } catch {}

      try {
        await ensureSiteSession(pubkey, keyBytes);
        addLog('Site cashout session ready', 'success');
      } catch (authError) {
        addLog(`Site cashout auth failed: ${authError.message}`, 'warn');
      }
    } catch (error) {
      addLog(`Wallet error: ${error.message}`, 'error');
    } finally {
      walletLoadRef.current = false;
      setIsWalletLoading(false);
    }
  }, [addLog, adminSecret, clearActiveBet, ensureBotConfig, ensureSiteSession, markActiveBet, privateKey]);

  const startMultiWalletBot = useCallback(async () => {
    if (runRef.current || startLockRef.current) {
      addLog('Bot is already running', 'warn');
      return;
    }
    startLockRef.current = true;
    try {
      const stopLoss = parseInt(stopLossCount, 10) || 999999;
      const maxR = parseInt(maxRounds, 10) || 999999;
      const laneInputs = multiWalletLanes
        .map(lane => ({
          id: lane.id,
          privateKey: String(lane.privateKey || '').trim(),
          betSol: Number.parseFloat(lane.betSol || '0'),
          cashout: Number.parseFloat(lane.cashout || '0'),
        }))
        .filter(lane => lane.privateKey && lane.betSol > 0);

      if (laneInputs.length === 0) {
        addLog('Add at least one wallet lane with key, bet, and cashout', 'error');
        return;
      }

      let botConfig;
      try {
        botConfig = await ensureBotConfig();
      } catch (error) {
        addLog(`Bot config error: ${error.message}`, 'error');
        return;
      }

      const resolvedLanes = [];
      for (const lane of laneInputs) {
        let keypairBytes;
        try {
          keypairBytes = bs58Decode(lane.privateKey);
          if (!keypairBytes || keypairBytes.length !== 64) {
            throw new Error('Private key must decode to 64 bytes');
          }
        } catch (error) {
          addLog('One wallet lane has invalid private key', 'error');
          return;
        }

        const cashout = Number.parseFloat(String(lane.cashout || '0'));
        if (!Number.isFinite(cashout) || cashout < 1.01) {
          addLog('One wallet lane has invalid cashout (min 1.01x)', 'error');
          return;
        }

        const laneBetLamports = solToLamports(String(lane.betSol || '0'));
        if (laneBetLamports < 1000000) {
          addLog('Each wallet lane must bet at least 0.001 SOL', 'error');
          return;
        }

        const pubkey = bs58Encode(keypairBytes.slice(32));
        resolvedLanes.push({
          id: lane.id,
          pubkey,
          keypairBytes,
          cashout,
          betLamports: laneBetLamports,
          rpcUrl: String(botConfig.rpcUrl || '').trim(),
          playerAccountPDA: String(botConfig.playerAccountPDA || '').trim(),
        });
      }

      for (const lane of resolvedLanes) {
        if (!lane.rpcUrl) {
          addLog('Bot config missing rpcUrl', 'error');
          return;
        }
        if (lane.betLamports < 1000000) {
          addLog('One wallet lane is below 0.001 SOL', 'error');
          return;
        }
      }

      const primaryLane = resolvedLanes[0];
      clearActiveBet();
      setRecoveredSession(false);
      stopRef.current = false;
      runRef.current = true;
      writePersistedBotSession({
        walletId: primaryLane.pubkey,
        running: true,
        activeRoundId: null,
        startedAt: Date.now(),
      });
      statsRef.current = { rounds: 0, wins: 0, losses: 0, pnl: 0 };
      setStats({ ...statsRef.current });
      setActiveLaneBets({});
      setLaneCashoutBusy({});
      setIsRunning(true);
      setWalletInfo((prev) => ({
        pubkey: primaryLane.pubkey,
        balance: prev?.balance ?? 0,
      }));
      addLog(
        `Started multi-wallet mode (${resolvedLanes.length} wallets)`,
        'success'
      );

      const laneSessionCache = new Map();
      const ensureLaneSiteSession = async (lane, forceRefresh = false) => {
        const cached = laneSessionCache.get(lane.pubkey);
        if (!forceRefresh && isSessionFresh(cached, lane.pubkey)) {
          return cached;
        }
        const fresh = await ensureSiteSession(lane.pubkey, lane.keypairBytes, forceRefresh);
        laneSessionCache.set(lane.pubkey, fresh);
        return fresh;
      };

      let consecutiveLosses = 0;
      let lastPlayedRoundId = null;
      while (!stopRef.current) {
        const session = statsRef.current;
        if (session.rounds >= maxR && maxR !== 999999) {
          addLog('Max rounds reached', 'warn');
          break;
        }
        if (consecutiveLosses >= stopLoss) {
          addLog('Stop loss triggered', 'warn');
          break;
        }

        addLog('Waiting for next round...', 'info');
        const round = await waitForActiveRound(stopRef, lastPlayedRoundId, isRoundJoinableNow);
        if (!round || stopRef.current) break;
        lastPlayedRoundId = round.roundId;

        writePersistedBotSession({
          walletId: primaryLane.pubkey,
          running: true,
          activeRoundId: Number(round.roundId),
          startedAt: Date.now(),
        });

        const readyLanes = [];
        for (const lane of resolvedLanes) {
          try {
            const balance = await getBalance(lane.rpcUrl, lane.pubkey);
            if (lane.pubkey === primaryLane.pubkey) {
              setWalletInfo({ pubkey: lane.pubkey, balance });
            }
            if (balance < lane.betLamports + TX_FEE_BUFFER) {
              addLog(`Lane ${lane.pubkey.slice(0, 8)}... low balance, skipping`, 'warn');
              continue;
            }
            let applied = false;
            if (isCashoutAlreadySynced(lane.pubkey, lane.cashout)) {
              applied = true;
            } else {
              try {
                const s = await ensureLaneSiteSession(lane);
                await setCashoutOnServer(lane.cashout, s.idToken);
                applied = true;
                rememberCashoutSynced(lane.pubkey, lane.cashout);
              } catch (e) {
                const authExpired = String(e.message || '').includes('401') || String(e.message || '').includes('403');
                if (authExpired) {
                  const s = await ensureLaneSiteSession(lane, true);
                  await setCashoutOnServer(lane.cashout, s.idToken);
                  applied = true;
                  rememberCashoutSynced(lane.pubkey, lane.cashout);
                }
              }
            }
            if (!applied) {
              addLog(`Lane ${lane.pubkey.slice(0, 8)}... cashout sync failed`, 'warn');
              continue;
            }
            readyLanes.push(lane);
          } catch (laneErr) {
            addLog(`Lane ${lane.pubkey.slice(0, 8)}... prep failed: ${laneErr.message}`, 'warn');
          }
        }

        if (readyLanes.length === 0) {
          setActiveLaneBets({});
          setLaneCashoutBusy({});
          addLog(`Round #${round.roundId} skipped (no ready lanes)`, 'warn');
          continue;
        }

        const gate = await waitForBetWindow(round.roundId, stopRef, 12000);
        if (!gate.ok) {
          addLog(`Round #${round.roundId} window not ready`, 'warn');
          continue;
        }

        addLog('Bet window confirmed - sending lane TX now...', 'info');
        await sleep(POST_GATE_SEND_DELAY_MS);
        if (stopRef.current) break;

        try {
          const currentRound = (await fetchRounds(1))[0];
          if (!currentRound || currentRound.roundId !== round.roundId || currentRound.gameResult !== null) {
            addLog(`Round #${round.roundId} already closed - skipping wallets`, 'warn');
            continue;
          }
        } catch {}

        const placedLanes = [];
        for (const lane of readyLanes) {
          let signature = null;
          const blockhash = await getRecentBlockhash(lane.rpcUrl);
          const layouts = getJoinLayoutAttemptOrder(lane.cashout);
          for (const layout of layouts) {
            let txBytes;
            try {
              txBytes = buildAndSignTransaction(
                lane.keypairBytes,
                lane.playerAccountPDA,
                lane.betLamports,
                lane.cashout,
                blockhash,
                round.roundId,
                layout
              );
            } catch {
              txBytes = null;
            }
            if (!txBytes || txBytes.length === 0) continue;
            try {
              signature = await sendRawTransaction(lane.rpcUrl, txBytes);
              if (signature && typeof signature === 'string') {
                rememberJoinLayoutSuccess(layout);
                break;
              }
            } catch (sendErr) {
              const rawError = String(sendErr?.message || sendErr);
              const normalized = summarizeTxSendError(rawError);
              if (normalized === 'already joined') {
                signature = 'already-joined';
                break;
              }
              if (normalized === 'Wrong game state (bet window not open)') {
                signature = 'wrong-game-state';
                break;
              }
              if (shouldTryAlternateJoinLayout(rawError, normalized, layout)) {
                continue;
              }
            }
          }

          if (!signature || signature === 'wrong-game-state') {
            continue;
          }

          if (signature !== 'already-joined') {
            try {
              const conf = await waitForSignatureConfirmation(lane.rpcUrl, signature, stopRef);
              if (!conf) continue;
            } catch {
              continue;
            }
          }

          placedLanes.push({
            ...lane,
            signature,
          });
        }

        if (placedLanes.length === 0) {
          setActiveLaneBets({});
          setLaneCashoutBusy({});
          addLog(`Round #${round.roundId} no wallet bet confirmed`, 'warn');
          continue;
        }

        markActiveBet(round.roundId, placedLanes[0].signature || 'multi-wallet');
        setActiveLaneBets(() => {
          const next = {};
          placedLanes.forEach((lane) => {
            next[lane.id] = true;
          });
          return next;
        });
        setLaneCashoutBusy({});
        addLog(`Round #${round.roundId} joined wallets ${placedLanes.length}/${readyLanes.length}`, 'success');

        const result = await waitForRoundResult(round.roundId, 1.01, stopRef);
        clearActiveBet();
        setActiveLaneBets({});
        setLaneCashoutBusy({});
        if (!result || stopRef.current) break;

        const crashPoint = Number(result.crashPoint || 0);
        let roundPnl = 0;
        let laneWins = 0;
        for (const lane of placedLanes) {
          const stakeSol = lane.betLamports / 1e9;
          if (crashPoint >= lane.cashout) {
            laneWins += 1;
            roundPnl += stakeSol * (lane.cashout - 1);
          } else {
            roundPnl -= stakeSol;
          }
        }

        statsRef.current.rounds += 1;
        statsRef.current.pnl += roundPnl;
        if (roundPnl >= 0) {
          statsRef.current.wins += 1;
          consecutiveLosses = 0;
        } else {
          statsRef.current.losses += 1;
          consecutiveLosses += 1;
        }
        setStats({ ...statsRef.current });
        addLog(
          `Round #${round.roundId} settled @ ${crashPoint}x | wallets ${laneWins}/${placedLanes.length} won | P&L ${roundPnl >= 0 ? '+' : ''}${roundPnl.toFixed(4)} SOL`,
          roundPnl >= 0 ? 'success' : 'error'
        );
        await sleep(500);
      }
    } catch (error) {
      clearActiveBet();
      setActiveLaneBets({});
      setLaneCashoutBusy({});
      addLog(`Multi-wallet start failed: ${error.message}`, 'error');
    } finally {
      clearActiveBet();
      setActiveLaneBets({});
      setLaneCashoutBusy({});
      clearPersistedBotSession();
      stopRef.current = false;
      runRef.current = false;
      setIsRunning(false);
      const session = statsRef.current;
      addLog(
        `Stopped - ${session.rounds} rounds | W/L: ${session.wins}/${session.losses} | P&L: ${session.pnl >= 0 ? '+' : ''}${session.pnl.toFixed(4)} SOL`,
        session.pnl >= 0 ? 'success' : 'error'
      );
      startLockRef.current = false;
    }
  }, [addLog, clearActiveBet, ensureBotConfig, ensureSiteSession, isRoundJoinableNow, markActiveBet, maxRounds, multiWalletLanes, stopLossCount, waitForBetWindow]);

  const startPlayTargetBot = useCallback(async () => {
    if (runRef.current || startLockRef.current) {
      addLog('Bot is already running', 'warn');
      return;
    }
    startLockRef.current = true;
    try {
      if (!privateKey.trim()) {
        addLog('Wallet key required', 'error');
        return;
      }

      let keypairBytes;
      try {
        keypairBytes = bs58Decode(privateKey.trim());
        if (!keypairBytes || keypairBytes.length !== 64) {
          throw new Error('Private key must decode to 64 bytes');
        }
      } catch (error) {
        addLog(`Key error: ${error.message}`, 'error');
        return;
      }

      let botConfig;
      try {
        botConfig = await ensureBotConfig();
      } catch (error) {
        addLog(`Bot config error: ${error.message}`, 'error');
        return;
      }

      const { rpcUrl, playerAccountPDA } = botConfig;
      const targetLabel = PLAY_TARGET_OPTIONS.includes(playTarget) ? playTarget : '10x';
      const cashout = parseTargetLabelToMultiplier(targetLabel);
      const betLamports = solToLamports(betSol);
      const stopLoss = parseInt(stopLossCount, 10) || 999999;
      const maxR = parseInt(maxRounds, 10) || 999999;

      if (betLamports < 1000000) {
        addLog('Min bet 0.001 SOL', 'error');
        return;
      }
      if (cashout < 1.01) {
        addLog('Play Target must be 1.01x or higher', 'error');
        return;
      }

      const pubkey = bs58Encode(keypairBytes.slice(32));
      clearActiveBet();
      setRecoveredSession(false);
      stopRef.current = false;
      runRef.current = true;
      writePersistedBotSession({
        walletId: pubkey,
        running: true,
        activeRoundId: null,
        startedAt: Date.now(),
      });
      statsRef.current = { rounds: 0, wins: 0, losses: 0, pnl: 0 };
      setStats({ ...statsRef.current });
      setIsRunning(true);
      addLog(`Started Play Target mode - ${betSol} SOL @ ${cashout}x (Oracle ${targetLabel} lock trigger)`, 'success');

      let consecutiveLosses = 0;
      let lastPlayedRoundId = null;
      let currentLockKey = null;
      let completedLockKey = null;

      try {
        const initialSession = await ensureSiteSession(pubkey, keypairBytes);
        addLog(
          initialSession.username
            ? `Site session live for ${initialSession.username}`
            : 'Site session live',
          'success'
        );

        while (!stopRef.current) {
          const session = statsRef.current;
          if (session.rounds >= maxR && maxR !== 999999) {
            addLog('Max rounds reached', 'warn');
            break;
          }
          if (consecutiveLosses >= stopLoss) {
            addLog('Stop loss triggered', 'warn');
            break;
          }

          try {
            const balance = await getBalance(rpcUrl, pubkey);
            setWalletInfo(current => ({ pubkey: current?.pubkey || pubkey, balance }));
            if (balance < betLamports + TX_FEE_BUFFER) {
              addLog(`Insufficient balance: ${lamportsToSol(balance)} SOL`, 'error');
              break;
            }

            if (!currentLockKey) {
              const liveLock = await waitForOracleLiveLock(targetLabel, stopRef, completedLockKey);
              if (!liveLock || stopRef.current) break;
              currentLockKey = liveLock.lockKey;
            }

            const lockSnapshot = await fetchOracleTargetSnapshot(targetLabel, 12000).catch(() => null);
            if (
              !lockSnapshot ||
              !lockSnapshot.activePrediction ||
              !lockSnapshot.inWindow ||
              !lockSnapshot.lockKey ||
              lockSnapshot.lockKey !== currentLockKey
            ) {
              if (currentLockKey) {
                addLog(`Oracle ${targetLabel} lock window ended. Waiting for next lock...`, 'warn');
                completedLockKey = currentLockKey;
                currentLockKey = null;
              }
              await sleep(350);
              continue;
            }

            addLog('Waiting for next round...', 'info');
            const round = await waitForActiveRound(stopRef, lastPlayedRoundId, isRoundJoinableNow);
            if (!round || stopRef.current) break;

            lastPlayedRoundId = round.roundId;
            if (Number(round.roundId) > Number(lockSnapshot.windowHi || 0)) {
              addLog(`Round #${round.roundId} is outside Oracle ${targetLabel} lock window. Waiting next lock...`, 'warn');
              completedLockKey = currentLockKey;
              currentLockKey = null;
              continue;
            }

            writePersistedBotSession({
              walletId: pubkey,
              running: true,
              activeRoundId: Number(round.roundId),
              startedAt: Date.now(),
            });

            if (roundHasPlayer(round, playerAccountPDA, pubkey)) {
              markActiveBet(round.roundId, 'already-joined');
              addLog(`Already joined round #${round.roundId} - waiting for result`, 'warn');
              const recoveredResult = await waitForRoundResult(round.roundId, cashout, stopRef);
              clearActiveBet();
              if (recoveredResult && !stopRef.current) {
                addLog(`Recovered round #${round.roundId} settled @ ${recoveredResult.crashPoint}x`, 'info');
              }
              await sleep(300);
              continue;
            }

            const preGate = await waitForBetWindow(round.roundId, stopRef, 6000);
            if (!preGate.ok) {
              if (preGate.reason === 'running' || preGate.reason === 'closed') {
                addLog(`Round #${round.roundId} join window already closed - waiting next round`, 'warn');
              } else if (preGate.reason === 'no-live') {
                addLog('Live feed unavailable - waiting for sync before lock entry', 'warn');
              } else {
                addLog(`Round #${round.roundId} join window not ready yet - waiting next round`, 'warn');
              }
              continue;
            }

            addLog(`Round #${round.roundId} - setting cashout to ${cashout}x...`, 'info');
            let cashoutApplied = false;
            if (isCashoutAlreadySynced(pubkey, String(cashout))) {
              cashoutApplied = true;
            } else {
              try {
                const liveSession = await ensureSiteSession(pubkey, keypairBytes);
                await setCashoutOnServer(String(cashout), liveSession.idToken);
                cashoutApplied = true;
                rememberCashoutSynced(pubkey, String(cashout));
                addLog(`Cashout set to ${cashout}x on site`, 'success');
              } catch (error) {
                const authExpired = error.message.includes('401') || error.message.includes('403');
                if (authExpired) {
                  addLog('Site session expired - refreshing wallet auth...', 'warn');
                  try {
                    const refreshedSession = await ensureSiteSession(pubkey, keypairBytes, true);
                    await setCashoutOnServer(String(cashout), refreshedSession.idToken);
                    cashoutApplied = true;
                    rememberCashoutSynced(pubkey, String(cashout));
                    addLog(`Cashout refreshed to ${cashout}x on site`, 'success');
                  } catch (refreshError) {
                    addLog(`Cashout sync failed: ${refreshError.message}`, 'error');
                  }
                } else {
                  addLog(`Cashout sync failed: ${error.message}`, 'error');
                }
              }
            }

            if (!cashoutApplied) {
              addLog(`Skipping round #${round.roundId} because site cashout was not updated`, 'warn');
              continue;
            }

            const gate = await waitForBetWindow(round.roundId, stopRef, 2500);
            if (!gate.ok) {
              if (gate.reason === 'running' || gate.reason === 'closed') {
                let stillOpen = false;
                try {
                  const currentRound = (await fetchRounds(1))[0];
                  stillOpen =
                    Boolean(currentRound) &&
                    Number(currentRound.roundId) === Number(round.roundId) &&
                    currentRound.gameResult === null;
                } catch {
                  stillOpen = false;
                }

                if (!stillOpen) {
                  addLog(`Round #${round.roundId} join window closed after cashout sync - waiting next round`, 'warn');
                  continue;
                }

                addLog(`Live state lagged, but round #${round.roundId} is still open - sending TX now`, 'warn');
              } else if (gate.reason === 'no-live' || gate.reason === 'timeout') {
                addLog('Live feed is lagging - trying TX with REST round recheck', 'warn');
              } else {
                addLog(`Round #${round.roundId} betting window is uncertain - trying TX with recheck`, 'warn');
              }
            }

            addLog('Bet window confirmed - sending TX now...', 'info');
            await sleep(POST_GATE_SEND_DELAY_MS);
            if (stopRef.current) break;

            try {
              const currentRound = (await fetchRounds(1))[0];
              if (!currentRound || currentRound.roundId !== round.roundId || currentRound.gameResult !== null) {
                addLog(`Round #${round.roundId} already closed - skipping TX`, 'warn');
                continue;
              }
            } catch {
              addLog('Round recheck failed - trying send on current open round', 'warn');
            }

            const blockhash = await getRecentBlockhash(rpcUrl);
            if (!keypairBytes || keypairBytes.length !== 64) {
              addLog('Invalid keypair before TX', 'error');
              continue;
            }

            let signature = null;
            const layouts = getJoinLayoutAttemptOrder(cashout);
            for (const layout of layouts) {
              let txBytes;
              try {
                txBytes = buildAndSignTransaction(
                  keypairBytes,
                  playerAccountPDA,
                  betLamports,
                  cashout,
                  blockhash,
                  round.roundId,
                  layout
                );
              } catch (err) {
                addLog(`TX build error (${layout}): ${err.message}`, 'error');
                txBytes = null;
              }

              if (!txBytes || txBytes.length === 0) {
                addLog(`TX build failed (empty) (${layout})`, 'error');
                continue;
              }

              try {
                const sig = await sendRawTransaction(rpcUrl, txBytes);
                if (!sig || typeof sig !== 'string') {
                  addLog(`TX sent but signature missing (${layout}): ${JSON.stringify(sig)}`, 'error');
                  continue;
                }
                signature = sig;
                rememberJoinLayoutSuccess(layout);
                break;
              } catch (sendErr) {
                const msg = String(sendErr?.message || sendErr);
                const normalized = summarizeTxSendError(msg);
                const alreadyJoinedFail = normalized === 'already joined';
                if (alreadyJoinedFail) {
                  signature = 'already-joined';
                  break;
                }
                const wrongGameState = normalized === 'Wrong game state (bet window not open)';
                if (wrongGameState) {
                  signature = 'wrong-game-state';
                  break;
                }
                if (shouldTryAlternateJoinLayout(msg, normalized, layout)) {
                  addLog(`TX layout ${layout} rejected - retrying alternate layout`, 'warn');
                  continue;
                }
                addLog(`TX send error (${layout}): ${normalized}`, 'error');
                break;
              }
            }

            if (!signature) continue;

            if (signature === 'already-joined') {
              markActiveBet(round.roundId, signature);
              addLog(`Already joined round #${round.roundId} - tracking result`, 'warn');
              const recoveredResult = await waitForRoundResult(round.roundId, cashout, stopRef);
              if (!recoveredResult || stopRef.current) {
                clearActiveBet();
                break;
              }
              clearActiveBet();

              statsRef.current.rounds += 1;
              if (recoveredResult.won) {
                const profit = (betLamports / 1e9) * (cashout - 1);
                statsRef.current.wins += 1;
                statsRef.current.pnl += profit;
                consecutiveLosses = 0;
                completedLockKey = currentLockKey;
                currentLockKey = null;
                addLog(`WIN - cashed @ ${cashout}x  +${profit.toFixed(4)} SOL`, 'success');
                addLog(`Target ${targetLabel} hit. Waiting for the next Oracle lock...`, 'success');
              } else {
                statsRef.current.losses += 1;
                statsRef.current.pnl -= betLamports / 1e9;
                consecutiveLosses += 1;
                addLog(`LOSS - crashed @ ${recoveredResult.crashPoint}x`, 'error');
              }

              setStats({ ...statsRef.current });
              await sleep(500);
              continue;
            }

            if (signature === 'wrong-game-state') {
              addLog(`Round #${round.roundId} is not in betting state - waiting next round`, 'warn');
              await sleep(300);
              continue;
            }

            addLog(`TX sent: ${signature.slice(0, 16)}... - confirming bet`, 'success');
            const confirmation = await waitForSignatureConfirmation(rpcUrl, signature, stopRef);
            if (!confirmation) {
              addLog(`TX not confirmed in time for round #${round.roundId} - skipping result tracking`, 'warn');
              clearActiveBet();
              continue;
            }

            markActiveBet(round.roundId, signature);
            const joinedRound = await waitForBetJoin(round.roundId, playerAccountPDA, pubkey, stopRef);
            if (joinedRound) addLog(`Bet joined round #${round.roundId}`, 'success');

            const result = await waitForRoundResult(round.roundId, cashout, stopRef);
            if (!result || stopRef.current) break;
            clearActiveBet();

            statsRef.current.rounds += 1;
            if (result.won) {
              const profit = (betLamports / 1e9) * (cashout - 1);
              statsRef.current.wins += 1;
              statsRef.current.pnl += profit;
              consecutiveLosses = 0;
              completedLockKey = currentLockKey;
              currentLockKey = null;
              addLog(`WIN - cashed @ ${cashout}x  +${profit.toFixed(4)} SOL`, 'success');
              addLog(`Target ${targetLabel} hit. Waiting for the next Oracle lock...`, 'success');
            } else {
              statsRef.current.losses += 1;
              statsRef.current.pnl -= betLamports / 1e9;
              consecutiveLosses += 1;
              addLog(`LOSS - crashed @ ${result.crashPoint}x`, 'error');
            }
            setStats({ ...statsRef.current });
            await sleep(500);
          } catch (error) {
            clearActiveBet();
            addLog(`Error: ${error.message}`, 'error');
            await sleep(2000);
          }
        }
      } catch (error) {
        clearActiveBet();
        addLog(`Play target start failed: ${error.message}`, 'error');
      } finally {
        clearActiveBet();
        setActiveLaneBets({});
        setLaneCashoutBusy({});
        clearPersistedBotSession();
        stopRef.current = false;
        runRef.current = false;
        setIsRunning(false);
        const session = statsRef.current;
        addLog(
          `Stopped - ${session.rounds} rounds | W/L: ${session.wins}/${session.losses} | P&L: ${session.pnl >= 0 ? '+' : ''}${session.pnl.toFixed(4)} SOL`,
          session.pnl >= 0 ? 'success' : 'error'
        );
      }
    } finally {
      startLockRef.current = false;
    }
  }, [
    addLog,
    betSol,
    clearActiveBet,
    ensureBotConfig,
    ensureSiteSession,
    isRoundJoinableNow,
    markActiveBet,
    maxRounds,
    playTarget,
    privateKey,
    stopLossCount,
    waitForBetWindow,
    waitForOracleLiveLock,
  ]);

  const startBot = useCallback(async () => {
    if (strategyMode === 'multi') {
      await startMultiWalletBot();
      return;
    }
    if (strategyMode === 'play-target') {
      await startPlayTargetBot();
      return;
    }
    if (runRef.current || startLockRef.current) {
      addLog('Bot is already running', 'warn');
      return;
    }
    startLockRef.current = true;
    try {
    if (!privateKey.trim()) {
      addLog('Wallet key required', 'error');
      return;
    }

    let keypairBytes;
    try {
      keypairBytes = bs58Decode(privateKey.trim());
      if (!keypairBytes || keypairBytes.length !== 64) {
        throw new Error('Private key must decode to 64 bytes');
      }
    } catch (error) {
      addLog(`Key error: ${error.message}`, 'error');
      return;
    }

    let botConfig;
    try {
      botConfig = await ensureBotConfig();
    } catch (error) {
      addLog(`Bot config error: ${error.message}`, 'error');
      return;
    }

    const { rpcUrl, playerAccountPDA } = botConfig;

    const betLamports = solToLamports(betSol);
    const cashout = parseFloat(targetMultiplier);
    const stopLoss = parseInt(stopLossCount, 10) || 999999;
    const maxR = parseInt(maxRounds, 10) || 999999;

    if (betLamports < 1000000) {
      addLog('Min bet 0.001 SOL', 'error');
      return;
    }
    if (cashout < 1.01) {
      addLog('Min cashout 1.01x', 'error');
      return;
    }
    const pubkey = bs58Encode(keypairBytes.slice(32));
    clearActiveBet();
    setRecoveredSession(false);
    stopRef.current = false;
    runRef.current = true;
    writePersistedBotSession({
      walletId: pubkey,
      running: true,
      activeRoundId: null,
      startedAt: Date.now(),
    });
    statsRef.current = { rounds: 0, wins: 0, losses: 0, pnl: 0 };
    setStats({ ...statsRef.current });
    setIsRunning(true);
    addLog(`Started - ${betSol} SOL @ ${cashout}x | stop loss: ${stopLoss}`, 'success');

    let consecutiveLosses = 0;
    let lastPlayedRoundId = null;

    try {
      const initialSession = await ensureSiteSession(pubkey, keypairBytes);
      addLog(
        initialSession.username
          ? `Site session live for ${initialSession.username}`
          : 'Site session live',
        'success'
      );

      while (!stopRef.current) {
        const session = statsRef.current;
        if (session.rounds >= maxR && maxR !== 999999) {
          addLog('Max rounds reached', 'warn');
          break;
        }
        if (consecutiveLosses >= stopLoss) {
          addLog('Stop loss triggered', 'warn');
          break;
        }

        try {
          const balance = await getBalance(rpcUrl, pubkey);
          setWalletInfo(current => ({ pubkey: current?.pubkey || pubkey, balance }));
          if (balance < betLamports + TX_FEE_BUFFER) {
            addLog(`Insufficient balance: ${lamportsToSol(balance)} SOL`, 'error');
            break;
          }

          addLog('Waiting for next round...', 'info');
        const round = await waitForActiveRound(stopRef, lastPlayedRoundId, isRoundJoinableNow);
        if (!round || stopRef.current) break;

        lastPlayedRoundId = round.roundId;
        writePersistedBotSession({
          walletId: pubkey,
          running: true,
          activeRoundId: Number(round.roundId),
          startedAt: Date.now(),
        });

        if (roundHasPlayer(round, playerAccountPDA, pubkey)) {
          markActiveBet(round.roundId, 'already-joined');
          addLog(`Already joined round #${round.roundId} - waiting for result`, 'warn');
          const recoveredResult = await waitForRoundResult(round.roundId, cashout, stopRef);
          clearActiveBet();
          if (recoveredResult && !stopRef.current) {
            addLog(`Recovered round #${round.roundId} settled @ ${recoveredResult.crashPoint}x`, 'info');
          }
          await sleep(300);
          continue;
        }

        const preGate = await waitForBetWindow(round.roundId, stopRef, 6000);
        if (!preGate.ok) {
          if (preGate.reason === 'running' || preGate.reason === 'closed') {
            addLog(`Round #${round.roundId} join window already closed - waiting next round`, 'warn');
          } else if (preGate.reason === 'no-live') {
            addLog('Live feed unavailable - waiting for sync before lock entry', 'warn');
          } else {
            addLog(`Round #${round.roundId} join window not ready yet - waiting next round`, 'warn');
          }
          continue;
        }

        addLog(`Round #${round.roundId} - setting cashout to ${cashout}x...`, 'info');

          let cashoutApplied = false;
          if (isCashoutAlreadySynced(pubkey, targetMultiplier)) {
            cashoutApplied = true;
          } else {
            try {
              const liveSession = await ensureSiteSession(pubkey, keypairBytes);
              await setCashoutOnServer(targetMultiplier, liveSession.idToken);
              cashoutApplied = true;
              rememberCashoutSynced(pubkey, targetMultiplier);
              addLog(`Cashout set to ${cashout}x on site`, 'success');
            } catch (error) {
              const authExpired = error.message.includes('401') || error.message.includes('403');
              if (authExpired) {
                addLog('Site session expired - refreshing wallet auth...', 'warn');
                try {
                  const refreshedSession = await ensureSiteSession(pubkey, keypairBytes, true);
                  await setCashoutOnServer(targetMultiplier, refreshedSession.idToken);
                  cashoutApplied = true;
                  rememberCashoutSynced(pubkey, targetMultiplier);
                  addLog(`Cashout refreshed to ${cashout}x on site`, 'success');
                } catch (refreshError) {
                  addLog(`Cashout sync failed: ${refreshError.message}`, 'error');
                }
              } else {
                addLog(`Cashout sync failed: ${error.message}`, 'error');
              }
            }
          }

          if (!cashoutApplied) {
            addLog(`Skipping round #${round.roundId} because site cashout was not updated`, 'warn');
            continue;
          }

          const gate = await waitForBetWindow(round.roundId, stopRef, 2500);
          if (!gate.ok) {
            if (gate.reason === 'running' || gate.reason === 'closed') {
              let stillOpen = false;
              try {
                const currentRound = (await fetchRounds(1))[0];
                stillOpen =
                  Boolean(currentRound) &&
                  Number(currentRound.roundId) === Number(round.roundId) &&
                  currentRound.gameResult === null;
              } catch {
                stillOpen = false;
              }

              if (!stillOpen) {
                addLog(`Round #${round.roundId} join window closed after cashout sync - waiting next round`, 'warn');
                continue;
              }

              addLog(`Live state lagged, but round #${round.roundId} is still open - sending TX now`, 'warn');
            } else if (gate.reason === 'no-live' || gate.reason === 'timeout') {
              addLog('Live feed is lagging - trying TX with REST round recheck', 'warn');
            } else {
              addLog(`Round #${round.roundId} betting window is uncertain - trying TX with recheck`, 'warn');
            }
          }

          addLog('Bet window confirmed - sending TX now...', 'info');
          await sleep(POST_GATE_SEND_DELAY_MS);
          if (stopRef.current) break;

          try {
            const currentRound = (await fetchRounds(1))[0];
            if (!currentRound || currentRound.roundId !== round.roundId || currentRound.gameResult !== null) {
              addLog(`Round #${round.roundId} already closed - skipping TX`, 'warn');
              continue;
            }
          } catch {
            addLog('Round recheck failed - trying send on current open round', 'warn');
          }

          const blockhash = await getRecentBlockhash(rpcUrl);
          if (!keypairBytes || keypairBytes.length !== 64) {
            addLog('Invalid keypair before TX', 'error');
            continue;
          }

          let signature = null;
          const layouts = getJoinLayoutAttemptOrder(cashout);
          for (const layout of layouts) {
            let txBytes;
            try {
              txBytes = buildAndSignTransaction(
                keypairBytes,
                playerAccountPDA,
                betLamports,
                cashout,
                blockhash,
                round.roundId,
                layout
              );
            } catch (err) {
              addLog(`TX build error (${layout}): ${err.message}`, 'error');
              txBytes = null;
            }

            if (!txBytes || txBytes.length === 0) {
              addLog(`TX build failed (empty) (${layout})`, 'error');
              continue;
            }

            try {
              const sig = await sendRawTransaction(rpcUrl, txBytes);
              if (!sig || typeof sig !== 'string') {
                addLog(`TX sent but signature missing (${layout}): ${JSON.stringify(sig)}`, 'error');
                continue;
              }
              signature = sig;
              rememberJoinLayoutSuccess(layout);
              break;
            } catch (sendErr) {
              const msg = String(sendErr?.message || sendErr);
              const normalized = summarizeTxSendError(msg);
              const alreadyJoinedFail = normalized === 'already joined';
              if (alreadyJoinedFail) {
                signature = 'already-joined';
                break;
              }
              const wrongGameState = normalized === 'Wrong game state (bet window not open)';
              if (wrongGameState) {
                signature = 'wrong-game-state';
                break;
              }
              if (shouldTryAlternateJoinLayout(msg, normalized, layout)) {
                addLog(`TX layout ${layout} rejected - retrying alternate layout`, 'warn');
                continue;
              }
              addLog(`TX send error (${layout}): ${normalized}`, 'error');
              break;
            }
          }

          if (!signature) {
            continue;
          }
          if (signature === 'already-joined') {
            markActiveBet(round.roundId, signature);
            addLog(`Already joined round #${round.roundId} - tracking result`, 'warn');
            const recoveredResult = await waitForRoundResult(round.roundId, cashout, stopRef);
            if (!recoveredResult || stopRef.current) {
              clearActiveBet();
              break;
            }
            clearActiveBet();

            statsRef.current.rounds += 1;
            if (recoveredResult.won) {
              const profit = (betLamports / 1e9) * (cashout - 1);
              statsRef.current.wins += 1;
              statsRef.current.pnl += profit;
              consecutiveLosses = 0;
              addLog(`WIN - cashed @ ${cashout}x  +${profit.toFixed(4)} SOL`, 'success');
            } else {
              statsRef.current.losses += 1;
              statsRef.current.pnl -= betLamports / 1e9;
              consecutiveLosses += 1;
              addLog(`LOSS - crashed @ ${recoveredResult.crashPoint}x`, 'error');
            }

            setStats({ ...statsRef.current });
            await sleep(500);
            continue;
          }
          if (signature === 'wrong-game-state') {
            addLog(`Round #${round.roundId} is not in betting state - waiting next round`, 'warn');
            await sleep(300);
            continue;
          }
          addLog(`TX sent: ${signature.slice(0, 16)}... - confirming bet`, 'success');

          const confirmation = await waitForSignatureConfirmation(rpcUrl, signature, stopRef);
          if (!confirmation) {
            addLog(`TX not confirmed in time for round #${round.roundId} - skipping result tracking`, 'warn');
            clearActiveBet();
            continue;
          }

          markActiveBet(round.roundId, signature);

          const joinedRound = await waitForBetJoin(round.roundId, playerAccountPDA, pubkey, stopRef);
          if (joinedRound) {
            addLog(`Bet joined round #${round.roundId}`, 'success');
          }

          const result = await waitForRoundResult(round.roundId, cashout, stopRef);
          if (!result || stopRef.current) break;
          clearActiveBet();

          statsRef.current.rounds += 1;
          if (result.won) {
            const profit = (betLamports / 1e9) * (cashout - 1);
            statsRef.current.wins += 1;
            statsRef.current.pnl += profit;
            consecutiveLosses = 0;
            addLog(`WIN - cashed @ ${cashout}x  +${profit.toFixed(4)} SOL`, 'success');
          } else {
            statsRef.current.losses += 1;
            statsRef.current.pnl -= betLamports / 1e9;
            consecutiveLosses += 1;
            addLog(`LOSS - crashed @ ${result.crashPoint}x`, 'error');
          }

          setStats({ ...statsRef.current });
          await sleep(500);
        } catch (error) {
          clearActiveBet();
          addLog(`Error: ${error.message}`, 'error');
          await sleep(2000);
        }
      }
    } catch (error) {
      clearActiveBet();
      addLog(`Bot start failed: ${error.message}`, 'error');
    } finally {
      clearActiveBet();
      setActiveLaneBets({});
      setLaneCashoutBusy({});
      clearPersistedBotSession();
      stopRef.current = false;
      runRef.current = false;
      setIsRunning(false);
      const session = statsRef.current;
      addLog(
        `Stopped - ${session.rounds} rounds | W/L: ${session.wins}/${session.losses} | P&L: ${session.pnl >= 0 ? '+' : ''}${session.pnl.toFixed(4)} SOL`,
        session.pnl >= 0 ? 'success' : 'error'
      );
    }
    } finally {
      startLockRef.current = false;
    }
  }, [addLog, betSol, clearActiveBet, ensureBotConfig, ensureSiteSession, isRoundJoinableNow, markActiveBet, maxRounds, privateKey, startMultiWalletBot, startPlayTargetBot, stopLossCount, strategyMode, targetMultiplier, waitForBetWindow]);

  const stopBot = useCallback(() => {
    if (!runRef.current && !isRunning && !hasActiveBet && !recoveredSession) {
      return;
    }
    stopRef.current = true;
    clearActiveBet();
    setActiveLaneBets({});
    setLaneCashoutBusy({});
    clearPersistedBotSession();
    setRecoveredSession(false);
    if (runRef.current || isRunning) {
      setIsRunning(false);
      addLog('Stopping...', 'warn');
    } else {
      addLog('Session cleared. You can start bot now.', 'success');
    }
  }, [addLog, clearActiveBet, hasActiveBet, isRunning, recoveredSession]);

  const pnlColor = stats.pnl >= 0 ? '#00ff88' : '#ff4444';
  return (
    <div className="panel wallet-bot-panel">
      <div className="panel-header">
        <span className="panel-icon">BOT</span>
        <h2>AUTO BOT</h2>
        <span className="bot-build-badge">{UI_BUILD_STAMP}</span>
        <span className={`bot-status-badge ${isRunning ? 'running' : ''}`}>
          {isRunning ? 'LIVE RUNNING' : 'IDLE'}
        </span>
      </div>

      {(strategyMode === 'single' || strategyMode === 'play-target') && (
      <div className="bot-section">
        <div className="bot-section-title">WALLET</div>
        <div className="input-group">
          <label>Private Key</label>
          <div className="key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              placeholder="Enter wallet key"
              className="bot-input"
              disabled={isRunning}
              name="wallet-private-key"
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <button type="button" className="btn-icon" onClick={() => setShowKey(value => !value)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <button className="btn btn-refresh" onClick={loadWallet} disabled={isRunning || isWalletLoading} style={{ width: '100%' }}>
          {isWalletLoading ? 'LOADING...' : 'LOAD WALLET'}
        </button>

        {walletInfo && (
          <div className="wallet-info-box">
            <div className="info-row">
              <span>Address</span>
              <span className="green" style={{ fontSize: '10px' }}>
                {walletInfo.pubkey.slice(0, 16)}...{walletInfo.pubkey.slice(-8)}
              </span>
            </div>
            <div className="info-row">
              <span>Balance</span>
              <span className="yellow">{lamportsToSol(walletInfo.balance)} SOL</span>
            </div>
          </div>
        )}
      </div>
      )}

      <div className="bot-section">
        <div className="bot-section-title">STRATEGY</div>
        {!hideModeSelector && (
          <div className="strategy-mode-row">
            <div className="input-group">
              <label>Mode</label>
              <select
                className="bot-input"
                value={strategyMode}
                onChange={e => setStrategyMode(e.target.value)}
                disabled={isRunning || Boolean(normalizedForceMode)}
              >
                <option value="single">Single Wallet</option>
                <option value="play-target">Play Target</option>
                <option value="multi">Multiple Wallets</option>
              </select>
            </div>
          </div>
        )}
        {strategyMode === 'single' ? (
          <div className="strategy-grid">
            <div className="input-group">
              <label>Bet (SOL)</label>
              <input
                type="number"
                value={betSol}
                onChange={e => setBetSol(e.target.value)}
                step="0.001"
                min="0.001"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Auto Cashout</label>
              <input
                type="number"
                value={targetMultiplier}
                onChange={e => setTargetMultiplier(e.target.value)}
                step="0.1"
                min="1.1"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Stop Loss</label>
              <input
                type="number"
                value={stopLossCount}
                onChange={e => setStopLossCount(e.target.value)}
                min="1"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Max Rounds (0=infinite)</label>
              <input
                type="number"
                value={maxRounds}
                onChange={e => setMaxRounds(e.target.value)}
                min="0"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
          </div>
        ) : strategyMode === 'play-target' ? (
          <div className="strategy-grid">
            <div className="input-group">
              <label>Bet (SOL)</label>
              <input
                type="number"
                value={betSol}
                onChange={e => setBetSol(e.target.value)}
                step="0.001"
                min="0.001"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Play Target</label>
              <select
                className="bot-input"
                value={playTarget}
                onChange={e => setPlayTarget(e.target.value)}
                disabled={isRunning}
              >
                {PLAY_TARGET_OPTIONS.map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            <div className="input-group">
              <label>Stop Loss</label>
              <input
                type="number"
                value={stopLossCount}
                onChange={e => setStopLossCount(e.target.value)}
                min="1"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Max Rounds (0=infinite)</label>
              <input
                type="number"
                value={maxRounds}
                onChange={e => setMaxRounds(e.target.value)}
                min="0"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
          </div>
        ) : (
          <div className="strategy-grid">
            <div className="input-group">
              <label>Stop Loss</label>
              <input
                type="number"
                value={stopLossCount}
                onChange={e => setStopLossCount(e.target.value)}
                min="1"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
            <div className="input-group">
              <label>Max Rounds (0=infinite)</label>
              <input
                type="number"
                value={maxRounds}
                onChange={e => setMaxRounds(e.target.value)}
                min="0"
                className="bot-input"
                disabled={isRunning}
              />
            </div>
          </div>
        )}
        {strategyMode === 'multi' && (
          <div className="multi-wallet-wrap">
            <div className="multi-wallet-head">
              <div className="bot-section-title multi-wallet-title">MULTIPLE WALLETS</div>
              <div className="multi-wallet-actions">
                {!(normalizedForceMode === 'multi' && normalizedFixedLaneCount > 0) && (
                  <button
                    type="button"
                    className="btn btn-refresh btn-inline"
                    onClick={addMultiWalletLane}
                    disabled={isRunning}
                  >
                    + ADD WALLET
                  </button>
                )}
              </div>
            </div>

            <div className="multi-wallet-list">
              {multiWalletLanes.map((lane, idx) => {
                const laneMeta = multiWalletMeta[lane.id] || {};
                const lanePubkey = laneMeta.pubkey
                  ? `${laneMeta.pubkey.slice(0, 10)}...${laneMeta.pubkey.slice(-6)}`
                  : '';
                const laneBalance = Number.isFinite(Number(laneMeta.balance))
                  ? `${lamportsToSol(Number(laneMeta.balance || 0))} SOL`
                  : '';
                const laneStatus = laneMeta.loading ? 'Loading...' : (laneMeta.loaded ? 'Ready' : '');
                const laneStatusClass = laneMeta.loading ? 'loading' : 'ok';
                const hasMetaRow = Boolean(lanePubkey || laneBalance || laneMeta.error);
                const laneCanCashout =
                  Boolean(activeLaneBets[lane.id]) &&
                  isRunning &&
                  liveState?.phase === LIVE_PHASE.RUNNING;
                return (
                  <div key={lane.id} className="multi-wallet-lane">
                    <button
                      type="button"
                      className="btn btn-stop btn-inline btn-remove-wallet multi-wallet-remove-corner"
                      onClick={() => removeMultiWalletLane(lane.id)}
                      disabled={
                        isRunning ||
                        multiWalletLanes.length <= 1 ||
                        (normalizedForceMode === 'multi' && normalizedFixedLaneCount > 0)
                      }
                      aria-label={`Remove wallet ${idx + 1}`}
                    >
                      X
                    </button>

                    <div className="multi-wallet-lane-head">
                      <div className="multi-wallet-lane-label">Wallet {idx + 1}</div>
                      {laneStatus ? <div className={`multi-wallet-lane-status ${laneStatusClass}`}>{laneStatus}</div> : null}
                    </div>

                    <div className="multi-wallet-key-row">
                      <input
                        type="password"
                        className="bot-input"
                        placeholder={`Wallet ${idx + 1} private key`}
                        value={lane.privateKey}
                        onChange={e => updateMultiWalletLane(lane.id, 'privateKey', e.target.value)}
                        disabled={isRunning}
                        autoComplete="new-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </div>

                    <div className="multi-wallet-load-row">
                      <button
                        type="button"
                        className="btn btn-refresh btn-inline btn-load-wallet"
                        onClick={() => loadMultiWalletLane(lane.id)}
                        disabled={isRunning || Boolean(laneMeta.loading)}
                      >
                        {laneMeta.loading ? 'LOADING...' : 'LOAD'}
                      </button>
                    </div>

                    <div className="multi-wallet-lane-grid">
                      <div className="input-group multi-wallet-input-group">
                        <label>Bet (SOL)</label>
                        <input
                          type="number"
                          className="bot-input"
                          min="0.001"
                          step="0.001"
                          value={lane.betSol}
                          onChange={e => updateMultiWalletLane(lane.id, 'betSol', e.target.value)}
                          disabled={isRunning}
                        />
                      </div>
                      <div className="input-group multi-wallet-input-group">
                        <label>Cashout (x)</label>
                        <input
                          type="number"
                          className="bot-input"
                          min="1.01"
                          step="0.1"
                          value={lane.cashout}
                          onChange={e => updateMultiWalletLane(lane.id, 'cashout', e.target.value)}
                          disabled={isRunning}
                        />
                      </div>
                    </div>

                    {hasMetaRow ? (
                      <div className="multi-wallet-meta-row">
                        {lanePubkey ? <span>{lanePubkey}</span> : null}
                        {laneBalance ? <span>{laneBalance}</span> : null}
                        {laneMeta.error ? <span>{laneMeta.error}</span> : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className={`btn btn-stop multi-wallet-cashout-btn${laneCanCashout ? ' active' : ''}`}
                      onClick={() => manualCashoutLane(lane.id)}
                      disabled={!laneCanCashout || Boolean(laneCashoutBusy[lane.id])}
                    >
                      {laneCashoutBusy[lane.id]
                        ? 'SENDING...'
                        : laneCanCashout
                          ? 'CASHOUT'
                          : 'WAITING'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="bot-section">
        <div className="bot-section-title">SESSION</div>
        <div className="stats-grid wallet-session-grid">
          <div className="stat-cell">
            <div className="stat-label">Rounds</div>
            <div className="stat-value cyan">{stats.rounds}</div>
          </div>
          <div className="stat-cell">
            <div className="stat-label">W / L</div>
            <div className="stat-value">{stats.wins} / {stats.losses}</div>
          </div>
          <div className="stat-cell" style={{ gridColumn: '1 / -1' }}>
            <div className="stat-label">P&L</div>
            <div className="stat-value" style={{ color: pnlColor }}>
              {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(4)} SOL
            </div>
          </div>
        </div>
      </div>

      <div className="btn-row bot-action-row">
        <button className="btn btn-start" onClick={startBot} disabled={isRunning || hasActiveBet || recoveredSession || isWalletLoading}>
          START BOT
        </button>
        <button className="btn btn-stop" onClick={stopBot} disabled={!isRunning && !hasActiveBet && !recoveredSession}>
          {isRunning ? 'STOP' : 'CLEAR'}
        </button>
      </div>

      <div className="bot-section wallet-log-section">
        <div className="bot-section-title">LOG</div>
        <div className="log-scroll wallet-log-scroll">
          {botLog.length === 0 && <div className="no-data">No activity yet</div>}
          {botLog.map(entry => (
            <div key={entry.id} className={`log-entry log-${entry.type}`}>
              <span className="log-ts">[{entry.ts}]</span>
              <span className="log-dot">*</span>
              <span className="log-msg">{entry.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
