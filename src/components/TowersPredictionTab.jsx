import React, { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../config/apiBase';

const API_URL = API_BASE;

const TOWER_SITE = {
  sourceKey: 'degencoinflip-towers',
  label: 'Degen Coin Flip Towers',
  gameUrl: 'https://app.degencoinflip.com/towers',
  adapter: 'degencoinflip',
  apiUrl: 'https://api.dealer.degencoinflip.com/v1/game/3/room/1/rounds?limit=100',
  roundsPath: '?limit=100',
};

const LETTERS = ['A', 'B', 'C'];
const RESULT_TO_LETTER = { 3: 'A', 5: 'B', 6: 'C' };
const LETTER_COLORS = { A: '#00ff88', B: '#00d4ff', C: '#ff9f43' };
const MODEL_WINDOWS = [18, 24, 36, 48, 60, 80];
const TRAIN_LOOKBACK = 60;
const FORECAST_DEPTH = 10;

function boundValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createScoreBucket() {
  return { A: 0, B: 0, C: 0 };
}

function makeTransitionBucket() {
  return { A: createScoreBucket(), B: createScoreBucket(), C: createScoreBucket() };
}

function getMapBucket(map, key) {
  if (!map.has(key)) map.set(key, createScoreBucket());
  return map.get(key);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatTime(value) {
  const ts = Number(value);
  if (Number.isFinite(ts) && ts > 0) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const parsed = Number(new Date(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 'now';
  return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toTowerSequence(rawPayload) {
  if (!rawPayload) return '';
  const source = rawPayload.towerSequence || rawPayload.gameResult || rawPayload.game_result || rawPayload.sequence || null;
  let value = source;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return '';
    }
  }
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => RESULT_TO_LETTER[Number(entry?.result ?? entry?.choice ?? entry?.value)] || '')
    .filter(Boolean)
    .join('');
}

function extractRoundSequence(round) {
  if (!round) return '';
  if (typeof round.towerSequenceText === 'string' && round.towerSequenceText.trim()) {
    return round.towerSequenceText.trim();
  }
  if (Array.isArray(round.towerSequence) && round.towerSequence.length) {
    return round.towerSequence.map((entry) => entry?.letter).filter(Boolean).join('');
  }
  return toTowerSequence(round.rawPayload || round);
}

function normalizeRounds(rounds = []) {
  return rounds
    .map((round) => ({
      ...round,
      sequence: extractRoundSequence(round),
    }))
    .filter((round) => round.sequence && round.sequence.length >= 4);
}

function trainTowerModel(rounds) {
  const positionStats = Array.from({ length: FORECAST_DEPTH }, () => createScoreBucket());
  const transition1 = Array.from({ length: FORECAST_DEPTH }, () => makeTransitionBucket());
  const transition2 = Array.from({ length: FORECAST_DEPTH }, () => new Map());
  const transition3 = Array.from({ length: FORECAST_DEPTH }, () => new Map());
  const totals = createScoreBucket();
  const recentBias = createScoreBucket();

  rounds.slice(-TRAIN_LOOKBACK).forEach((round, reverseIndex) => {
    const weight = Math.pow(0.93, reverseIndex);
    const letters = String(round.sequence || '')
      .split('')
      .filter((letter) => LETTERS.includes(letter));

    for (let i = 0; i < Math.min(letters.length, FORECAST_DEPTH); i += 1) {
      const letter = letters[i];
      positionStats[i][letter] += weight;
      totals[letter] += weight;
      recentBias[letter] += weight;

      if (i >= 1) {
        const prev1 = letters[i - 1];
        transition1[i][prev1][letter] += weight;
      }
      if (i >= 2) {
        const key2 = `${letters[i - 2]}${letters[i - 1]}`;
        getMapBucket(transition2[i], key2)[letter] += weight;
      }
      if (i >= 3) {
        const key3 = `${letters[i - 3]}${letters[i - 2]}${letters[i - 1]}`;
        getMapBucket(transition3[i], key3)[letter] += weight;
      }
    }
  });

  return { positionStats, transition1, transition2, transition3, totals, recentBias };
}

function applyPatternPenalty(scores, prefix) {
  const tail = prefix.slice(-4);
  if (tail.length < 4) return;
  const [a, b, c, d] = tail;
  if (a === b && b === c) scores[a] *= 0.74;
  if (b === c && c === d) scores[b] *= 0.74;
  if (a === c && b === d && a !== b) {
    scores[a] *= 0.9;
    scores[b] *= 0.9;
  }
  if (a === b && c === d && a !== c) {
    scores[a] *= 0.92;
    scores[c] *= 0.92;
  }
}

function scorePosition(model, prefix, position) {
  const scores = createScoreBucket();
  const positionWeight = position < 3 ? 1.08 : position < 7 ? 1 : 0.92;

  for (const letter of LETTERS) {
    scores[letter] += (model.positionStats[position]?.[letter] || 0) * positionWeight;
    scores[letter] += (model.totals[letter] || 0) * (position === 0 ? 0.06 : 0.02);
    scores[letter] += (model.recentBias[letter] || 0) * (position === 0 ? 0.18 : 0.04);
  }

  if (prefix.length >= 1) {
    const prev1 = prefix[prefix.length - 1];
    for (const letter of LETTERS) {
      scores[letter] += (model.transition1[position]?.[prev1]?.[letter] || 0) * 0.58;
    }
  }

  if (prefix.length >= 2) {
    const key2 = prefix.slice(-2);
    const bucket2 = model.transition2[position]?.get(key2);
    if (bucket2) {
      for (const letter of LETTERS) {
        scores[letter] += (bucket2[letter] || 0) * 0.47;
      }
    }
  }

  if (prefix.length >= 3) {
    const key3 = prefix.slice(-3);
    const bucket3 = model.transition3[position]?.get(key3);
    if (bucket3) {
      for (const letter of LETTERS) {
        scores[letter] += (bucket3[letter] || 0) * 0.38;
      }
    }
  }

  applyPatternPenalty(scores, prefix);

  const ordered = LETTERS
    .map((letter) => [letter, scores[letter]])
    .sort((a, b) => b[1] - a[1]);
  const [bestLetter, bestScore] = ordered[0];
  const secondScore = ordered[1]?.[1] || 0;
  const confidence = bestScore > 0 ? boundValue(((bestScore - secondScore) / bestScore) * 100, 0, 100) : 0;

  return { letter: bestLetter || 'A', confidence };
}

function predictTowerSequence(rounds, horizon = FORECAST_DEPTH) {
  if (!rounds.length) {
    return { forecast: '', confidence: 0 };
  }
  const model = trainTowerModel(rounds);
  const forecast = [];
  const stepConfidence = [];

  for (let i = 0; i < horizon; i += 1) {
    const { letter, confidence } = scorePosition(model, forecast, i);
    forecast.push(letter);
    stepConfidence.push(confidence);
  }

  const avgConfidence = stepConfidence.length
    ? stepConfidence.reduce((sum, value) => sum + value, 0) / stepConfidence.length
    : 0;

  return {
    forecast: forecast.join(''),
    confidence: boundValue(avgConfidence, 0, 100),
  };
}

function evaluateWindow(rounds, windowSize) {
  const usable = normalizeRounds(rounds);
  if (usable.length < 8) {
    return { score: 0, exactRate: 0, partialRate: 0, samples: 0 };
  }

  const start = Math.max(5, usable.length - 18);
  let exactWins = 0;
  let partialMatches = 0;
  let samples = 0;

  for (let i = start; i < usable.length; i += 1) {
    const training = usable.slice(Math.max(0, i - windowSize), i);
    if (training.length < 5) continue;

    const predicted = predictTowerSequence(training, 4).forecast.slice(0, 4);
    const actual = String(usable[i].sequence || '').slice(0, 4);
    const matches = predicted.split('').reduce((count, letter, idx) => count + (letter === actual[idx] ? 1 : 0), 0);

    exactWins += matches === 4 ? 1 : 0;
    partialMatches += matches / 4;
    samples += 1;
  }

  if (!samples) {
    return { score: 0, exactRate: 0, partialRate: 0, samples: 0 };
  }

  const exactRate = exactWins / samples;
  const partialRate = partialMatches / samples;
  return {
    score: (partialRate * 0.7) + (exactRate * 0.3),
    exactRate,
    partialRate,
    samples,
  };
}

function buildPrediction(rounds) {
  const usableRounds = normalizeRounds(rounds);
  if (!usableRounds.length) {
    return {
      forecast: '',
      confidence: 0,
      bestWindow: 0,
      predictedRoundId: null,
      roundsTracked: 0,
    };
  }

  const candidates = MODEL_WINDOWS.map((windowSize) => {
    const training = usableRounds.slice(-windowSize);
    const forecastInfo = predictTowerSequence(training, FORECAST_DEPTH);
    const scoreInfo = evaluateWindow(usableRounds, windowSize);
    const combinedScore = (scoreInfo.score * 100) + (forecastInfo.confidence * 0.35);
    return {
      windowSize,
      ...forecastInfo,
      ...scoreInfo,
      combinedScore,
    };
  });

  const best = [...candidates].sort((a, b) => {
    if (b.combinedScore !== a.combinedScore) return b.combinedScore - a.combinedScore;
    if (b.samples !== a.samples) return b.samples - a.samples;
    return b.windowSize - a.windowSize;
  })[0];

  const latestRound = usableRounds[usableRounds.length - 1];
  const latestRoundId = Number(latestRound?.roundId);

  return {
    forecast: best?.forecast || '',
    confidence: boundValue(Math.round(((best?.confidence || 0) * 0.55) + ((best?.score || 0) * 100 * 0.45)), 0, 100),
    bestWindow: best?.windowSize || 0,
    predictedRoundId: Number.isFinite(latestRoundId) ? latestRoundId + 1 : null,
    roundsTracked: usableRounds.length,
  };
}

function buildBacktestHistory(rounds) {
  const usableRounds = normalizeRounds(rounds);
  const attempts = [];

  for (let i = 5; i < usableRounds.length; i += 1) {
    const trainingRounds = usableRounds.slice(0, i);
    const forecast = buildPrediction(trainingRounds).forecast.slice(0, 4);
    const actual = usableRounds[i].sequence.slice(0, 4);
    const matches = forecast.split('').reduce((count, letter, idx) => count + (letter === actual[idx] ? 1 : 0), 0);

    attempts.push({
      roundId: usableRounds[i].roundId,
      timestamp: usableRounds[i].timestamp || usableRounds[i].createdAt || null,
      forecast,
      actual,
      matches,
      accuracy: Math.round((matches / 4) * 100),
      outcome: matches === 4 ? 'WIN' : 'LOSS',
    });
  }

  return attempts;
}

function DonutChart({ values }) {
  const entries = LETTERS.map((letter) => ({
    letter,
    value: Number(values?.[letter] || 0),
    color: LETTER_COLORS[letter],
  }));
  const total = entries.reduce((sum, item) => sum + item.value, 0) || 1;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div style={{ position: 'relative', width: 136, height: 136, display: 'grid', placeItems: 'center' }}>
      <svg width="136" height="136" viewBox="0 0 136 136">
        <g transform="translate(68,68) rotate(-90)">
          {entries.map((entry) => {
            const fraction = entry.value / total;
            const dash = circumference * fraction;
            const circle = (
              <circle
                key={entry.letter}
                cx="0"
                cy="0"
                r={radius}
                fill="none"
                stroke={entry.color}
                strokeWidth="13"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                opacity={fraction > 0 ? 1 : 0.16}
              />
            );
            offset += dash;
            return circle;
          })}
        </g>
        <circle cx="68" cy="68" r="33" fill="rgba(8,12,20,0.96)" stroke="rgba(255,255,255,0.06)" />
      </svg>
      <div style={{ position: 'absolute', textAlign: 'center' }}>
        <div style={{ fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase', color: '#8fa0ba' }}>Balance</div>
        <div style={{ fontSize: 24, fontWeight: 900, color: '#f7fbff', lineHeight: 1 }}>{total.toLocaleString()}</div>
      </div>
    </div>
  );
}

function LetterChip({ letter, active = false, matchState = null }) {
  const color = LETTER_COLORS[letter] || '#8ea2ba';
  const isMatch = matchState === 'match';
  const isMiss = matchState === 'miss';
  const bg = isMatch
    ? 'rgba(0,255,136,0.14)'
    : isMiss
      ? 'rgba(255,95,95,0.14)'
      : active
        ? `${color}18`
        : 'rgba(255,255,255,0.03)';
  const border = isMatch
    ? '1px solid #00ff8855'
    : isMiss
      ? '1px solid #ff5f5f55'
      : `1px solid ${color}${active ? 'aa' : '44'}`;
  const text = isMatch ? '#00ff88' : isMiss ? '#ff6d6d' : active ? color : '#d8e2ee';

  return (
    <span
      style={{
        minWidth: 28,
        padding: '6px 10px',
        borderRadius: 999,
        border,
        background: bg,
        color: text,
        fontWeight: 900,
        fontSize: 12,
        letterSpacing: 0.8,
        textAlign: 'center',
      }}
    >
      {letter}
    </span>
  );
}

function OutcomeBadge({ outcome }) {
  const isWin = outcome === 'WIN';
  return (
    <span
      style={{
        padding: '4px 8px',
        borderRadius: 999,
        fontSize: 10,
        letterSpacing: 1,
        textTransform: 'uppercase',
        fontWeight: 900,
        color: isWin ? '#00ff88' : '#ff9f43',
        border: `1px solid ${isWin ? '#00ff8844' : '#ff9f4344'}`,
        background: isWin ? '#00ff8810' : '#ff9f4310',
      }}
    >
      {outcome}
    </span>
  );
}

function HistoryRow({ entry }) {
  const isWin = entry.outcome === 'WIN';
  const forecast = String(entry.forecast || '').split('');
  const actual = String(entry.actual || '').split('');

  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: '12px 12px',
        borderRadius: 14,
        background: isWin ? 'rgba(0,255,136,0.08)' : 'rgba(255,95,95,0.08)',
        border: `1px solid ${isWin ? 'rgba(0,255,136,0.18)' : 'rgba(255,95,95,0.18)'}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ color: '#dbe6f4', fontWeight: 800 }}>#{entry.roundId}</div>
        <OutcomeBadge outcome={entry.outcome} />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: '#93a6bf', fontSize: 12 }}>Forecast</span>
        {forecast.map((letter, idx) => (
          <LetterChip
            key={`${entry.roundId}-f-${idx}`}
            letter={letter}
            matchState={letter === actual[idx] ? 'match' : 'miss'}
          />
        ))}
        <span style={{ color: '#93a6bf', fontSize: 12, marginLeft: 4 }}>Actual</span>
        {actual.map((letter, idx) => (
          <LetterChip
            key={`${entry.roundId}-a-${idx}`}
            letter={letter}
            matchState={letter === forecast[idx] ? 'match' : 'miss'}
          />
        ))}
        <span style={{ color: '#8fa0ba', fontSize: 12 }}>Match {entry.matches}/4</span>
      </div>
    </div>
  );
}

export default function TowersPredictionTab() {
  const [site, setSite] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const loadTowers = async (refreshLive = false) => {
    if (!refreshLive) setLoading(true);
    else setRefreshing(true);

    try {
      let sitesPayload = await fetchJsonWithTimeout(`${API_URL}/crash-sites`, {}, 12000);
      let towersSite = Array.isArray(sitesPayload?.sites)
        ? sitesPayload.sites.find((entry) => {
            const sourceKey = String(entry?.sourceKey || '').toLowerCase();
            const gameUrl = String(entry?.gameUrl || '').toLowerCase();
            return sourceKey === TOWER_SITE.sourceKey || gameUrl.includes('/towers');
          })
        : null;

      if (!towersSite) {
        setSaving(true);
        await fetchJsonWithTimeout(`${API_URL}/crash-sites`, {
          method: 'POST',
          body: JSON.stringify({
            ...TOWER_SITE,
            enabled: true,
            pollIntervalMs: 20000,
          }),
        }, 12000);
        sitesPayload = await fetchJsonWithTimeout(`${API_URL}/crash-sites`, {}, 12000);
        towersSite = Array.isArray(sitesPayload?.sites)
          ? sitesPayload.sites.find((entry) => {
              const sourceKey = String(entry?.sourceKey || '').toLowerCase();
              const gameUrl = String(entry?.gameUrl || '').toLowerCase();
              return sourceKey === TOWER_SITE.sourceKey || gameUrl.includes('/towers');
            })
          : null;
      }

      if (!towersSite?.id) {
        throw new Error('Towers source not available yet');
      }

      const refreshSuffix = refreshLive ? '&refresh=1' : '';
      const roundsPayload = await fetchJsonWithTimeout(
        `${API_URL}/crash-sites/${towersSite.id}/rounds?limit=100${refreshSuffix}`,
        {},
        12000
      );
      const historyPayload = await fetchJsonWithTimeout(
        `${API_URL}/crash-sites/${towersSite.id}/tower-history?limit=200${refreshSuffix}`,
        {},
        12000
      );

      const normalizedRounds = normalizeRounds(Array.isArray(roundsPayload?.rounds) ? roundsPayload.rounds : []);
      const normalizedHistory = Array.isArray(historyPayload?.history) && historyPayload.history.length
        ? historyPayload.history
        : buildBacktestHistory(normalizedRounds);

      setSite(towersSite);
      setRounds(normalizedRounds);
      setHistoryRows(normalizedHistory);
      setError('');
      setLastUpdatedAt(new Date());
      return normalizedRounds;
    } catch (err) {
      setError(err.message || 'Unable to load Towers history');
      return [];
    } finally {
      setLoading(false);
      setRefreshing(false);
      setSaving(false);
    }
  };

  const clearHistory = async () => {
    if (!site?.id) return;
    setSaving(true);
    try {
      await fetchJsonWithTimeout(`${API_URL}/crash-sites/${site.id}/rounds`, {
        method: 'DELETE',
      }, 12000);
      setRounds([]);
      setHistoryRows([]);
      setShowAllHistory(false);
      setLastUpdatedAt(new Date());
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to clear Towers history');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    loadTowers(false);
    const timer = setInterval(() => {
      loadTowers(false);
    }, 25000);
    return () => clearInterval(timer);
  }, []);

  const prediction = useMemo(() => buildPrediction(rounds), [rounds]);
  const predictionHistory = useMemo(() => {
    const source = historyRows.length ? historyRows : buildBacktestHistory(rounds);
    return [...source].slice(-50).reverse();
  }, [historyRows, rounds]);

  const visibleHistory = useMemo(
    () => predictionHistory.slice(0, showAllHistory ? predictionHistory.length : 5),
    [predictionHistory, showAllHistory],
  );

  const totals = useMemo(() => rounds.reduce((acc, round) => {
    for (const letter of round.sequence) {
      if (acc[letter] != null) acc[letter] += 1;
    }
    return acc;
  }, { A: 0, B: 0, C: 0 }), [rounds]);

  const balanceTotal = totals.A + totals.B + totals.C || 1;
  const balanceValues = {
    A: Math.round((totals.A / balanceTotal) * 100),
    B: Math.round((totals.B / balanceTotal) * 100),
    C: Math.round((totals.C / balanceTotal) * 100),
  };

  const heroRound = prediction.predictedRoundId != null ? `#${prediction.predictedRoundId}` : 'Waiting for live Towers data';
  const heroSignal = (prediction.forecast || '').slice(0, 4).split('').filter(Boolean);
  const heroMeta = prediction.roundsTracked
    ? `Model confidence ${prediction.confidence}% • Best-fit window ${prediction.bestWindow || '--'} rounds`
    : 'The collector will fill this once Tower rounds are stored in the database.';

  return (
    <main style={{ width: '100%', marginTop: 10 }}>
      <section
        className="panel"
        style={{
          margin: '0 16px 14px',
          background: 'linear-gradient(180deg, rgba(8, 12, 20, 0.96) 0%, rgba(12, 18, 30, 0.92) 100%)',
        }}
      >
        <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2>TOWERS CHANNEL</h2>
            <p className="panel-subtitle">Prediction target, stored history, and a clean win/loss backtest. No clutter.</p>
            <p className="panel-subtitle" style={{ marginTop: 4 }}>
              {site ? `Connected source: ${site.label}` : 'Connecting to Towers source...'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-refresh"
              type="button"
              onClick={() => loadTowers(true)}
              disabled={loading || refreshing || saving}
            >
              {refreshing ? 'Refreshing...' : 'Refresh now'}
            </button>
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.06fr) minmax(320px, 0.94fr)', gap: 14, margin: '0 16px 24px' }}>
        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-header" style={{ marginBottom: 14 }}>
            <h2>PREDICTION</h2>
            <p className="panel-subtitle">The engine predicts the next round ID and keeps the sequence hidden to reduce clutter.</p>
          </div>

          {error ? (
            <div
              style={{
                marginBottom: 12,
                padding: '10px 12px',
                borderRadius: 10,
                background: '#ff456014',
                border: '1px solid #ff456044',
                color: '#ff93a0',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          ) : null}

          <div
            style={{
              padding: 18,
              borderRadius: 22,
              background: 'radial-gradient(circle at top, rgba(0,255,136,0.12), rgba(13,18,28,0.94) 55%)',
              border: '1px solid rgba(0,255,136,0.28)',
              display: 'grid',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#93a6bf' }}>
              Predicted round ID
            </div>
            <div style={{ fontSize: 34, fontWeight: 900, color: '#f7fbff', lineHeight: 1.04 }}>
              {heroRound}
            </div>
            <div style={{ fontSize: 14, color: '#a8b8cc', lineHeight: 1.6 }}>
              {heroMeta}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
              <span style={{ color: '#93a6bf', fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' }}>Signal</span>
              {heroSignal.length ? heroSignal.map((letter, idx) => (
                <LetterChip key={`${letter}-${idx}`} letter={letter} active />
              )) : (
                <span style={{ color: '#93a6bf', fontSize: 12 }}>Waiting for signal</span>
              )}
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: '#93a6bf' }}>
              Pattern balance
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <DonutChart values={balanceValues} />
              <div style={{ display: 'grid', gap: 8, minWidth: 180 }}>
                {LETTERS.map((letter) => (
                  <div key={letter} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: LETTER_COLORS[letter] }} />
                      <span style={{ color: '#dbe6f4', fontWeight: 800 }}>{letter}</span>
                    </div>
                    <span style={{ color: '#8fa0ba', fontSize: 12 }}>
                      {totals[letter].toLocaleString()} • {balanceValues[letter]}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#8fa0ba', lineHeight: 1.5 }}>
              The model blends recent density, position bias, and sequence transitions while penalizing repeated burn patterns.
            </div>
          </div>

          <div style={{ marginTop: 12, color: '#8fa0ba', fontSize: 12, lineHeight: 1.5 }}>
            Last sync: {lastUpdatedAt ? formatTime(lastUpdatedAt) : 'Waiting for backend'}
          </div>
        </section>

        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-header" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2>PREDICTION HISTORY</h2>
              <p className="panel-subtitle">Only the latest five are shown first. Win means the first four letters matched exactly.</p>
            </div>
            <button
              className="btn"
              type="button"
              onClick={clearHistory}
              disabled={loading || refreshing || saving || !site?.id}
              style={{
                borderColor: 'rgba(255,95,95,0.45)',
                background: 'rgba(255,95,95,0.08)',
                color: '#ffb3b3',
              }}
            >
              {saving ? 'Clearing...' : 'Clear history'}
            </button>
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.02)',
              display: 'grid',
              gap: 10,
            }}
          >
            {visibleHistory.length ? visibleHistory.map((entry) => (
              <HistoryRow key={`${entry.roundId}-${entry.timestamp || 'x'}`} entry={entry} />
            )) : (
              <div style={{ color: '#8fa0ba', fontSize: 13, lineHeight: 1.6 }}>
                Backtest history will appear after a few more rounds.
              </div>
            )}

            {predictionHistory.length > 5 ? (
              <button
                className="btn"
                type="button"
                onClick={() => setShowAllHistory((value) => !value)}
                style={{ width: 'fit-content' }}
              >
                {showAllHistory ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
