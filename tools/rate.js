#!/usr/bin/env node
// How often does the shoe actually go positive?
//
//   node tools/rate.js data/feed-*.ndjson
//
// The selective-play case rests on this. The edge is settled at +0.664%; how
// often a good shoe turns up is not. Simulation says 11-16% of decisions clear
// the sit threshold, the first four real shoes said 2%.
//
// Rounds inside one shoe share a deck and are strongly correlated, so the
// effective sample size is the number of SHOES. Aggregated per shoe throughout.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Tracker } from '../src/feed/tracker.js';
import { advantage, trueCount } from '../src/engine/ev.js';
import { existingFiles, readStream } from '../src/util/files.js';
import config from '../src/config.js';

const files = existingFiles(process.argv.slice(2).filter((a) => !a.startsWith('--')));
if (!files.length) {
  console.error('usage: node tools/rate.js <feed.ndjson> [more.ndjson ...]');
  console.error('       no matching files found');
  process.exit(1);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pc2 = (x) => `${(x * 100).toFixed(2)}%`;
const h = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

// ---------------------------------------------------------------- collect ---

const shoes = new Map();     // shoeKey -> {decisions:[], rounds}
const allResults = [];
let filesRead = 0;

for (const file of files) {
  // Each capture is its own continuous session; a shoe cannot span files.
  const tracker = new Tracker();
  let lastRound = null;
  const tag = path.basename(file);
  filesRead += 1;

  const rl = readline.createInterface({
    input: readStream(file), crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.d !== 'recv' || typeof rec.p !== 'string') continue;
    let msg; try { msg = JSON.parse(rec.p); } catch { continue; }

    for (const m of Array.isArray(msg) ? msg : [msg]) {
      tracker.handle(m, rec.t);

      // Once per round, when betting opens: the moment you decide whether
      // to sit. Clean shoes only — anything else is unknown composition.
      if (m && m._t === 'bj.Game' && m.phase === 'Betting' && m.gameId !== lastRound) {
        lastRound = m.gameId;
        if (!tracker.shoe.startedClean) continue;
        const rem = tracker.remaining(config.decks);
        const key = `${tag}#${tracker.shoe.index}`;
        if (!shoes.has(key)) shoes.set(key, { key, decisions: [] });
        shoes.get(key).decisions.push({
          adv: advantage(rem, config.decks),
          tc: trueCount(rem, config.decks),
          dealt: tracker.shoe.cards.length,
        });
      }
    }
  }
  tracker.finish();
  allResults.push(...tracker.results);
}

const perShoe = [...shoes.values()].filter((s) => s.decisions.length > 0);
const decisions = perShoe.flatMap((s) => s.decisions);

if (!decisions.length) {
  console.log('\nNo betting decisions from a clean shoe in these files.');
  console.log('A shoe only counts once you have seen the reshuffle that opened it.');
  process.exit(0);
}

// ----------------------------------------------------------------- report ---

console.log('\n=== Sit-opportunity rate ===');
console.log(`files                       : ${filesRead}`);
console.log(`shoes seen from a reshuffle : ${perShoe.length}`);
console.log(`betting decisions           : ${decisions.length}`);

const SIT = config.sitAdvantage;
const clears = (d, t) => d.adv >= t;

function rateStats(threshold) {
  const overall = decisions.filter((d) => clears(d, threshold)).length / decisions.length;
  // Mean and standard error ACROSS SHOES — the honest error bar, treating
  // each shoe as one observation.
  const rates = perShoe.map((s) => s.decisions.filter((d) => clears(d, threshold)).length / s.decisions.length);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const varr = rates.length > 1
    ? rates.reduce((a, r) => a + (r - mean) ** 2, 0) / (rates.length - 1) : 0;
  const se = rates.length > 1 ? Math.sqrt(varr / rates.length) : NaN;
  return { overall, mean, se, rates };
}

h('How often the shoe is worth playing');
console.log('  threshold                 decisions    rate    per-shoe mean ± SE');
for (const [label, t] of [[`sit  (>= ${pc2(SIT)})`, SIT], ['break-even (> 0%)', 0.0000001]]) {
  const s = rateStats(t);
  const n = decisions.filter((d) => clears(d, t)).length;
  const se = Number.isNaN(s.se) ? '   n/a' : `± ${pct(s.se)}`;
  console.log(`  ${label.padEnd(26)} ${String(n).padStart(5)}  ${pct(s.overall).padStart(7)}    ${pct(s.mean)} ${se}`);
}

h('Edge at decision time');
const sorted = decisions.map((d) => d.adv).sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log(`  min ${pc2(q(0))}   p25 ${pc2(q(0.25))}   median ${pc2(q(0.5))}` +
            `   p75 ${pc2(q(0.75))}   p95 ${pc2(q(0.95))}   max ${pc2(q(0.999))}`);

h('Per shoe');
console.log('  shoe                          rounds   sit   >0    best edge');
for (const s of perShoe) {
  const sit = s.decisions.filter((d) => clears(d, SIT)).length;
  const pos = s.decisions.filter((d) => d.adv > 0).length;
  const best = Math.max(...s.decisions.map((d) => d.adv));
  console.log(`  ${s.key.padEnd(30)} ${String(s.decisions.length).padStart(5)}` +
              ` ${String(sit).padStart(5)} ${String(pos).padStart(4)}    ${pc2(best).padStart(8)}`);
}

// ------------------------------------------------------------- what it means
h('What this implies');
const s = rateStats(SIT);
const playRate = s.mean;
const played = decisions.filter((d) => clears(d, SIT));
const meanEdgeWhenPlaying = played.length
  ? played.reduce((a, d) => a + d.adv, 0) / played.length : 0;
const roundsPerHour = 75;                        // measured short-handed
const handsPerHour = roundsPerHour * playRate;
const unitsPerHour = handsPerHour * meanEdgeWhenPlaying * 4;  // ~4u average bet when in
console.log(`  you would play ${pct(playRate)} of rounds  =  ${handsPerHour.toFixed(1)} hands/hour at 75 rounds/hr`);
if (played.length) {
  console.log(`  mean edge when playing      : ${pc2(meanEdgeWhenPlaying)}`);
  console.log(`  rough EV                    : ${unitsPerHour.toFixed(3)} units/hour`);
} else {
  console.log('  never cleared the sit threshold in this sample.');
}
console.log('');
console.log(`  simulation predicted 11-16% of decisions at this threshold.`);
if (perShoe.length < 20) {
  console.log(`  ${perShoe.length} shoe(s) is NOT enough to conclude anything. Rounds inside a`);
  console.log(`  shoe share a deck, so the effective sample is the shoe count, not the`);
  console.log(`  ${decisions.length} decisions. Capture 20-50 shoes before trusting this number:`);
  console.log(`      node tools/capture.js --overnight`);
} else {
  console.log(`  ${perShoe.length} shoes is a usable sample. Compare the per-shoe mean above`);
  console.log(`  against the 11-16% prediction.`);
}

// --------------------------------------------------------- realized results
if (allResults.length) {
  h('Realized results visible in the feed (all seats, not just yours)');
  const byBet = {};
  for (const r of allResults) {
    const b = byBet[r.bet] || (byBet[r.bet] = { n: 0, staked: 0, net: 0 });
    b.n += 1; b.staked += r.amount; b.net += r.net;
  }
  console.log('  bet          n      staked         net     return');
  for (const [bet, v] of Object.entries(byBet).sort((a, b) => b[1].staked - a[1].staked)) {
    const ret = v.staked ? `${(100 * v.net / v.staked).toFixed(1)}%` : '—';
    console.log(`  ${bet.padEnd(10)} ${String(v.n).padStart(4)} ${String(v.staked).padStart(11)}` +
                ` ${String(v.net).padStart(11)}    ${ret.padStart(7)}`);
  }
  console.log('');
  console.log('  Small samples swing wildly — this is not a measurement of house edge.');
  console.log('  It is here to confirm the result parser matches what the table paid.');
}
console.log('');
