// Exact EV of Twin Shot (pair) and Three Up (21+3). Advisory only, and not
// wired into the dashboard.
//
// Normally uncountable: both are decided by suit-and-rank structure, and a
// running count says nothing about suits. But codeCounts tracks all 52 exact
// card codes, so the true EV of the next hand can be enumerated over every 2-
// and 3-card combination the shoe can still produce.
//
// PAYTABLE derived from settled results in the captures, not assumed.

export const SUITS = ['S', 'H', 'D', 'C'];
export const RED = new Set(['H', 'D']);
// Ace is deliberately at BOTH ends: A-K-Q and A-2-3 are both straights under
// the poker ranking these bets use.
export const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

export const PAY_PAIR = {
  PerfectPair: 25,     // identical rank and suit
  ColoredPair: 12,     // same rank, same colour, different suit
  MixedPair: 6,        // same rank, different colour
};

export const PAY_213 = {
  SuitedTrips: 100,
  StraightFlush: 40,
  ThreeOfAKind: 30,
  Straight: 10,
  Flush: 5,
};

export const CODES = (() => {
  const out = [];
  for (const r of RANK_ORDER) for (const s of SUITS) out.push(r + s);
  return out;
})();

const rankOf = (code) => code.slice(0, -1);
const suitOf = (code) => code.slice(-1);

// One copy of each code per deck, so `decks` copies of e.g. "TH".
export function remainingCodes(shoe, decks) {
  const out = {};
  for (const c of CODES) out[c] = decks - (shoe.codeCounts[c] || 0);
  return out;
}

const choose2 = (n) => (n * (n - 1)) / 2;
const choose3 = (n) => (n * (n - 1) * (n - 2)) / 6;

// ---------------------------------------------------------------- pair ----

// Twin Shot: the player's own two initial cards.
export function pairEV(remaining) {
  let total = 0;
  const counts = CODES.map((c) => remaining[c] || 0);
  for (let i = 0; i < 52; i++) total += counts[i];
  if (total < 2) return { ev: -1, total: 0, p: {} };

  const ways = choose2(total);
  const hit = { PerfectPair: 0, ColoredPair: 0, MixedPair: 0 };

  for (let i = 0; i < 52; i++) {
    if (!counts[i]) continue;
    // Two copies of the exact same card: only possible in a multi-deck shoe,
    // and the whole reason Perfect Pair pays what it does.
    hit.PerfectPair += choose2(counts[i]);

    for (let j = i + 1; j < 52; j++) {
      if (!counts[j]) continue;
      if (rankOf(CODES[i]) !== rankOf(CODES[j])) continue;
      const sameColour = RED.has(suitOf(CODES[i])) === RED.has(suitOf(CODES[j]));
      const n = counts[i] * counts[j];
      if (sameColour) hit.ColoredPair += n;
      else hit.MixedPair += n;
    }
  }

  let ev = 0;
  const p = {};
  let win = 0;
  for (const k of Object.keys(hit)) {
    p[k] = hit[k] / ways;
    win += p[k];
    ev += p[k] * PAY_PAIR[k];
  }
  ev -= (1 - win);          // the stake is lost on everything else
  return { ev, total, p };
}

// ----------------------------------------------------------------- 21+3 ----

// Three consecutive ranks, in any order, ace high or low.
function isStraight(r1, r2, r3) {
  const idx = [r1, r2, r3].map((r) => RANK_ORDER.indexOf(r)).sort((a, b) => a - b);
  if (idx[0] === idx[1] || idx[1] === idx[2]) return false;
  if (idx[1] === idx[0] + 1 && idx[2] === idx[1] + 1) return true;
  // Ace high: A(0) with Q(11) and K(12).
  return idx[0] === 0 && idx[1] === 11 && idx[2] === 12;
}

function classify213(c1, c2, c3) {
  const r = [rankOf(c1), rankOf(c2), rankOf(c3)];
  const s = [suitOf(c1), suitOf(c2), suitOf(c3)];
  const flush = s[0] === s[1] && s[1] === s[2];
  const trips = r[0] === r[1] && r[1] === r[2];

  if (trips) return flush ? 'SuitedTrips' : 'ThreeOfAKind';
  if (isStraight(r[0], r[1], r[2])) return flush ? 'StraightFlush' : 'Straight';
  if (flush) return 'Flush';
  return null;
}

// Three Up: two initial cards plus the dealer's upcard, over every unordered
// 3-card combination left (~24k).
export function threeUpEV(remaining) {
  const counts = CODES.map((c) => remaining[c] || 0);
  let total = 0;
  for (const n of counts) total += n;
  if (total < 3) return { ev: -1, total: 0, p: {} };

  const ways = choose3(total);
  const hit = { SuitedTrips: 0, StraightFlush: 0, ThreeOfAKind: 0, Straight: 0, Flush: 0 };

  for (let i = 0; i < 52; i++) {
    if (!counts[i]) continue;
    for (let j = i; j < 52; j++) {
      if (!counts[j]) continue;
      for (let k = j; k < 52; k++) {
        if (!counts[k]) continue;
        const cls = classify213(CODES[i], CODES[j], CODES[k]);
        if (!cls) continue;

        // Multiplicity depends on how many of the three slots hold the same
        // code: drawing two "TH"s is C(n,2), not n^2.
        let n;
        if (i === j && j === k) n = choose3(counts[i]);
        else if (i === j) n = choose2(counts[i]) * counts[k];
        else if (j === k) n = counts[i] * choose2(counts[j]);
        else n = counts[i] * counts[j] * counts[k];
        hit[cls] += n;
      }
    }
  }

  let ev = 0, win = 0;
  const p = {};
  for (const key of Object.keys(hit)) {
    p[key] = hit[key] / ways;
    win += p[key];
    ev += p[key] * PAY_213[key];
  }
  ev -= (1 - win);
  return { ev, total, p };
}

export function sideBetEV(shoe, decks) {
  const remaining = remainingCodes(shoe, decks);
  return { pair: pairEV(remaining), threeUp: threeUpEV(remaining) };
}
