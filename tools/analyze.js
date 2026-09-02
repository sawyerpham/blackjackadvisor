#!/usr/bin/env node
// Captured NDJSON -> penetration, plus supporting detail.
//
//   node tools/analyze.js data/feed-*.ndjson

import fs from 'node:fs';
import readline from 'node:readline';
import { Tracker, RANKS, deckLowerBound, deckFloorFromTotal } from '../src/feed/tracker.js';
import { SchemaRecorder } from '../src/feed/schema.js';
import { existingFiles, readStream } from '../src/util/files.js';

const files = existingFiles(process.argv.slice(2));
if (!files.length) {
  console.error('usage: node tools/analyze.js <feed.ndjson> [more.ndjson ...]');
  console.error('       no matching files found');
  process.exit(1);
}

const schema = new SchemaRecorder();
let lines = 0, jsonMsgs = 0;

// ONE TRACKER PER FILE. Each capture is its own process run, so there is always
// a gap between files and a shoe cannot span them. One tracker over several
// files splices the end of one session onto the start of the next and invents
// shoes that were never dealt.
const trackers = [];

for (const file of files) {
  const tracker = new Tracker();
  let seated = false;
  const rl = readline.createInterface({
    input: readStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    // Markers written by capture.js when you sit down or stand up.
    if (rec.d === 'mark') { seated = !!rec.seated; continue; }
    if (rec.d !== 'recv' || typeof rec.p !== 'string') continue;
    let msg;
    try { msg = JSON.parse(rec.p); } catch { continue; }
    jsonMsgs += 1;
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      tracker.handle(m, rec.t);
      // Captures recorded before markers existed have none.
      schema.record(m, seated || tracker.mySeat != null);
    }
  }
  tracker.finish();
  trackers.push(tracker);
}

// Merged view across sessions.
const tracker = {
  msgTypes: new Map(),
  phases: new Set(),
  warnings: [],
  tableSettings: null,
  results: [],
};
for (const t of trackers) {
  for (const [k, v] of t.msgTypes) tracker.msgTypes.set(k, (tracker.msgTypes.get(k) || 0) + v);
  for (const p of t.phases) tracker.phases.add(p);
  tracker.warnings.push(...t.warnings);
  tracker.results.push(...t.results);
  if (t.tableSettings) tracker.tableSettings = t.tableSettings;
}

const all = trackers.flatMap((t) => t.shoes);
const complete = trackers.flatMap((t) => t.completeShoes());

const h = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`\n=== Live blackjack feed analysis ===`);
console.log(`files          : ${files.length}`);
console.log(`frames read    : ${lines}`);
console.log(`json messages  : ${jsonMsgs}`);

h('Message types');
for (const [t, n] of [...tracker.msgTypes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(24)} ${n}`);
}

h('Phases observed');
console.log('  ' + ([...tracker.phases].join(', ') || '(none)'));

// ---------------------------------------------------------------- penetration
h('PENETRATION  <-- this is the number that matters');

if (!complete.length) {
  console.log(`  No complete shoe captured yet.`);
  console.log(`  A complete shoe means you saw the reshuffle that opened it AND`);
  console.log(`  the one that closed it. On this table the reshuffle is the`);
  console.log(`  cuttingCard flag going false, not changeCards (never fires).`);
  console.log(`  Keep capturing — you need one shoe start to shoe start.`);
  console.log(`  Partial shoes seen: ${all.length}`);
  for (const s of all) {
    console.log(`    shoe #${s.index}: ${s.cards.length} cards, ${s.rounds.length} rounds ` +
      `(open:${s.startedClean ? 'seen' : 'missed'} close:${s.endedClean ? 'seen' : 'missed'})`);
  }
} else {
  // Must satisfy both bounds; take the tightest plausible standard size.
  const floor = Math.max(...complete.map(deckFloorFromTotal));
  const lower = Math.max(...complete.map(deckLowerBound));
  const need = Math.max(floor, lower);
  const candidates = [1, 2, 4, 6, 8].filter((d) => d >= need);
  const decks = Number(process.env.DECKS) || candidates[0] || need;

  console.log(`  deck count : ${decks}${process.env.DECKS ? ' (from DECKS env)' : ' (inferred)'}`);
  console.log(`               at least ${floor} from total cards dealt`);
  console.log(`               at least ${lower} from repeat count of a single card code`);
  console.log(`  shoe size  : ${decks * 52} cards\n`);

  // "Complete" only means both reshuffle edges were seen — a dealer change or
  // table reset closes a shoe after a handful of cards and still reports a cut
  // position. One 22-card and one 4-card shoe pulled the overnight mean from
  // 52.6% to 49.9%.
  //
  // Excluded shoes are listed with their reason, never silently dropped:
  // filtering shallow shoes out of a shallow-penetration measurement is how you
  // fool yourself into continuing a dead project.
  const MIN_PEN = Number(process.env.MIN_SHOE_PEN || 0.25);
  const penOf = (s) => s.cards.length / (decks * 52);
  const scored = complete.filter((s) => penOf(s) >= MIN_PEN);
  const excluded = complete.filter((s) => penOf(s) < MIN_PEN);

  let sum = 0;
  for (const s of complete) {
    const p = penOf(s);
    const keep = p >= MIN_PEN;
    if (keep) sum += p;
    const mins = s.tEnd && s.tStart ? ((s.tEnd - s.tStart) / 60000).toFixed(1) : '?';
    console.log(
      `  shoe #${String(s.index).padStart(2)}  ${String(s.cards.length).padStart(4)} cards  ` +
      `${String(s.rounds.length).padStart(3)} rounds  ${String(mins).padStart(5)} min  ` +
      `pen ${pct(p)}` +
      (s.cutSeenAtCard != null ? `  cut@${s.cutSeenAtCard}` : '') +
      (s.burnEvents ? `  burns:${s.burnEvents}` : '') +
      (keep ? '' : '   <-- EXCLUDED, too short to have reached a real cut card')
    );
  }

  if (excluded.length) {
    console.log(
      `\n  ${excluded.length} shoe(s) excluded from the average: under ` +
      `${pct(MIN_PEN)} of the shoe, which no genuine cut card placement ` +
      `explains.\n  These end early for table reasons (dealer change, reset) or a ` +
      `false shoe\n  boundary — either way they measure nothing. Override with ` +
      `MIN_SHOE_PEN=0.\n`
    );
  }

  if (!scored.length) {
    console.log(`\n  No shoe ran long enough to measure. Nothing to report.`);
    console.log(`  Capture more, or lower MIN_SHOE_PEN if the cut really is that early.`);
    process.exit(0);
  }

  const avg = sum / scored.length;
  console.log(`\n  AVERAGE PENETRATION: ${pct(avg)} over ${scored.length} complete shoe(s)` +
    (excluded.length ? ` (+${excluded.length} excluded)` : ''));
  console.log('');
  if (avg < 0.55) {
    console.log(`  Verdict: too shallow. There is effectively no edge here regardless`);
    console.log(`  of how exact your composition tracking is. Stop.`);
  } else if (avg < 0.68) {
    console.log(`  Verdict: marginal. An edge exists on paper but is thin enough that`);
    console.log(`  variance and the idle-kickout rule likely eat it.`);
  } else {
    console.log(`  Verdict: deep enough to be interesting. Next constraint is bet`);
    console.log(`  spread and the idle-kickout rule (see below).`);
  }
}

// ------------------------------------------------------------ rank sanity
h('Rank distribution across all captured cards');
const totals = Object.fromEntries(RANKS.map((r) => [r, 0]));
let grand = 0;
for (const s of all) for (const r of RANKS) { totals[r] += s.rankCounts[r]; grand += s.rankCounts[r]; }
if (grand) {
  for (const r of RANKS) {
    const share = totals[r] / grand;
    const bar = '#'.repeat(Math.round(share * 400));
    console.log(`  ${r.padEnd(2)} ${String(totals[r]).padStart(5)}  ${pct(share).padStart(6)} ${bar}`);
  }
  console.log(`\n  Each rank should sit near ${pct(1 / 13)}. A rank far off that means`);
  console.log(`  the dedup logic is dropping or double-counting cards.`);
} else {
  console.log('  (no cards captured)');
}

// ------------------------------------------------------------ table settings
h('Table settings');
const ts = tracker.tableSettings;
if (!ts) {
  console.log('  Not captured yet — needs one bj.PlayerTableState message.');
} else {
  console.log(`  table        : ${ts.tableName} (${ts.tableId})`);
  console.log(`  betting time : ${ts.bettingTimeMs} ms`);
  console.log(`  decision time: ${ts.decisionTimeMs} ms`);
  console.log(`  side bets    : ${(ts.allowedSideBets || []).join(', ') || 'none'}  <- ignore, negative EV`);
  console.log(`  bet behind   : ${ts.betBehindAllowed}`);
  console.log(`  max seats    : ${ts.maxSeatsPerPlayer}`);
  console.log(`  idle kickout : after ${ts.kickoutAfterIdleGames} idle games`);
  if (ts.kickoutAfterIdleGames != null && ts.kickoutAfterIdleGames < 99) {
    console.log(`                 ^ you cannot sit out negative counts from a seat.`);
    console.log(`                   Check whether bet-behind resets this counter.`);
  }
  if (ts.limits) {
    console.log(`  limits:`);
    for (const [k, v] of Object.entries(ts.limits)) {
      console.log(`    ${k.padEnd(10)} min ${v.min}  max ${v.max}  (spread ${(v.max / v.min).toFixed(0)}x)`);
    }
    const main = ts.limits.main;
    if (main) {
      console.log(`\n  Main bet spread cap: ${(main.max / main.min).toFixed(0)}x`);
    } else {
      console.log(`\n  No "main" entry captured — capture while a betting phase is open.`);
    }
  }
  if (ts.chips?.denominations) {
    console.log(`  chip denoms  : ${ts.chips.denominations.join(', ')}`);
    console.log(`                 (confirm whether these are cents or whole units)`);
  }
}

// ------------------------------------------------------------ round timing
h('Round pacing');
const durations = [];
for (const s of all) {
  const byRound = new Map();
  for (const c of s.cards) {
    const e = byRound.get(c.round) || { min: c.ts, max: c.ts };
    e.min = Math.min(e.min, c.ts); e.max = Math.max(e.max, c.ts);
    byRound.set(c.round, e);
  }
  const starts = [...byRound.values()].map((e) => e.min).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) durations.push(starts[i] - starts[i - 1]);
}
if (durations.length) {
  durations.sort((a, b) => a - b);
  const med = durations[Math.floor(durations.length / 2)] / 1000;
  console.log(`  median round-to-round: ${med.toFixed(1)}s over ${durations.length} intervals`);
  console.log(`  implied rounds/hour  : ${(3600 / med).toFixed(0)}`);
} else {
  console.log('  not enough data');
}

// ------------------------------------------------------------ warnings
if (tracker.warnings.length) {
  h('Warnings (dedup anomalies — investigate these)');
  for (const w of tracker.warnings.slice(0, 20)) console.log('  ' + w);
  if (tracker.warnings.length > 20) console.log(`  ...and ${tracker.warnings.length - 20} more`);
}

// ------------------------------------------------------- seated vs watching
h('Seated vs spectating');
console.log(schema.report());

// The cleanest read on the units question: compare against the balance the site
// shows you.
const balances = schema.toJSON().paths.find((p) => p.type === 'common.balance' && p.path === 'balance');
if (balances && balances.samples.length) {
  console.log(`\n  common.balance values seen: ${balances.samples.join(', ')}`);
  console.log(`  If the site showed you 1/100th of that, amounts are in cents.`);
}

// ------------------------------------------------------------ open questions
h('Still to verify manually');
console.log(`  1. Does burnCard:true ever come with a card value? If not, every burn`);
console.log(`     is an unknown removal and your penetration math drifts.`);
console.log(`     burn events seen: ${all.reduce((a, s) => a + s.burnEvents, 0)}`);
console.log(`  2. Does bet-behind reset the idle-game counter? Only testable by playing.`);
console.log(`  3. On reconnect, does bj.PlayerTableState replay the shoe's history or`);
console.log(`     only the current round? If only current, any drop kills that shoe.`);
console.log(`  4. Currency unit: the chip ladder implies feed = display x 100, i.e.`);
console.log(`     cents. Confirm against your real balance while logged in.`);
console.log('');
