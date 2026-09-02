// Player advantage from exact remaining-shoe composition. Every rank carries
// its own effect of removal; Hi-Lo compresses 13 ranks into three tags for
// humans, and is kept here only as a displayed sanity readout.
//
//   advantage(remaining) = BASE + (52 / cardsLeft) * SUM_i removed_i * c_i
//
// The 52/cardsLeft factor is what makes it a *true* count. evtest.js regresses
// the model against Hi-Lo: slope ~0.5% per true count, intercept at the
// off-the-top edge.

import { RANKS } from '../feed/tracker.js';

// 8D, S17, no DAS, one split, 3:2, no surrender, no peek on a ten. Enumerated
// against the engine over every opening deal, not estimated.
export const BASE_ADVANTAGE = -0.007075;

// Griffin shape. Removing a low card leaves the shoe ten-rich, hence positive
// for 2-6. Scale is set by CALIBRATION below.
export const EOR_SHAPE = {
  A: -0.61,
  2: +0.38,
  3: +0.44,
  4: +0.55,
  5: +0.69,
  6: +0.46,
  7: +0.28,
  8: -0.02,
  9: -0.18,
  T: -0.51,
  J: -0.51,
  Q: -0.51,
  K: -0.51,
};

export const HILO_TAG = {
  A: -1, 2: +1, 3: +1, 4: +1, 5: +1, 6: +1, 7: 0, 8: 0, 9: 0,
  T: -1, J: -1, Q: -1, K: -1,
};

// Advantage per +1 true count, multi-deck. The model is anchored to this.
export const ADV_PER_TRUE_COUNT = 0.005;

// Centre the shape so it sums to zero. Published tables don't (this one sums to
// -0.05), and an unbalanced set drifts with depth on a balanced shoe. Skipping
// this put the regression intercept at -0.725% instead of -0.500%.
const EOR_CENTERED = (() => {
  const mean = RANKS.reduce((a, r) => a + EOR_SHAPE[r], 0) / RANKS.length;
  return Object.fromEntries(RANKS.map((r) => [r, EOR_SHAPE[r] - mean]));
})();

// Scale so one Hi-Lo unit produces ADV_PER_TRUE_COUNT, anchored on the mean
// |EoR| across the ranks Hi-Lo tags.
const CALIBRATION = (() => {
  const plus = RANKS.filter((r) => HILO_TAG[r] > 0);
  const minus = RANKS.filter((r) => HILO_TAG[r] < 0);
  const mean = (rs) => rs.reduce((a, r) => a + Math.abs(EOR_CENTERED[r]), 0) / rs.length;
  return ADV_PER_TRUE_COUNT / ((mean(plus) + mean(minus)) / 2);
})();

// Advantage change per card removed, per deck remaining.
export const EOR = Object.fromEntries(
  RANKS.map((r) => [r, EOR_CENTERED[r] * CALIBRATION])
);

export const cardsPerRank = (decks) => decks * 4;
export const shoeSize = (decks) => decks * 52;

export function cardsLeft(remaining) {
  let n = 0;
  for (const r of RANKS) n += remaining[r] || 0;
  return n;
}

export function runningCount(remaining, decks) {
  const full = cardsPerRank(decks);
  let rc = 0;
  for (const r of RANKS) rc += HILO_TAG[r] * (full - (remaining[r] || 0));
  return rc;
}

// Undefined below a quarter deck — the divisor explodes.
export function trueCount(remaining, decks) {
  const n = cardsLeft(remaining);
  if (n < 13) return 0;
  return runningCount(remaining, decks) / (n / 52);
}

// A fraction: 0.0062 = +0.62%.
export function advantage(remaining, decks) {
  const n = cardsLeft(remaining);
  if (n < 13) return BASE_ADVANTAGE;      // too thin to say anything useful
  const full = cardsPerRank(decks);
  let sum = 0;
  for (const r of RANKS) {
    const removed = full - (remaining[r] || 0);
    sum += removed * EOR[r];
  }
  return BASE_ADVANTAGE + (52 / n) * sum;
}

// How rich or poor each rank is versus a full shoe, for the UI heat map.
export function rankSkew(remaining, decks) {
  const n = cardsLeft(remaining);
  const full = cardsPerRank(decks);
  const expectedFraction = n / shoeSize(decks);
  const out = {};
  for (const r of RANKS) {
    const have = remaining[r] || 0;
    const expected = full * expectedFraction;
    out[r] = expected > 0 ? (have - expected) / expected : 0;
  }
  return out;
}

