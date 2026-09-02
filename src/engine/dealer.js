// P(dealer finishes 17..21 | bust), recursing over draws WITHOUT replacement —
// which is what a fixed probability table cannot do.
//
// T/J/Q/K are interchangeable here, so the recursion works in VALUE space
// (A, 2..9, 10): branching factor 10 instead of 13, the difference between
// finishing instantly and not finishing.

import { RANKS } from '../feed/tracker.js';

// If the table hits soft 17, flipping this moves insurance and playing edges.
export const HIT_SOFT_17 = false;

export const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const TEN_RANKS = ['T', 'J', 'Q', 'K'];

export const rankValue = (r) => (r === 'A' ? 11 : TEN_RANKS.includes(r) ? 10 : Number(r));

export function valuePool(remaining) {
  const pool = {};
  for (const v of VALUES) pool[v] = 0;
  for (const r of RANKS) {
    const n = remaining[r] || 0;
    if (TEN_RANKS.includes(r)) pool['10'] += n;
    else pool[r] += n;
  }
  return pool;
}

export function handTotal(values) {
  let total = 0;
  let aces = 0;
  for (const v of values) {
    if (v === 'A') { total += 11; aces += 1; } else total += Number(v);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return { total, soft: aces > 0 };
}

const OUTCOMES = [17, 18, 19, 20, 21, 'bust'];
const zero = () => ({ 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0 });

// `dealerCards` are the ranks showing, e.g. ['A'] or ['T','6'].
export function dealerOutcomes(remaining, dealerCards) {
  const pool = valuePool(remaining);
  let left = 0;
  for (const v of VALUES) left += pool[v];
  if (left <= 0) return zero();

  const start = dealerCards.map((r) => (TEN_RANKS.includes(r) ? '10' : r));
  const memo = new Map();

  function recurse(hand, poolLeft) {
    const { total, soft } = handTotal(hand);
    if (total > 21) return { ...zero(), bust: 1 };
    if (total >= 18 || (total === 17 && !(HIT_SOFT_17 && soft))) {
      const out = zero();
      out[total] = 1;
      return out;
    }
    // Total, softness and the pool fully determine the future, and the pool is
    // captured by its own counts — so draw ORDER never matters.
    const key = `${total}${soft ? 's' : 'h'}|${VALUES.map((v) => pool[v]).join(',')}`;
    const hit = memo.get(key);
    if (hit) return hit;

    const acc = zero();
    for (const v of VALUES) {
      const n = pool[v];
      if (n <= 0) continue;
      const p = n / poolLeft;
      pool[v] = n - 1;
      const sub = recurse([...hand, v], poolLeft - 1);
      pool[v] = n;
      for (const k of OUTCOMES) acc[k] += p * sub[k];
    }
    memo.set(key, acc);
    return acc;
  }

  return recurse(start, left);
}

// Purely the ten-density of the remainder. Pays 2:1, so it turns profitable
// once more than a third of the unseen cards are tens.
export function insuranceEdge(remaining) {
  let left = 0;
  for (const r of RANKS) left += remaining[r] || 0;
  if (left <= 0) return { pTen: 0, edge: -1, take: false, breakEven: 1 / 3 };
  const tens = TEN_RANKS.reduce((a, r) => a + (remaining[r] || 0), 0);
  const pTen = tens / left;
  const edge = pTen * 2 - (1 - pTen);   // win 2 with prob pTen, lose 1 otherwise
  return { pTen, edge, take: edge > 0, breakEven: 1 / 3 };
}

export function evStand(outcomes, total) {
  if (total > 21) return -1;
  let win = outcomes.bust;
  let lose = 0;
  for (const t of [17, 18, 19, 20, 21]) {
    if (t < total) win += outcomes[t];
    else if (t > total) lose += outcomes[t];
  }
  return win - lose;
}
