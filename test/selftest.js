#!/usr/bin/env node
// A casino-shaped feed over a known shoe, so the dedup logic can be checked
// against ground truth. Run: node test/selftest.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tracker, RANKS } from '../src/feed/tracker.js';

const RANKS_ALL = ['A','2','3','4','5','6','7','8','9','T','J','Q','K'];
const SUITS = ['S','H','D','C'];
const DECKS = 8;
const PEN = 0.75;
const SEATS = ['A','B','C','D','E','G'];

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function buildShoe() {
  const cards = [];
  for (let d = 0; d < DECKS; d++)
    for (const r of RANKS_ALL) for (const s of SUITS) cards.push(r + s);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

const lines = [];
let now = Date.now();
const push = (m) => lines.push(JSON.stringify({ t: now, d: 'recv', u: 'wss://x', p: JSON.stringify(m) }));

const truth = { total: 0, ranks: Object.fromEntries(RANKS_ALL.map(r => [r, 0])) };
const count = (c) => { truth.total++; truth.ranks[c[0]]++; };

let gameSeq = 0;
let splitsEmitted = 0;

function playShoe(shoeNo, emitChange) {
  const shoe = buildShoe();
  let p = 0;
  const limit = Math.floor(shoe.length * PEN);

  if (emitChange) {
    push({ _t: 'bj.Game', _at: now, gameId: `G-boundary-${shoeNo}`, phase: 'ShuffleCards',
           changeCards: true, burnCard: false, cuttingCard: false });
    now += 1000;
    push({ _t: 'bj.Game', _at: now, gameId: `G-boundary-${shoeNo}`, phase: 'Betting',
           changeCards: false, burnCard: false, cuttingCard: false });
    now += 1000;
  }

  while (p < limit - 30) {
    gameSeq++;
    const gameId = `G-${shoeNo}-${gameSeq}`;
    push({ _t: 'bj.Game', _at: now, gameId, gameNumber: `#${gameSeq}`, phase: 'Betting',
           changeCards: false, burnCard: false, cuttingCard: p >= limit - 60 });
    now += 500;

    const hands = {}; for (const s of SEATS) hands[s] = [[]];
    for (let k = 0; k < 2; k++) for (const s of SEATS) { hands[s][0].push(shoe[p]); count(shoe[p]); p++; }
    const up = shoe[p]; count(up); p++;
    const hole = shoe[p]; count(hole); p++;

    const partial = {};
    for (const s of SEATS) partial[s] = [{ cards: hands[s][0].slice(0, 1), score: 0, soft: false }];
    push({ _t: 'bj.Hands', _at: now * 1e6, dealerHand: { cards: [up, '**'], score: 0, soft: false },
           playerHands: partial });
    now += 300;

    // Cumulative arrays, the shape the real feed uses.
    const snapAll = () => {
      const snap = {};
      for (const t of SEATS) {
        snap[t] = hands[t].map((cs) => ({ cards: cs.slice(), score: 0, soft: false }));
      }
      return snap;
    };
    const emit = (ms) => {
      push({ _t: 'bj.Hands', _at: now * 1e6,
             dealerHand: { cards: [up, '**'], score: 0, soft: false },
             playerHands: snapAll() });
      now += ms;
    };

    emit(800);

    // Hand 0 shrinks and a new hand takes the card that left it, dealing no
    // new card — the rearrangement that defeats positional dedup:
    //
    //   [AC AD] -> [AC][AD] -> [AC 6H][AD] -> [AC 6H][AD 2C]
    for (const s of SEATS) {
      if (hands[s].length !== 1 || hands[s][0].length !== 2) continue;
      if (rnd() >= 0.2 || p >= shoe.length - 2) continue;
      splitsEmitted += 1;
      hands[s].push([hands[s][0].pop()]);   // hand 0 shrinks, hand 1 takes the card
      emit(300);
      for (const h of hands[s]) {           // each split hand draws one
        h.push(shoe[p]); count(shoe[p]); p++;
        emit(300);
      }
    }

    for (const s of SEATS) {
      const nHits = rnd() < 0.45 ? (rnd() < 0.3 ? 2 : 1) : 0;
      for (let i = 0; i < nHits && p < shoe.length; i++) {
        hands[s][0].push(shoe[p]); count(shoe[p]); p++;
        emit(400);
      }
    }

    const dealer = [up, hole];
    const nDraw = rnd() < 0.6 ? (rnd() < 0.4 ? 2 : 1) : 0;
    for (let i = 0; i < nDraw && p < shoe.length; i++) { dealer.push(shoe[p]); count(shoe[p]); p++; }
    const final = snapAll();
    push({ _t: 'bj.PlayerTableState', _at: now, gameId, phase: 'Completed',
           dealerHand: { cards: dealer, score: 0, soft: false }, playerHands: final,
           tableSettings: { tableId: 'table-1', tableName: 'Live Blackjack',
             bettingTimeMs: 15000, decisionTimeMs: 15000, allowedSideBets: ['21+3', 'pair'],
             betBehindAllowed: true, maxSeatsPerPlayer: 1, kickoutAfterIdleGames: 3,
             limits: { main: { min: 100, max: 100000 }, '21+3': { min: 100, max: 100000 } },
             chips: { denominations: [100, 1000, 2500] } },
           seats: {} });
    now += 3000;
  }
}

playShoe(1, true);
playShoe(2, true);
push({ _t: 'bj.Game', _at: now, gameId: 'G-end', phase: 'ShuffleCards',
       changeCards: true, burnCard: false, cuttingCard: false });

const fixture = path.join(os.tmpdir(), 'selftest.ndjson');
fs.writeFileSync(fixture, lines.join('\n') + '\n');
console.log(`fixture written to ${fixture}\n`);

// --- replay through the tracker and compare to ground truth -----------------
const tracker = new Tracker();
for (const line of lines) {
  const rec = JSON.parse(line);
  tracker.handle(JSON.parse(rec.p), rec.t);
}
tracker.finish();

const got = { total: 0, ranks: Object.fromEntries(RANKS_ALL.map(r => [r, 0])) };
for (const s of tracker.shoes) {
  got.total += s.cards.length;
  for (const r of RANKS_ALL) got.ranks[r] += s.rankCounts[r];
}

console.log(`dealt (truth)  : ${truth.total}`);
console.log(`dealt (tracker): ${got.total}`);
console.log(`shoes          : ${tracker.shoes.length}  complete: ${tracker.completeShoes().length}`);
console.log(`splits emitted : ${splitsEmitted}`);
console.log(`warnings       : ${tracker.warnings.length}`);

let ok = got.total === truth.total;

// Without splits the fixture passes trivially, leaving the exact bug this
// exists to catch untested.
if (splitsEmitted === 0) {
  ok = false;
  console.log('  FIXTURE BROKEN: no splits were emitted, split path untested');
}
// A warning means a card changed identity somewhere we thought was settled,
// which multiset dedup gives no legitimate reason to do.
if (tracker.warnings.length > 0) {
  ok = false;
  console.log(`  UNEXPECTED WARNINGS (${tracker.warnings.length}):`);
  for (const w of tracker.warnings.slice(0, 5)) console.log(`    ${w}`);
}
for (const r of RANKS_ALL) {
  if (got.ranks[r] !== truth.ranks[r]) {
    ok = false;
    console.log(`  MISMATCH ${r}: truth ${truth.ranks[r]} vs tracker ${got.ranks[r]}`);
  }
}
for (const s of tracker.completeShoes()) {
  console.log(`  complete shoe #${s.index}: ${s.cards.length} cards, ${s.rounds.length} rounds, ` +
    `pen ${(s.cards.length / (8 * 52) * 100).toFixed(1)}%`);
}
console.log(ok ? '\nPASS — exact match on every rank.' : '\nFAIL');
process.exit(ok ? 0 : 1);