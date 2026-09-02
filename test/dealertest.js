#!/usr/bin/env node
// The dealer engine against published 8-deck S17 outcome probabilities,
// blackjacks included. Run: node test/dealertest.js

import { RANKS } from '../src/feed/tracker.js';
import { dealerOutcomes, insuranceEdge, evStand, handTotal, valuePool } from '../src/engine/dealer.js';

const DECKS = 8;
const full = () => Object.fromEntries(RANKS.map((r) => [r, DECKS * 4]));
const pct = (x) => `${(100 * x).toFixed(2)}%`;

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`);
};

console.log('\n=== dealer engine acceptance tests ===\n');

// --- 1. bust rates vs published --------------------------------------------
// Ten-up differs by ~0.2pp: published tables often resolve the dealer's
// blackjack separately rather than counting it in the distribution.
const published = {
  2: 0.3536, 3: 0.3739, 4: 0.3945, 5: 0.4164, 6: 0.4232,
  7: 0.2623, 8: 0.2445, 9: 0.2284, T: 0.2141, A: 0.1153,
};
console.log('Dealer bust probability from a full 8-deck shoe');
console.log('  up     mine   published    diff');
let worst = 0;
for (const up of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'A']) {
  const o = dealerOutcomes(full(), [up]);
  const diff = Math.abs(o.bust - published[up]);
  worst = Math.max(worst, diff);
  console.log(`  ${up.padEnd(3)} ${pct(o.bust).padStart(8)} ${pct(published[up]).padStart(10)}` +
              `  ${(100 * diff).toFixed(2).padStart(6)}pp`);
}
ok(worst < 0.005, 'every upcard within 0.5pp of published', `worst ${(100 * worst).toFixed(2)}pp`);

// --- 2. distributions are distributions ------------------------------------
console.log('\nSanity');
let sumsOk = true;
for (const up of ['2', '6', 'T', 'A']) {
  const o = dealerOutcomes(full(), [up]);
  const s = o[17] + o[18] + o[19] + o[20] + o[21] + o.bust;
  if (Math.abs(s - 1) > 1e-9) sumsOk = false;
}
ok(sumsOk, 'outcome probabilities sum to 1');

// A dealer already standing has a degenerate distribution.
const stood = dealerOutcomes(full(), ['T', '9']);
ok(stood[19] === 1 && stood.bust === 0, 'a made 19 stays a 19');
const busted = dealerOutcomes(full(), ['T', '9', '5']);
ok(busted.bust === 1, 'a busted hand is 100% bust');

// --- 3. composition actually moves the answer ------------------------------
// The whole reason for the engine: strip the small cards and the dealer stops
// busting, because there is nothing safe left to draw.
console.log('\nComposition sensitivity (the point of doing this exactly)');
const noSmall = full();
for (const r of ['2', '3', '4', '5', '6']) noSmall[r] = 0;
const noTens = full();
for (const r of ['T', 'J', 'Q', 'K']) noTens[r] = 0;
const base = dealerOutcomes(full(), ['6']).bust;
const stripped = dealerOutcomes(noSmall, ['6']).bust;
const tenless = dealerOutcomes(noTens, ['6']).bust;
console.log(`  dealer 6, full shoe        bust ${pct(base)}`);
console.log(`  dealer 6, no low cards     bust ${pct(stripped)}`);
console.log(`  dealer 6, no tens          bust ${pct(tenless)}`);
ok(stripped > base, 'removing low cards raises dealer bust rate');
ok(tenless < base, 'removing tens lowers dealer bust rate');

// --- 4. insurance ----------------------------------------------------------
console.log('\nInsurance (pure ten-density; break-even at 1/3)');
const insFull = insuranceEdge(full());
ok(Math.abs(insFull.pTen - 4 / 13) < 1e-9, 'full shoe is 4/13 tens', pct(insFull.pTen));
ok(!insFull.take, 'insurance is declined off the top', `edge ${pct(insFull.edge)}`);

// Strip non-tens until tens exceed a third, and it must flip.
const tenRich = full();
for (const r of ['2', '3', '4', '5', '6', '7']) tenRich[r] = 4;
const insRich = insuranceEdge(tenRich);
ok(insRich.take && insRich.pTen > 1 / 3, 'insurance is taken when tens exceed 1/3',
   `${pct(insRich.pTen)} tens, edge ${pct(insRich.edge)}`);

// The break-even point itself.
const atEven = Object.fromEntries(RANKS.map((r) => [r, 0]));
for (const r of ['T', 'J', 'Q', 'K']) atEven[r] = 10;      // 40 tens
for (const r of ['2', '3', '4', '5', '6', '7', '8', '9']) atEven[r] = 10;  // 80 others
const insEven = insuranceEdge(atEven);
ok(Math.abs(insEven.edge) < 1e-9, 'edge is exactly 0 at one-third tens', pct(insEven.pTen));

// --- 5. stand EV -----------------------------------------------------------
console.log('\nStanding EV');
const vs6 = dealerOutcomes(full(), ['6']);
const ev20 = evStand(vs6, 20);
const ev16 = evStand(vs6, 16);
ok(ev20 > ev16, 'standing on 20 beats standing on 16 vs a 6', `${ev20.toFixed(3)} vs ${ev16.toFixed(3)}`);
ok(evStand(vs6, 22) === -1, 'a bust hand stands at -1');

// --- 6. hand totals --------------------------------------------------------
console.log('\nHand totals');
ok(handTotal(['A', '6']).total === 17 && handTotal(['A', '6']).soft, 'A+6 is soft 17');
ok(handTotal(['A', '6', '10']).total === 17 && !handTotal(['A', '6', '10']).soft, 'A+6+10 is hard 17');
ok(handTotal(['A', 'A']).total === 12, 'A+A is 12');
ok(valuePool(full())['10'] === 128, 'T/J/Q/K collapse into 128 tens');

console.log(failures === 0
  ? '\nPASS — dealer engine matches published probabilities.\n'
  : `\nFAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
