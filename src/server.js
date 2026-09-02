#!/usr/bin/env node
// The live advisor: serves the dashboard and says when to sit, when to leave,
// and how much to bet. Advisory only.
//
//   node src/server.js                                    live, attach to your Edge
//   ATTACH=launch node src/server.js                      live, dedicated browser
//   node src/server.js --replay data/feed-*.ndjson        replay a capture
//   node src/server.js --replay data/*.ndjson --speed 20  ...faster
//
// Push is SSE, not a websocket: the dashboard only receives, and SSE needs no
// dependency and no build step.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Tracker } from './feed/tracker.js';
import { advise } from './advice/advisor.js';
import { shutdownPlay, evaluatePosition } from './engine/play.js';
import { Grades } from './advice/grades.js';
import { History } from './advice/history.js';
import { betBehind } from './advice/behind.js';
import { existingFiles, readStream } from './util/files.js';
import { sideBySide } from './util/screen.js';
import { SchemaRecorder } from './feed/schema.js';
import config from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REPLAY = flag('--replay');
const SPEED = Number(valueOf('--speed', '20'));
// Running capture.js alongside this would mean two CDP clients on one browser,
// and whichever starts second reloads the table tab — killing the other's socket
// mid-shoe. One process, one attach.
const RECORD = flag('--record');

// Files after --replay, up to the next flag.
function replayFiles() {
  const i = argv.indexOf('--replay');
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j]);
  return existingFiles(out);
}

// ---------------------------------------------------------------- state ----

let socketDropped = false;
// Set from the dashboard when you saw something the feed cannot report.
let manualUntrust = false;

const tracker = new Tracker({
  onShoeClose(shoe) {
    // A reshuffle is a clean slate: whatever hole a dropped socket left in the
    // previous shoe cannot affect the next one.
    socketDropped = false;
    manualUntrust = false;
    const complete = shoe.startedClean && shoe.endedClean;
    log(`shoe #${shoe.index} closed — ${shoe.cards.length} cards, ${shoe.rounds.length} rounds` +
        (complete ? '  [complete]' : '  [partial]'));
    logRow({
      kind: 'shoe', shoe: shoe.index, cards: shoe.cards.length,
      rounds: shoe.rounds.length, complete,
      cutSeenAtCard: shoe.cutSeenAtCard,
      penetration: complete ? Number((shoe.cards.length / (config.decks * 52)).toFixed(4)) : null,
    });
  },
});

// ------------------------------------------------------------ session log --
// History, not accounting: a row per betting decision and per shoe, so you can
// answer afterwards how often the count cleared the sit threshold.
let sessionPath = null;
let sessionOut = null;
if (config.sessionLog && !REPLAY) {
  fs.mkdirSync(config.logDir, { recursive: true });
  sessionPath = path.join(config.logDir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  sessionOut = fs.createWriteStream(sessionPath, { flags: 'a' });
}
function logRow(row) {
  if (!sessionOut) return;
  sessionOut.write(JSON.stringify({ t: Date.now(), ...row }) + '\n');
}

// ---------------------------------------------------------- raw recording --
// The same NDJSON capture.js writes, so analyze.js and rate.js consume it
// unchanged.
let feedPath = null;
let feedOut = null;
let frames = 0;
let seatedNow = false;
const schema = RECORD ? new SchemaRecorder() : null;

if (RECORD && !REPLAY) {
  fs.mkdirSync(config.logDir, { recursive: true });
  feedPath = path.join(config.logDir,
    `feed-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
  feedOut = fs.createWriteStream(feedPath, { flags: 'a' });
}

function recordFrame(direction, url, payload) {
  if (!feedOut) return;
  frames += 1;
  feedOut.write(JSON.stringify({
    t: Date.now(), d: direction, u: url,
    p: typeof payload === 'string' ? payload : '<binary>',
  }) + '\n');
}

function recordMessage(msg) {
  if (!schema) return;
  const nowSeated = tracker.mySeat != null;
  if (nowSeated !== seatedNow) {
    seatedNow = nowSeated;
    log(nowSeated ? `SEATED at ${tracker.mySeat}` : 'left the seat');
    if (feedOut) {
      feedOut.write(JSON.stringify({ t: Date.now(), d: 'mark', seated: seatedNow, seat: tracker.mySeat }) + '\n');
    }
  }
  schema.record(msg, seatedNow);
}

function finishRecording() {
  if (!feedPath) return;
  const complete = tracker.shoes.filter((s) => s.startedClean && s.endedClean);
  fs.writeFileSync(feedPath.replace(/\.ndjson$/, '.summary.json'), JSON.stringify({
    outPath: feedPath,
    frames,
    completeShoes: complete.length,
    meanPenetration: complete.length
      ? Number((complete.reduce((a, s) => a + s.cards.length, 0) / complete.length / (config.decks * 52)).toFixed(4))
      : null,
    messageTypes: Object.fromEntries(tracker.msgTypes),
    shoes: tracker.shoes.map((s) => ({
      index: s.index, cards: s.cards.length, rounds: s.rounds.length,
      startedClean: s.startedClean, endedClean: s.endedClean, cutSeenAtCard: s.cutSeenAtCard,
    })),
    tableSettings: tracker.tableSettings,
  }, null, 2));
  if (schema) {
    fs.writeFileSync(feedPath.replace(/\.ndjson$/, '.schema.json'), JSON.stringify(schema.toJSON(), null, 2));
    console.log('\nSeated vs spectating');
    console.log(schema.report());
  }
  feedOut.end();
  console.log(`\nrecorded: ${feedPath}`);
  console.log(`now run:  node tools/rate.js ${feedPath}`);
}

let lastAction = null;
let lastLoggedRound = null;

// How well everyone else is playing — seated or not. Your own seat is left out
// at both ends: grades.js never scores it, and liveSeats below never names it.
const grades = new Grades({
  evaluate: evaluatePosition,
  rules: config.rules,
  decks: config.decks,
  displayDivisor: config.displayDivisor,
});

const history = new History();

function observe(msg, ts) {
  tracker.handle(msg, ts);
  grades.handle(msg, tracker);
  // After the tracker, so the round key it compares against is current.
  history.handle(msg, tracker);
}

function currentState() {
  const state = advise(tracker, config, { socketDropped, manualUntrust });
  // Occupied seats only — seatNames also remembers departed players — and never
  // your own, which is what keeps you out of a panel about everyone else.
  const liveSeats = {};
  for (const seat of tracker.occupiedSeats) {
    if (seat === tracker.mySeat) continue;
    if (tracker.seatNames[seat]) liveSeats[seat] = tracker.seatNames[seat];
  }
  state.players = grades.standings(liveSeats, tracker.mySeat);
  // Kept whether seated or not: what the table just did is worth the same
  // either way, and unlike the standings it is not about the players.
  state.history = history.recent();

  // Spectating-only: the standings are useful either way, but the situation
  // bet-behind sizing is for is having no seat of your own. Absent rather than
  // empty, so the dashboard hides the panel instead of showing an empty one.
  if (!state.seated) {
    state.behind = betBehind({
      players: state.players,
      advantage: state.advantage,
      cfg: config,
    });
  }
  return state;
}

// One row per betting decision — the sampling point that matters.
function maybeLogDecision(state) {
  if (state.phase !== 'Betting') return;
  const key = `${state.shoeIndex}:${state.rounds}`;
  if (key === lastLoggedRound) return;
  lastLoggedRound = key;
  logRow({
    kind: 'decision',
    shoe: state.shoeIndex,
    round: state.rounds,
    dealt: state.dealt,
    advantage: Number(state.advantage.toFixed(5)),
    trueCount: Number(state.trueCount.toFixed(2)),
    runningCount: state.runningCount,
    action: state.action,
    betUnits: state.betUnits,
    seated: state.seated,
    trusted: state.trusted,
  });
}

const clients = new Set();
function broadcast() {
  const state = currentState();
  if (state.action !== lastAction) {
    log(`${lastAction || '—'} -> ${state.action}   ${why(state)}` +
        (state.betUnits ? `  bet ${state.betUnits}u` : ''));
    logRow({ kind: 'action', from: lastAction, to: state.action,
             advantage: Number(state.advantage.toFixed(5)), betUnits: state.betUnits });
    lastAction = state.action;
  }
  maybeLogDecision(state);
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}
const why = (s) => `${(s.advantage * 100).toFixed(2)}%  TC ${s.trueCount.toFixed(1)}  ${s.why}`;

function log(msg) {
  process.stdout.write(`${new Date().toLocaleTimeString()}  ${msg}\n`);
}

// --------------------------------------------------------------- server ----

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    res.write(`data: ${JSON.stringify(currentState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // One direction only: there is no route back to trusted, because nothing you
  // click can restore knowledge of a card that went past unseen. The reshuffle
  // does that.
  if (url === '/untrust') {
    manualUntrust = true;
    log('shoe marked UNTRUSTED from the dashboard');
    broadcast();
    res.writeHead(204); res.end();
    return;
  }

  if (url === '/' || url === '/index.html') {
    const html = fs.readFileSync(path.join(HERE, '..', 'ui', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${config.port} is already in use — another advisor is probably still running.\n` +
      `  Use a different port:  PORT=8081 node src/server.js\n`
    );
    process.exit(1);
  }
  throw e;
});

// Last resort: hand the URL to whatever the OS has registered. Used for
// --replay, where there is no browser of our own to put it in.
function openInDefaultBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    // Detached and fully ignored: this is a convenience, and a machine with no
    // handler registered must not take the advisor down with it.
    spawn(cmd, args, { detached: true, stdio: 'ignore' })
      .on('error', (e) => log(`could not open a browser (${e.code}) — open ${url} yourself`))
      .unref();
  } catch (e) {
    log(`could not open a browser (${e.message}) — open ${url} yourself`);
  }
}

// The dashboard goes in the SAME browser as the table, as a second window.
//
// It used to open your default browser, on the theory that a second tab would
// background the table page and Chromium throttles hidden tabs, starving the
// feed. MEASURED, and false here: with the dashboard focused the table page
// still reports visibilityState 'visible' and fires ~20 timer ticks in 2s.
// Playwright launches with --disable-background-timer-throttling,
// --disable-backgrounding-occluded-windows and --disable-renderer-backgrounding,
// and edge.js passes the same three. The theory is right for an ordinary browser
// and wrong for this one — if those flags ever go away, a tab starves the feed
// exactly as feared and DASHBOARD=window is the fix.
//
// DASHBOARD=window puts it in its own window of the same browser; DASHBOARD=os
// uses your default browser; OPEN_DASHBOARD=0 opens nothing.
async function openDashboard(url, feed = null) {
  const place = feed?.place ?? sideBySide(config.windowMonitor);
  // Side by side needs two windows, so a known screen makes 'window' the
  // default. Without one there is nothing to place and a tab is tidier.
  const how = process.env.DASHBOARD || (place ? 'window' : 'tab');
  if (process.env.OPEN_DASHBOARD === '0') return;
  if (how === 'os' || !feed?.context) { openInDefaultBrowser(url); return; }

  try {
    if (how === 'window') {
      // Target.createTarget is the only way to ask Chromium for a new WINDOW;
      // context.newPage() always gives a tab in the existing one.
      const anchor = feed.page ?? feed.context.pages()[0];
      if (!anchor) throw new Error('no page to attach a CDP session to');
      const cdp = await feed.context.newCDPSession(anchor);
      const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
      if (place) {
        // Chromium opens the new window offset from the old one; move it.
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await cdp.send('Browser.setWindowBounds', { windowId, bounds: place.right });
        } catch (e) {
          log(`dashboard window opened but could not be placed (${e.message})`);
        }
      }
      await cdp.detach().catch(() => {});
      await anchor.bringToFront().catch(() => {});
      log(place
        ? `dashboard placed beside the table on the ${place.monitor.width}x${place.monitor.height} screen`
        : 'dashboard opened in its own window of the table browser');
      return;
    }
    const tab = await feed.context.newPage();
    await tab.goto(url).catch(() => {});
    // Leave the table in front: you should not have to click back to see cards.
    await (feed.page ?? feed.context.pages()[0])?.bringToFront().catch(() => {});
    log('dashboard opened as a tab in the table browser');
  } catch (e) {
    log(`could not open the dashboard in the table browser (${e.message}) — using the default browser`);
    openInDefaultBrowser(url);
  }
}

server.listen(config.port, () => {
  log(`dashboard: http://localhost:${config.port}`);
  // Live runs wait until the browser exists, so the dashboard can go into it;
  // a replay has no browser of its own.
  if (REPLAY) openDashboard(`http://localhost:${config.port}`);
  log(`mode: ${REPLAY ? `replay x${SPEED}` : 'live'}${RECORD ? ' + recording' : ''}`);
  if (sessionPath) log(`session log: ${sessionPath}`);
});

setInterval(broadcast, 250);

// --------------------------------------------------------------- sources ---

if (REPLAY) {
  const files = replayFiles();
  if (!files.length) {
    console.error('--replay needs at least one .ndjson file');
    process.exit(1);
  }
  log(`replaying ${files.length} file(s) at ${SPEED}x`);

  (async () => {
    for (const file of files) {
      log(`--- ${path.basename(file)}`);
      const rl = readline.createInterface({
        input: readStream(file),
        crlfDelay: Infinity,
      });
      let prevT = null;
      for await (const line of rl) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.d !== 'recv' || typeof rec.p !== 'string') continue;

        // Pace against the capture's own timestamps so phase countdowns and
        // round rhythm look like a real session.
        if (prevT != null) {
          const wait = Math.min(2000, (rec.t - prevT) / SPEED);
          if (wait > 1) await new Promise((r) => setTimeout(r, wait));
        }
        prevT = rec.t;

        let msg;
        try { msg = JSON.parse(rec.p); } catch { continue; }
        for (const m of Array.isArray(msg) ? msg : [msg]) observe(m, Date.now());
      }
    }
    log('replay finished — dashboard is showing the final state.');
  })();
} else {
  const { attachFeed } = await import('./feed/attach.js');
  let feed;
  try {
    feed = await attachFeed({
      onFrame: RECORD ? recordFrame : undefined,
      onMessage(msg, ts) { observe(msg, ts); recordMessage(msg); },
      onSocket(event, url) {
        if (event === 'open') log(`websocket open: ${url}`);
        if (event === 'closed') {
          socketDropped = true;
          log(`websocket CLOSED — marking shoe untrusted: ${url}`);
        }
        if (event === 'ignored') log(`ignored: ${url}`);
      },
    });
  } catch (e) {
    console.error(`\n${e.message}\n`);
    // The recording file is opened before we attach, so a failed attach would
    // otherwise litter data/ with zero-byte captures.
    if (feedOut) { feedOut.end(); try { fs.unlinkSync(feedPath); } catch { /* already gone */ } }
    process.exit(1);
  }
  log(`attached (${feed.mode}) — open the blackjack table if it isn't already.`);
  await openDashboard(`http://localhost:${config.port}`, feed);
  if (RECORD) log(`recording raw feed to ${feedPath}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    tracker.finish();
    finishRecording();
    await feed.close();
    shutdownPlay();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
