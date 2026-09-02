#!/usr/bin/env node
// Logs every table websocket frame to NDJSON and stops once it has seen enough
// complete shoes to measure. The CLI around attach.js: disk log, HUD, summary,
// auto-stop.
//
//   node tools/capture.js                      attach to your own Edge (npm run edge first)
//   ATTACH=launch node tools/capture.js        launch a dedicated browser instead
//   node tools/capture.js --overnight          run until Ctrl+C, heartbeat lines

import fs from 'node:fs';
import path from 'node:path';
import { attachFeed } from '../src/feed/attach.js';
import { Tracker, deckLowerBound } from '../src/feed/tracker.js';
import { SchemaRecorder } from '../src/feed/schema.js';
import { fromRoot } from '../src/util/paths.js';

const OUT_DIR = process.env.OUT_DIR || fromRoot('data');

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(OUT_DIR, `feed-${stamp}.ndjson`);
const out = fs.createWriteStream(outPath, { flags: 'a' });

let frames = 0;
let parsed = 0;
let sockets = 0;
let completeShoes = 0;

// Only a shoe watched reshuffle-to-reshuffle is measurable, so the auto-stop
// counts those rather than elapsed time; 0 disables it. --overnight prints
// timestamped lines instead of the \r status bar, which smears a redirected log.
const OVERNIGHT = process.argv.includes('--overnight');
const STOP_AFTER = OVERNIGHT ? 0 : Number(process.env.STOP_AFTER_SHOES ?? 2);
const INTERACTIVE = process.stdout.isTTY && !OVERNIGHT;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 300_000);   // 5 min

const startedAt = Date.now();
let socketDrops = 0;

// Two failure modes, kept distinct. An idle table still sends pings and seat
// updates, so "no cards" is normal at 6am and only worth a note; "no frames at
// all" means the connection is dead and the rest of the night is wasted.
let lastFrameAt = Date.now();
let lastCardAt = Date.now();
const DEAD_MS = Number(process.env.DEAD_MS || 180_000);      // 3 min, no frames
const IDLE_MS = Number(process.env.IDLE_MS || 1_200_000);    // 20 min, no cards
let warnedDead = false;

// Whether the feed differs when you actually play is an open question, so every
// message shape is recorded tagged by seated-or-spectating, and diffed.
const schema = new SchemaRecorder();
let seated = false;
let seatedRounds = 0;
const clock = () => new Date().toLocaleTimeString();
const hhmm = (ms) => {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

const tracker = new Tracker({
  onCard() { lastCardAt = Date.now(); },
  onShoeClose(shoe) {
    const usable = shoe.startedClean && shoe.endedClean;
    if (usable) completeShoes += 1;
    const pen = usable ? ` pen ${(100 * shoe.cards.length / 416).toFixed(1)}%` : '';
    process.stdout.write(
      `\n${clock()}  shoe #${shoe.index} closed — ${shoe.cards.length} cards over ` +
      `${shoe.rounds.length} rounds` +
      (shoe.cutSeenAtCard != null ? ` (cut@${shoe.cutSeenAtCard})` : '') + pen +
      (usable
        ? `  [COMPLETE ${completeShoes}${STOP_AFTER ? '/' + STOP_AFTER : ''}]`
        : `  [partial — joined mid-shoe, not measurable]`) +
      `\n`
    );
    if (STOP_AFTER > 0 && completeShoes >= STOP_AFTER) {
      process.stdout.write(`\ngot ${completeShoes} complete shoe(s) — stopping.\n`);
      shutdown();
    }
  },
});

function hud() {
  const shoe = tracker.shoe;
  const types = [...tracker.msgTypes.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}:${v}`).join(' ');
  const line =
    `sockets ${sockets} | frames ${frames} | json ${parsed} | ` +
    `shoe#${shoe.index} cards ${shoe.cards.length} rounds ${shoe.rounds.length} | ` +
    `complete ${completeShoes}/${STOP_AFTER || '∞'} | ` +
    `decks>=${deckLowerBound(shoe)} | ${types}`;
  process.stdout.write('\r' + line.padEnd(140).slice(0, 140));
}

// One durable line every few minutes: if something dies at 4am this is the only
// record of when.
function heartbeat() {
  const shoe = tracker.shoe;
  const mb = (fs.statSync(outPath).size / 1e6).toFixed(1);
  const noFrames = Date.now() - lastFrameAt;
  const noCards = Date.now() - lastCardAt;
  let health = '';
  if (noFrames > DEAD_MS) {
    health = `  *** NO FRAMES FOR ${hhmm(noFrames)} — FEED LOOKS DEAD ***`;
  } else if (noCards > IDLE_MS) {
    health = `  (table idle ${hhmm(noCards)} — no cards dealt, connection fine)`;
  }
  process.stdout.write(
    `${clock()}  up ${hhmm(Date.now() - startedAt)} | complete ${completeShoes} | ` +
    `shoe#${shoe.index} ${shoe.cards.length}c/${shoe.rounds.length}r | ` +
    `frames ${frames} | ${mb}MB | drops ${socketDrops}${health}\n`
  );
}

// More often than the heartbeat, so a dead feed is announced promptly.
function healthCheck() {
  const noFrames = Date.now() - lastFrameAt;
  if (noFrames > DEAD_MS && !warnedDead) {
    warnedDead = true;
    process.stdout.write(
      `\n${clock()}  *** no websocket frames for ${hhmm(noFrames)} ***\n` +
      `  The table page has probably been closed, navigated away, or crashed.\n` +
      `  Reopen the blackjack table in that Edge window — capture will pick it\n` +
      `  back up on its own, and the next shoe after a clean reshuffle counts.\n`
    );
  } else if (noFrames < DEAD_MS && warnedDead) {
    warnedDead = false;
    process.stdout.write(`\n${clock()}  frames resumed.\n`);
  }
}

const feedOptions = {
  onFrame(direction, url, payload) {
    frames += 1;
    lastFrameAt = Date.now();
    out.write(JSON.stringify({
      t: Date.now(),
      d: direction,
      u: url,                       // already redacted by attach.js
      p: typeof payload === 'string' ? payload : '<binary>',
    }) + '\n');
  },
  onMessage(msg, ts) {
    parsed += 1;
    tracker.handle(msg, ts);

    // After the tracker, so the bj.Seats message that seats you counts as
    // seated.
    const seatedNow = tracker.mySeat != null;
    if (seatedNow !== seated) {
      seated = seatedNow;
      seatedRounds += seated ? 1 : 0;
      process.stdout.write(
        `\n${clock()}  ${seated ? `SEATED at ${tracker.mySeat} — recording seated-only fields`
                                : 'left the seat — back to spectating'}\n`
      );
      // A marker in the raw log so a later replay can find the transition.
      out.write(JSON.stringify({ t: Date.now(), d: 'mark', seated, seat: tracker.mySeat }) + '\n');
    }
    schema.record(msg, seated);
  },
  onSocket(event, url) {
    if (event === 'open') sockets += 1;
    if (event === 'closed') socketDrops += 1;
    if (event === 'naverror') {
      process.stdout.write(`\nnavigation issue (you can navigate manually): ${url}\n`);
      return;
    }
    process.stdout.write(`\n${clock()}  websocket ${event}: ${url}\n`);
  },
};

let feed;
try {
  feed = await attachFeed(feedOptions);
} catch (e) {
  // Almost always "Edge isn't listening on the debug port", which attach.js
  // phrases usefully. Anything else is surfaced as-is rather than as a stack.
  console.error(`\n${e.message}\n`);
  try { fs.unlinkSync(outPath); } catch { /* nothing written yet */ }
  process.exit(1);
}

console.log(`writing to ${outPath}`);
console.log(`attach mode: ${feed.mode}`);
if (feed.mode === 'cdp') {
  console.log('attached to your own browser — open the blackjack table and leave it running.');
} else {
  console.log('log in, open a blackjack table, then leave it running.');
}
if (OVERNIGHT) {
  console.log(`overnight mode — running until stopped, heartbeat every ${HEARTBEAT_MS / 60000} min.`);
  console.log('leave the table open. Ctrl+C when you are done.');
}
console.log('');

const timer = INTERACTIVE ? setInterval(hud, 1000) : null;
const beat = INTERACTIVE ? null : setInterval(heartbeat, HEARTBEAT_MS);
const health = setInterval(healthCheck, 30_000);
if (!INTERACTIVE) heartbeat();

let shuttingDown = false;
async function shutdown() {
  // Reachable from SIGINT, the auto-stop, and context close — which fires as a
  // consequence of the first two.
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearInterval(timer);
  if (beat) clearInterval(beat);
  clearInterval(health);
  tracker.finish();
  process.stdout.write('\n\nstopping...\n');
  const complete = tracker.shoes.filter((s) => s.startedClean && s.endedClean);
  const summary = {
    outPath,
    ranForMs: Date.now() - startedAt,
    socketDrops,
    completeShoes: complete.length,
    meanPenetration: complete.length
      ? Number((complete.reduce((a, s) => a + s.cards.length, 0) / complete.length / 416).toFixed(4))
      : null,
    frames,
    parsedMessages: parsed,
    messageTypes: Object.fromEntries(tracker.msgTypes),
    phases: [...tracker.phases],
    shoes: tracker.shoes.map((s) => ({
      index: s.index,
      cards: s.cards.length,
      rounds: s.rounds.length,
      startedClean: s.startedClean,
      endedClean: s.endedClean,
      cutSeenAtCard: s.cutSeenAtCard,
    })),
    tableSettings: tracker.tableSettings,
  };
  const sumPath = outPath.replace(/\.ndjson$/, '.summary.json');
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));

  const schemaPath = outPath.replace(/\.ndjson$/, '.schema.json');
  fs.writeFileSync(schemaPath, JSON.stringify(schema.toJSON(), null, 2));

  console.log('\nSeated vs spectating');
  console.log('--------------------');
  console.log(schema.report());
  console.log('');
  console.log(`ran for    : ${hhmm(Date.now() - startedAt)}`);
  console.log(`complete   : ${complete.length} shoe(s)` +
    (summary.meanPenetration ? `, mean penetration ${(summary.meanPenetration * 100).toFixed(1)}%` : ''));
  console.log(`socket drops: ${socketDrops}`);
  console.log(`seated     : ${schema.everSeated() ? `yes (${seatedRounds} sit-down(s))` : 'no — spectated only'}`);
  console.log(`raw frames : ${outPath}`);
  console.log(`summary    : ${sumPath}`);
  console.log(`schema     : ${schemaPath}`);
  console.log(`\nnow run:  node tools/analyze.js ${outPath}`);
  out.end();
  await feed.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (feed.context) feed.context.on('close', shutdown);
