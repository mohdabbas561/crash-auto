// utils/gapTracker.js

const TARGETS = [2, 5, 10, 20, 25, 30, 50, 100, 200, 500, 1000];

/**
 * For each target multiplier, count how many rounds have passed
 * since the last time a round reached >= that target.
 * rounds should be sorted oldest → newest.
 */
export function computeGaps(rounds) {
  const gaps = {};
  for (const target of TARGETS) {
    let gap = 0;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].multiplier >= target) break;
      gap++;
    }
    // If never hit, gap = total rounds
    gaps[target] = gap;
  }
  return gaps;
}

/**
 * Compute global stats from all rounds.
 */
export function computeStats(rounds) {
  if (!rounds.length) return { tracked: 0, avg: 0, highest: 0, currentRound: 0 };
  const multipliers = rounds.map((r) => r.multiplier);
  const avg = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
  const highest = Math.max(...multipliers);
  return {
    tracked: rounds.length,
    avg: avg.toFixed(2),
    highest: highest.toFixed(2),
    currentRound: rounds[rounds.length - 1]?.roundId ?? 0,
  };
}
