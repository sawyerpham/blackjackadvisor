#!/usr/bin/env node
// The advantage model. Run: node test/evtest.js
//
// Asserts the published relationship: advantage rises ~0.5% per Hi-Lo true count
// from this table's off-the-top edge of ~-0.71%. Wrong coefficients or wrong
// depth normalization break the regression immediately.

import { RANKS } from '../src/feed/tracker.js';
import {
  advantage, trueCount, cardsLeft, cardsPerRank,
  BASE_ADVANTAGE, ADV_PER_TRUE_COUNT, EOR, HILO_TAG,
} from '../src/engine/ev.js';
import { betUnitsFor } from '../src/advice/advisor.js';
import config from '../src/config.js';

const DECKS = 8;
const full = () => Object.fromEntries(RANKS.map((r) => [r, cardsPerRank(DECKS)]));
const pct = (x) => `${(x * 100).toFixed(3)}%`;

let failures = 0;
function check(label, got, want, tol) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${pct(got).padStart(9)}` +
    `  (want ${pct(want)} ±${pct(tol)})`
  );
}

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

console.log('\n=== advantage model acceptance tests ===\n');

// --- 1. off the top --------------------------------------------------------
console.log('Full 8-deck shoe');
check('advantage off the top', advantage(full(), DECKS), BASE_ADVANTAGE, 0.0001);
check('true count off the top', trueCount(full(), DECKS), 0, 0.0001);

// --- 2. the Hi-Lo relationship ---------------------------------------------
// Slope must be ADV_PER_TRUE_COUNT, intercept BASE_ADVANTAGE.
console.log('\nRegression of advantage on Hi-Lo true count (random compositions)');
const xs = [];
const ys = [];
for (let trial = 0; trial < 4000; trial += 1) {
  const rem = full();
  const target = 60 + Math.floor(rnd() * 260);   // deal 60..320 cards
  for (let i = 0; i < target; i += 1) {
    // pick a rank still present, weighted by how many are left
    const n = cardsLeft(rem);
    let pick = Math.floor(rnd() * n);
    for (const r of RANKS) {
      pick -= rem[r];
      if (pick < 0) { rem[r] -= 1; break; }
    }
  }
  if (cardsLeft(rem) < 26) continue;
  xs.push(trueCount(rem, DECKS));
  ys.push(advantage(rem, DECKS));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const mx = mean(xs), my = mean(ys);
let num = 0, den = 0;
for (let i = 0; i < xs.length; i += 1) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
const slope = num / den;
const intercept = my - slope * mx;
let ssTot = 0, ssRes = 0;
for (let i = 0; i < xs.length; i += 1) {
  ssTot += (ys[i] - my) ** 2;
  ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
}
const r2 = 1 - ssRes / ssTot;

console.log(`  samples: ${xs.length}   R² = ${r2.toFixed(4)}`);
check('slope per true count', slope, ADV_PER_TRUE_COUNT, 0.0006);
check('intercept', intercept, BASE_ADVANTAGE, 0.0006);
if (r2 < 0.90) {
  failures += 1;
  console.log(`  FAIL correlation with Hi-Lo too low (R²=${r2.toFixed(3)}, want >0.90)`);
} else {
  console.log(`  ok   correlation with Hi-Lo is high but imperfect, as expected`);
}

// --- 3. direction and monotonicity -----------------------------------------
console.log('\nDirection checks');
const richInTens = full();
for (const r of ['2', '3', '4', '5', '6']) richInTens[r] -= 20;  // low cards gone
const poorInTens = full();
for (const r of ['T', 'J', 'Q', 'K']) poorInTens[r] -= 20;       // tens gone
const advRich = advantage(richInTens, DECKS);
const advPoor = advantage(poorInTens, DECKS);
console.log(`  ${advRich > 0 ? 'ok  ' : 'FAIL'} removing 100 low cards is player-favourable   ${pct(advRich)}`);
console.log(`  ${advPoor < BASE_ADVANTAGE ? 'ok  ' : 'FAIL'} removing 80 tens is player-hostile            ${pct(advPoor)}`);
if (advRich <= 0) failures += 1;
if (advPoor >= BASE_ADVANTAGE) failures += 1;

// deeper shoe, same imbalance => stronger signal
const shallow = full();
const deep = full();
for (const r of ['2', '3', '4', '5', '6']) { shallow[r] -= 10; deep[r] -= 10; }
for (const r of RANKS) deep[r] -= 8;    // burn depth off every rank, evenly
const advShallow = advantage(shallow, DECKS);
const advDeep = advantage(deep, DECKS);
const deeper = advDeep > advShallow;
if (!deeper) failures += 1;
console.log(`  ${deeper ? 'ok  ' : 'FAIL'} same imbalance counts for more when deeper   ` +
  `${pct(advShallow)} -> ${pct(advDeep)}`);

// --- 4. EoR internal consistency -------------------------------------------
console.log('\nEffect-of-removal table');
const signOk = RANKS.every((r) => (HILO_TAG[r] === 0) || Math.sign(EOR[r]) === Math.sign(HILO_TAG[r]));
if (!signOk) failures += 1;
console.log(`  ${signOk ? 'ok  ' : 'FAIL'} EoR signs agree with Hi-Lo tags where tagged`);
console.log('       ' + RANKS.map((r) => `${r}:${(EOR[r] * 100).toFixed(2)}`).join(' '));

// --- 5. bet ramp -----------------------------------------------------------
// Units, not money: one unit is the table minimum.
console.log('\nBet ramp (units of the table minimum)');
const ramp = [
  [-0.01, 0], [0, 0], [0.005, 2], [0.01, 4], [0.015, 6], [0.02, 8], [0.03, 12], [0.10, 12],
];
let rampOk = true;
for (const [adv, want] of ramp) {
  const got = betUnitsFor(adv, config);
  if (got !== want) { rampOk = false; failures += 1; }
  console.log(`  ${got === want ? 'ok  ' : 'FAIL'} edge ${pct(adv).padStart(8)} -> ${got}u  (want ${want}u)`);
}
// Always a whole number of units, so always buildable from the chip ladder.
const wholeUnits = [0.004, 0.0071, 0.0123, 0.0199].every((a) => Number.isInteger(betUnitsFor(a, config)));
if (!wholeUnits) failures += 1;
console.log(`  ${wholeUnits ? 'ok  ' : 'FAIL'} every bet is a whole number of units`);
if (rampOk) console.log(`  ok   ramp is capped at ${config.betCap}u`);

console.log(failures === 0 ? '\nPASS — advantage model matches known benchmarks.\n'
                           : `\nFAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
