#!/usr/bin/env node
// The gate for sidebets.js. MUST print PASS.
//
// Pure combinatorics, so checked against closed form rather than simulation:
//
//   1. The 2-card classification partitions same-rank pairs exactly —
//      Perfect + Coloured + Mixed = C(32,2) x 13 on an 8-deck shoe. A
//      double-counted pair type fails here; the EV alone would go quietly wrong.
//   2. Off-the-top EV matches an independent hand calculation.
//
// The 3-card side uses the same partition in reverse: every classified
// combination reachable, probabilities summing under 1 with the losing mass
// making up the rest.

import { pairEV, threeUpEV, CODES, PAY_PAIR, PAY_213 } from '../src/engine/sidebets.js';

const DECKS = 8;
const fresh = {};
for (const c of CODES) fresh[c] = DECKS;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log('=== Twin Shot (pair) ===\n');
const p = pairEV(fresh);
const ways2 = (416 * 415) / 2;

// Closed form, derived without reference to sidebets.js.
const perfect = 52 * ((DECKS * (DECKS - 1)) / 2);      // same rank AND suit
const coloured = 13 * 2 * DECKS * DECKS;               // same rank+colour, diff suit
// 2*DECKS red of that rank times 2*DECKS black. NOT (all 32)^2/2, which counts
// same-colour pairs too.
const mixed = 13 * (2 * DECKS) * (2 * DECKS);
const sameRank = ((32 * 31) / 2) * 13;

check('pair types partition every same-rank pair',
  perfect + coloured + mixed === sameRank, `${perfect + coloured + mixed} = ${sameRank}`);
check('PerfectPair probability', Math.abs(p.p.PerfectPair - perfect / ways2) < 1e-12);
check('ColoredPair probability', Math.abs(p.p.ColoredPair - coloured / ways2) < 1e-12);
check('MixedPair probability', Math.abs(p.p.MixedPair - mixed / ways2) < 1e-12);

const evHand =
  (perfect * PAY_PAIR.PerfectPair + coloured * PAY_PAIR.ColoredPair + mixed * PAY_PAIR.MixedPair
   - (ways2 - sameRank)) / ways2;
check('EV matches independent hand calculation',
  Math.abs(p.ev - evHand) < 1e-12, `${(p.ev * 100).toFixed(4)}% vs ${(evHand * 100).toFixed(4)}%`);
check('house edge is the published 4.10%', Math.abs(-p.ev - 0.0410) < 0.0002,
  `${(-p.ev * 100).toFixed(2)}%`);

console.log('\n=== Three Up (21+3) ===\n');
const t = threeUpEV(fresh);
const totalP = Object.values(t.p).reduce((a, b) => a + b, 0);
check('winning probabilities sum below 1', totalP > 0 && totalP < 1, `${(totalP * 100).toFixed(3)}%`);
check('every payout category is reachable',
  Object.keys(PAY_213).every((k) => t.p[k] > 0));
check('rarer hands pay more than commoner ones',
  t.p.SuitedTrips < t.p.StraightFlush && t.p.StraightFlush < t.p.ThreeOfAKind &&
  t.p.ThreeOfAKind < t.p.Straight && t.p.Straight < t.p.Flush);

// Rebuilt from the reported probabilities, which catches a paytable applied to
// the wrong category: the probabilities can be right and the EV wrong.
const evFromP = Object.entries(t.p).reduce((a, [k, v]) => a + v * PAY_213[k], 0) - (1 - totalP);
check('EV is consistent with its own probabilities', Math.abs(t.ev - evFromP) < 1e-12);
check('house edge is the published 3.70%', Math.abs(-t.ev - 0.0370) < 0.0005,
  `${(-t.ev * 100).toFixed(2)}%`);

// A single-suit shoe makes every three cards a flush, so the losing mass must
// be zero — an unambiguous target, unlike "removing a suit lowers the flush
// chance", which is false.
const oneSuit = {};
for (const c of CODES) oneSuit[c] = c.endsWith('S') ? DECKS : 0;
const t2 = threeUpEV(oneSuit);
const win2 = Object.values(t2.p).reduce((a, b) => a + b, 0);
check('a single-suit shoe always makes a flush', Math.abs(win2 - 1) < 1e-12,
  `win probability ${(win2 * 100).toFixed(4)}%`);
check('and its EV is therefore positive', t2.ev > 0, `${(t2.ev * 100).toFixed(1)}%`);

// The direction that matters: it is why this bet drifts with the shoe at all.
const heavyS = {};
for (const c of CODES) heavyS[c] = c.endsWith('S') ? DECKS : 1;
check('a spade-heavy shoe raises the flush chance',
  threeUpEV(heavyS).p.Flush > t.p.Flush,
  `${(threeUpEV(heavyS).p.Flush * 100).toFixed(2)}% > ${(t.p.Flush * 100).toFixed(2)}%`);

if (failures) {
  console.log(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS — side-bet EV matches closed-form combinatorics.');
