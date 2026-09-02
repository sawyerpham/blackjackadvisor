// Hit, stand, double or split for the hand you were dealt. Adapter between the
// vendored engine (10 rank buckets, a Rules object) and this app (13 ranks, a
// live tracker), plus the cache and worker that make it usable inside a
// 15-second decision window.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- ranks ----

// The engine buckets ten-value cards; the tracker keeps T/J/Q/K apart.
// Collapsing happens here and nowhere else.
const TEN = ['T', 'J', 'Q', 'K'];
const ENGINE_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

export function toEngineShoe(remaining) {
  const shoe = ENGINE_RANKS.map((r) => remaining[r] || 0);
  shoe[9] = TEN.reduce((n, r) => n + (remaining[r] || 0), 0);
  return shoe;
}

export const toEngineRank = (rank) => (TEN.includes(rank) ? '10' : rank);

// This table peeks on an ACE and NOT on a TEN, and the engine takes one boolean
// for both. The engine picks the hole rank off the upcard itself, so false
// against a ten leaves the dealer natural in the distribution — which is what
// doubling into an unchecked ten actually costs. Inert on any other upcard.
export const rulesForUpcard = (rules, engineUp) =>
  ({ ...rules, dealerPeeks: rules.dealerPeeks && engineUp === 'A' });

// No double after split, expressed in the flag the engine actually reads.
//
// It gates `double` on `isTwoCard && allowDoubleDown && isDoubleAllowed(...)`
// and never consults `doubleAfterSplit`, though `splitsAlreadyTaken` is already
// a parameter. It DOES honour the rule inside evSplit, so only a post-split hand
// handed straight to evaluate() is affected — which is where it was caught: a
// split 11 advised to DOUBLE at a table that does not allow it.
//
// Fixed here rather than in vendor/, for the reason that folder exists: the
// local copy must stay byte-identical to upstream.
export const rulesForSplit = (rules, splitsTaken) =>
  (splitsTaken > 0 && !rules.doubleAfterSplit ? { ...rules, allowDoubleDown: false } : rules);

// Both narrowings, in the one place every engine call goes through.
export const rulesForPosition = (rules, engineUp, splitsTaken) =>
  rulesForSplit(rulesForUpcard(rules, engineUp), splitsTaken);

// -------------------------------------------------------------- worker ----

// A pair split against a low upcard measures 4-5s on an 8-deck shoe: fits the
// table's 15s window, not the dashboard's 250ms refresh.
let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(HERE, 'play-worker.js'));
  worker.on('message', (msg) => {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg.error ? null : msg.result);
  });
  worker.on('error', () => {
    // A dead worker must not take the advisor with it.
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    worker = null;
  });
  worker.unref();  // never hold the process open on its account
  return worker;
}

function evaluateOffThread(player, dealerUp, shoe, rules, splitsTaken) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ensureWorker().postMessage({ id, player, dealerUp, shoe, rules, splitsTaken });
  });
}

// --------------------------------------------------------------- cache ----

// Keyed on everything the answer depends on, so no entry can go stale.
const cache = new Map();
const CACHE_MAX = 400;
// A SET of keys, not one slot. One slot was right while the felt asked about a
// single hand at a time; asking for every seat at once, each frame, it held only
// the last of them, so the other six looked idle and were re-posted on the very
// next frame — seven positions a frame instead of seven per shoe change.
const inFlight = new Set();
// Backstop for a caller that does not stop. The felt asks for at most seven
// seats plus your own hand, and only when a key is genuinely new.
const PLAY_QUEUE_MAX = 24;

const keyOf = (player, up, shoe, splitsTaken) =>
  `${player.join(',')}|${up}|${shoe.join(',')}|${splitsTaken}`;

// Synchronous: returns what is cached and starts the rest, reporting `thinking`
// meanwhile — never the previous hand's action.
export function playAdvice({ cards, dealerUpcard, remaining, rules, splitsTaken = 0 }) {
  if (!cards || cards.length < 2 || !dealerUpcard) return null;

  const player = cards.map(toEngineRank);
  const up = toEngineRank(dealerUpcard);
  const shoe = toEngineShoe(remaining);
  const key = keyOf(player, up, shoe, splitsTaken);

  const hit = cache.get(key);
  if (hit) return hit;

  if (!inFlight.has(key) && inFlight.size < PLAY_QUEUE_MAX) {
    inFlight.add(key);
    evaluateOffThread(player, up, shoe, rulesForPosition(rules, up, splitsTaken), splitsTaken).then((result) => {
      inFlight.delete(key);
      if (!result) return;
      remember(key, result);
    });
  }
  return { action: null, ev: {}, isBlackjack: false, margin: 0, thinking: true };
}

function remember(key, result) {
  if (cache.size >= CACHE_MAX) cache.clear();
  const entry = {
    action: result.best,
    ev: result.ev,
    isBlackjack: result.isBlackjack,
    // How much the best action beats the runner-up. Near zero = doesn't matter.
    margin: marginOf(result.ev, result.best),
    thinking: false,
  };
  cache.set(key, entry);
  return entry;
}

// -------------------------------------------------------------- grading ----

// Grading has no clock, so it gets a promise where playAdvice returns at once.
// Only runs while you are out of the hand, so one worker is enough; the cap is a
// backstop against an unbounded queue.
const GRADE_QUEUE_MAX = 60;
let queued = 0;

// Full EV of every legal action, or null if it cannot or should not be run.
export function evaluatePosition({ cards, dealerUpcard, remaining, rules, splitsTaken = 0 }) {
  if (!cards || cards.length < 2 || !dealerUpcard) return Promise.resolve(null);

  const player = cards.map(toEngineRank);
  const up = toEngineRank(dealerUpcard);
  const shoe = toEngineShoe(remaining);
  const key = keyOf(player, up, shoe, splitsTaken);

  const hit = cache.get(key);
  if (hit) return Promise.resolve({ best: hit.action, ev: hit.ev, isBlackjack: hit.isBlackjack });

  if (queued >= GRADE_QUEUE_MAX) return Promise.resolve(null);
  queued += 1;
  return evaluateOffThread(player, up, shoe, rulesForPosition(rules, up, splitsTaken), splitsTaken).then((result) => {
    queued -= 1;
    if (!result) return null;
    remember(key, result);
    return { best: result.best, ev: result.ev, isBlackjack: result.isBlackjack };
  });
}

export const gradeQueueDepth = () => queued;

function marginOf(ev, best) {
  const values = Object.entries(ev).filter(([a]) => a !== best).map(([, v]) => v);
  if (!values.length) return 0;
  return ev[best] - Math.max(...values);
}

export function shutdownPlay() {
  if (worker) worker.terminate();
  worker = null;
}
