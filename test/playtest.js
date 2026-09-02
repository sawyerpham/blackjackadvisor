#!/usr/bin/env node
// The gate for playing advice. MUST print PASS. Run after re-copying the
// engine from upstream.
//
//   1. Off the top of a full 8-deck S17 shoe, composition-dependent play must
//      reproduce the published chart exactly — no count justifies a deviation.
//   2. Its dealer model must agree with dealer.js. Two independent
//      implementations landing on one number beats either agreeing with itself.

import { evaluate, availableActions, freshShoe, rankIndex } from '../vendor/blackjack-engine.ts';
import { rulesForUpcard, rulesForSplit, rulesForPosition } from '../src/engine/play.js';
import { dealerOutcomes, evStand } from '../src/engine/dealer.js';
import config from '../src/config.js';

const RULES = { ...config.rules, decks: 8 };
const RANKS13 = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

function decide(player, up) {
  const shoe = freshShoe(8);
  for (const r of [...player, up]) shoe[rankIndex(r)] -= 1;
  return evaluate(player, up, shoe, RULES);
}

// Published 8-deck S17 basic strategy for the rules in config.js. The pair
// lines are the ones that depend on those rules — re-check them if they change.
const CHART = [
  [['T', '6'], 'T', 'hit', '16 v 10'],
  [['T', '6'], '7', 'hit', '16 v 7'],
  [['T', '6'], '2', 'stand', '16 v 2'],
  [['T', '2'], '3', 'hit', '12 v 3'],
  [['T', '2'], '4', 'stand', '12 v 4'],
  [['T', '3'], '2', 'stand', '13 v 2'],
  [['9', '2'], 'A', 'hit', '11 v A (S17)'],
  [['9', '2'], 'T', 'double', '11 v 10'],
  [['5', '4'], '2', 'hit', '9 v 2'],
  [['5', '4'], '3', 'double', '9 v 3'],
  [['A', '7'], '2', 'stand', 'soft 18 v 2 (S17)'],
  [['A', '7'], '3', 'double', 'soft 18 v 3'],
  [['A', '7'], '8', 'stand', 'soft 18 v 8'],
  [['A', '7'], '9', 'hit', 'soft 18 v 9'],
  [['A', '2'], '5', 'double', 'soft 13 v 5'],
  [['8', '8'], 'T', 'split', '8,8 v 10'],
  [['8', '8'], 'A', 'split', '8,8 v A'],
  [['A', 'A'], 'T', 'split', 'A,A v 10'],
  [['T', 'T'], '6', 'stand', '10,10 v 6'],
  [['9', '9'], '7', 'stand', '9,9 v 7'],
  [['9', '9'], '9', 'split', '9,9 v 9'],
  [['5', '5'], '5', 'double', '5,5 v 5 (never split)'],
  [['7', '7'], 'T', 'hit', '7,7 v 10'],

  // These three split under DAS and do NOT here: the canary for someone
  // flipping doubleAfterSplit without meaning to.
  [['4', '4'], '5', 'hit', '4,4 v 5 (no DAS)'],
  [['2', '2'], '2', 'hit', '2,2 v 2 (no DAS)'],
  [['6', '6'], '2', 'hit', '6,6 v 2 (no DAS)'],
  [['2', '2'], '5', 'split', '2,2 v 5 (splits even without DAS)'],
  [['6', '6'], '4', 'split', '6,6 v 4 (splits even without DAS)'],

  // Equal VALUE, not equal rank, so a mixed ten pair is a legal split. It must
  // be priced as one and then rejected on merit — a different thing from not
  // being offered.
  [['K', 'Q'], '6', 'stand', 'K,Q v 6 (value-split offered, declined)'],
];

// 13 ranks vs the engine's 10 buckets: T/J/Q/K collapse to '10'.
const toEngine = (r) => (['T', 'J', 'Q', 'K'].includes(r) ? '10' : r);

let failures = 0;

console.log('=== playing strategy vs published 8-deck S17 chart ===\n');
for (const [player, up, want, name] of CHART) {
  const got = decide(player.map(toEngine), toEngine(up)).best;
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(24)} -> ${got.padEnd(9)} want ${want}`);
}

console.log('\n=== dealer model vs dealer.js (itself verified by dealertest.js) ===\n');
let worst = 0;
for (const up of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'A']) {
  const shoe = freshShoe(8);
  for (const r of ['10', '6', toEngine(up)]) shoe[rankIndex(r)] -= 1;

  const remaining = {};
  for (const r of RANKS13) remaining[r] = 32;
  remaining['T'] -= 1;
  remaining['6'] -= 1;
  remaining[up] -= 1;

  // Hard 16 standing: all the value is in the dealer distribution, so a
  // disagreement between the two engines shows up undiluted.
  const mine = evStand(dealerOutcomes(remaining, [up]), 16);
  const theirs = decide(['10', '6'], toEngine(up)).ev.stand;
  const diff = Math.abs(mine - theirs);
  if (diff > worst) worst = diff;
  console.log(`  ${up.padEnd(3)} dealer.js ${mine.toFixed(6)}   engine ${theirs.toFixed(6)}   diff ${diff.toExponential(1)}`);
}

console.log('\n=== split aces ===\n');

// Aces split once and never again, each half taking one card.
//
// availableActions() gates a split on the count alone and never reads
// allowResplitAces, so at maxSplits 1 the count is what blocks it. Raise
// maxSplits without fixing that upstream and ace resplits reappear silently —
// which is why the third check pins the config value, not the flag.
const aceCheck = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

aceCheck('an ace pair can be split', availableActions(['A', 'A'], RULES, 0).includes('split'));
aceCheck('and never re-split', !availableActions(['A', 'A'], RULES, 1).includes('split'));
aceCheck('...which relies on maxSplits being 1, not on allowResplitAces',
  RULES.maxSplits === 1 && RULES.allowResplitAces === false);

const oneCard = decide(['A', 'A'], '6').ev.split;
const freeDraw = evaluate(['A', 'A'], '6', (() => {
  const s = freshShoe(8);
  for (const r of ['A', 'A', '6']) s[rankIndex(r)] -= 1;
  return s;
})(), { ...RULES, allowDrawAfterSplitAces: true }).ev.split;
aceCheck('split aces take exactly one card, and it is priced',
  Math.abs(oneCard - freeDraw) > 0.05,
  `one card ${oneCard.toFixed(4)} vs free draw ${freeDraw.toFixed(4)}`);

console.log('\n=== peek on the ace, not on the ten ===\n');

// The chart above is a peek game and the engine is checked against it with
// peeking on. This table checks the hole card on an ace and not on a ten, so
// play.js narrows the engine's single flag per upcard. These pin that narrowing
// and the three decisions it moves.
//
// Confirmed in the captures: 17 dealer naturals on a ten upcard, two with a
// player double settled Lost beside the main bet.
const peekCheck = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

peekCheck('the ace upcard peeks', rulesForUpcard(RULES, 'A').dealerPeeks === true);
peekCheck('the ten upcard does not', rulesForUpcard(RULES, '10').dealerPeeks === false);
peekCheck('and every other upcard is unaffected either way',
  ['2', '5', '9'].every((u) => {
    const s = freshShoe(8);
    for (const r of ['10', '6', u]) s[rankIndex(r)] -= 1;
    const on = evaluate(['10', '6'], u, s, { ...RULES, dealerPeeks: true }, 0);
    const off = evaluate(['10', '6'], u, s, { ...RULES, dealerPeeks: false }, 0);
    return on.best === off.best;
  }));

// Against an unchecked ten the extra stake is live, which takes double and
// split off exactly these three hands.
const asPlayed = (cards, up) => {
  const s = freshShoe(8);
  for (const r of [...cards, up]) s[rankIndex(r)] -= 1;
  return evaluate(cards, up, s, rulesForUpcard(RULES, up), 0);
};
for (const [cards, up, want, label] of [
  [['9', '2'], '10', 'hit', '11 v 10 hits, it does not double'],
  [['8', '8'], '10', 'hit', '8,8 v 10 hits, it does not split'],
  [['A', 'A'], '10', 'split', 'A,A v 10 still splits, but for less'],
  [['8', '8'], 'A', 'split', '8,8 v A still splits — the ace IS checked'],
  [['A', 'A'], 'A', 'split', 'and so does A,A v A'],
]) {
  const got = asPlayed(cards, up);
  peekCheck(label, got.best === want, `${got.best} ${(got.ev[got.best] ?? 0).toFixed(4)}`);
}

// ---- no double after split ------------------------------------------------
// The engine gates `double` on allowDoubleDown alone and never reads
// doubleAfterSplit, so a post-split hand handed straight to evaluate() was
// offered a double this table does not allow — seen live as a split 11 advised
// DOUBLE. rulesForSplit() narrows the flag in play.js, because vendor/ must stay
// identical to upstream. The engine is RIGHT inside evSplit, so the decision to
// split was never wrong; only the advice on the hand you were left holding.
console.log('');
console.log('=== no double after split ===');
console.log('');

peekCheck('an unsplit hand is left exactly as it was',
  JSON.stringify(rulesForPosition(RULES, '6', 0)) === JSON.stringify(rulesForUpcard(RULES, '6')));
peekCheck('a post-split hand loses the double', rulesForPosition(RULES, '6', 1).allowDoubleDown === false);
peekCheck('a DAS table keeps it — the rule drives this, not the split count',
  rulesForSplit({ ...RULES, doubleAfterSplit: true }, 1).allowDoubleDown === true);
peekCheck('the upcard peek narrowing still composes',
  rulesForPosition(RULES, 'A', 1).dealerPeeks === true &&
  rulesForPosition(RULES, '10', 1).dealerPeeks === false);

// The reported hand, plus the rest of the range double would have taken. Each
// must lose the action outright, not merely rank it lower.
for (const [cards, up, want, label] of [
  [['2', '9'], '6', 'hit',   'post-split 11 v 6 hits, it does not double'],
  [['2', '9'], '9', 'hit',   'post-split 11 v 9 hits'],
  [['2', '8'], '6', 'hit',   'post-split 10 v 6 hits'],
  [['2', '7'], '4', 'hit',   'post-split 9 v 4 hits'],
  [['A', '7'], '5', 'stand', 'post-split soft 18 v 5 stands'],
  [['A', '2'], '6', 'hit',   'post-split soft 13 v 6 hits'],
]) {
  const shoe = freshShoe(8);
  for (const r of [...cards, up]) shoe[rankIndex(r)] -= 1;
  const got = evaluate(cards, up, shoe, rulesForPosition(RULES, up, 1), 1);
  peekCheck(label, got.best === want && !('double' in got.ev),
    `${got.best} ${(got.ev[got.best] ?? 0).toFixed(4)}${'double' in got.ev ? ' — DOUBLE STILL OFFERED' : ''}`);
  // The same cards unsplit must be unaffected, or the narrowing leaked.
  const un = evaluate(cards, up, shoe, rulesForPosition(RULES, up, 0), 0);
  const ref = evaluate(cards, up, shoe, rulesForUpcard(RULES, up), 0);
  peekCheck(`  ...and unsplit ${cards.join('+')} v ${up} is untouched`, un.best === ref.best, ref.best);
}

peekCheck('availableActions agrees with the narrowed rules',
  !availableActions(['2', '9'], rulesForPosition(RULES, '6', 1), 1).includes('double'));

// Summation order differs between the two, so 1e-9 is noise. Anything larger is
// a real disagreement about the game.
const TOL = 1e-9;
if (worst > TOL) failures += 1;

console.log(`\nworst dealer disagreement: ${worst.toExponential(2)} (tolerance ${TOL.toExponential(0)})`);

if (failures) {
  console.log(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS — playing advice matches published basic strategy and dealer.js.');
