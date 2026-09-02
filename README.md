# blackjack-advisor

Tracks the exact remaining composition of a live blackjack shoe from the game
client's own websocket feed, and advises when to sit, when to leave, how much to
bet, how to play the hand, and which players are worth betting behind.

No computer vision — the client already receives every card as a plain string,
for every seat, whether or not you are seated, and it arrives before the video.

> **Advisory only.** Nothing here sends a click, keystroke, or request to the
> casino. It reads and displays; you act. Software assistance almost certainly
> violates the site's terms of service; the realistic downside is account
> closure and confiscation of funds.

## Requirements

Node.js **22.6+** (24.x recommended). The code imports a TypeScript file
directly and relies on Node's built-in type stripping, so there is no build
step.

## Quick start

```bash
npm install                              # also fetches the Edge binary
cp local.config.example.js local.config.js
npm test                                 # six gates, all must print PASS
npm run live                             # dashboard on http://localhost:8080
```

`npm run live` opens a dedicated browser at your table and the dashboard as a
second tab in that same browser, with the table left in front. Log in at the
table by hand if you want to play; tracking works logged out, because the feed
streams to spectators. `Ctrl-C` stops it.

The browser is launched with Chromium's background-throttling disabled, so the
table tab keeps its timers at full rate while you read the dashboard — measured,
not assumed. `DASHBOARD=window` puts the dashboard in its own window of the
same browser, `DASHBOARD=os` uses your default browser, and
`OPEN_DASHBOARD=0` opens nothing.

If `npm install` cannot fetch the browser, run `npx playwright install msedge`
later.

## Configuration

The repo names no casino. `local.config.js` is gitignored and is the only file
that says where you play:

```js
export default {
  tableUrl: 'https://example.com/live-blackjack',   // the table page
  allowWs:  'example\\.com',                        // only read these sockets
  ignoreWs: '/ws/chat/|/video/',                    // never read these
};
```

Each field can also be set via `TABLE_URL`, `ALLOW_WS`, `IGNORE_WS`, which take
precedence. `allowWs` matters most in `cdp` mode, where the app attaches to a
browser you are also using.

`src/config.js` holds units, ramp, thresholds and the table's playing rules —
decks, S17/H17, blackjack payout, double and split restrictions. Check them
against your own table before trusting any hit/stand advice.

One rule is not a simple flag: this table peeks for blackjack on an ace but not
on a ten, so `rulesForUpcard()` in `src/engine/play.js` narrows the engine's
single `dealerPeeks` boolean per upcard. If your table peeks on both, or on
neither, that is the function to change.

## Commands

| command | what it does |
|---|---|
| `npm run live` | Opens its own browser, watches the table, advises, records the feed. |
| `npm start` | Same, without writing a capture file. |
| `npm run replay` | Dashboard driven by a saved capture. No browser, no casino. |
| `npm run capture` | Record only, no dashboard. Stops after two complete shoes. |
| `npm run overnight` | Record only, unattended, timestamped heartbeat. |
| `npm run analyze` | Penetration, table settings, seated/spectating diff. |
| `npm run rate` | How often the shoe was actually worth playing. |
| `npm run edge` | `cdp` fallback only — browser with a debugging port. |
| `npm test` | The six gates. All must print PASS. |

Run only one of `live`, `start`, `replay` at a time — they share port 8080. And
**never run `live` and a capture together**: two processes attaching to one
browser break each other's shoe tracking (`--record` on `src/server.js` exists
so one attach can do both). `analyze`, `rate` and `test` read files only.

`replay` needs a capture first; `data/` is gitignored and ships empty.

### Tests

| gate | checks |
|---|---|
| `test/selftest.js` | the shoe tracker recovers an exact known composition |
| `test/evtest.js` | the advantage model against published benchmarks |
| `test/dealertest.js` | the dealer engine against published probabilities |
| `test/playtest.js` | playing advice against a published basic-strategy chart |
| `test/sidebettest.js` | side-bet EV against closed-form combinatorics |
| `test/gradetest.js` | player grading, bet-behind sizing, spectator-only rules |

No browser, network or casino needed.

### If the site's bot-check rejects the automated browser

```bash
npm run edge          # browser with a debugging port on 9222
ATTACH=cdp npm run live
```

This leaves an unauthenticated debugging port open on a browser holding your
real session, so `launch` is the default.

## Reading the dashboard

**Headline** — `OUT` (not seated, count not worth joining), `SIT` (not seated,
count is good), `STAY` (seated, still positive), `LEAVE` (seated, edge gone),
`WAIT` (can't advise). Once you have cards it switches to the play for that hand
— HIT, STAND, DOUBLE, SPLIT — and the table advice moves to the line below.

**UNTRUSTED suppresses all betting advice.** The shoe has a hole in it: you
joined mid-shoe, or the socket dropped and may not have replayed shoe history.
It clears at the next reshuffle. The button beside it marks a shoe untrusted by
hand — a misdeal, a misread card, a hand played off camera — with no way back.

**CUT CARD OUT** means the shoe is dealing its last round. The count still holds
for that round; what dies is everything after the reshuffle.

**The felt** shows every seat's cards as the app reads them, so you can check
them by eye — a wrong card here is a wrong count. Seats are drawn in deal order;
`flip left/right` mirrors the view. The seat on the clock is outlined in amber,
a bust in red, and the settled result in green or red until the next round
starts dealing. While you are not seated, the top-left corner also shows the
best play for whoever is up, from the same engine that advises your own hand.

**Bet behind** names which seats to back and for how much, when no seat is free
but the shoe is worth money. Each line shows the whole calculation:

```
shoe +2.18% − 1.41% they misplay = +0.77% to you · from 13 decisions
```

You inherit a backed player's decisions, so the EV they give up is EV you give
up. Their rate is taken at face value however thin the sample, and the decision
count is shown so you can judge it. Seats are also correlated (r = 0.400,
measured on 5,658 real seat-pairs), so each extra seat gets a smaller stake.
Expect small numbers on several seats rather than your full ramp on each.

**How the table is playing** scores every occupied seat's decisions against the
exact remaining shoe. Read the cost, not just the percentage: `14/17 best ·
0.111u each` and `14/17 best · 0.012u each` are the same accuracy and not the
same player. Sorting is **as seated** or **by confidence**, so 5-for-5 does not
outrank 76-for-85. Real players run 78–94%.

All three spectator panels switch off the moment you sit down.

**Bets are in units.** One unit is the table minimum; there is no bankroll
setting, because choosing your unit already fixes that scale. The
feed talks in hundredths of the displayed amount (1000 in the feed = 10 on
screen = 1u). Ramp, from `src/config.js`: `+0.5% -> 2u`, `+1.0% -> 4u`,
`+1.5% -> 6u`, `+2.0% -> 8u`, capped at 12u.

**Edge** is the true worth of what is left in the shoe. A neutral shoe reads
about −0.50% — the house edge off the top — so `+0.30%` means you really are
ahead. True count is Hi-Lo, a sanity readout only; nothing decides anything from
it.

### Glossary

Every number is either money or a fraction of your bet. Mixing the two up is the
only way any of it gets confusing.

- **unit**, **`u`** — the table minimum. Only ever a bet size.
- **edge** — what the shoe is worth per unit wagered.
- **cost** — what a player's own decisions give away, on the same scale:
  `net = edge − cost`. Averaged over every graded decision, so it fuses how
  *often* someone errs with how *badly*.
- **`45/49 best`, `92%`** — how often someone played best. A frequency, not
  money. A 92% player whose misses are catastrophes costs more than a 76% player
  whose misses are coin-flips, which is why bet-behind ranks on cost.

```
shoe edge                    +1.50%
their cost                   -0.68%
net to you                   +0.82%   -> clears the +0.50% bar
/ 0.25% per unit          =    3.3u
x 10 on screen per unit   =      33   <- what you type in
```

## Recording and analysis

```bash
npm run overnight > data/overnight.log 2>&1
```

`--overnight` swaps the status bar for a heartbeat every five minutes: uptime,
complete shoes, current shoe, file size, socket drops. An idle table still sends
pings, so *no cards* at 6am is normal and gets a quiet note; *no frames at all*
means the page closed and gets a loud warning. Capture resumes on its own.

Captures go to `data/`, which is gitignored. Session tokens in URLs are redacted
before anything touches disk.

Captures are written uncompressed and can be gzipped afterwards — they are
repetitive JSON and shrink about 14x. `gzip data/feed-*.ndjson` is all it takes:
every reader gunzips transparently, and a `feed-*.ndjson` argument or glob still
matches the `.gz`, so nothing above changes.

Capture also records the *shape* of every message tagged by whether you were
seated, and diffs the two on exit — catching new fields on existing message
types, not just new types. `tools/analyze.js` prints the same report from
any file.

Live runs additionally write `data/session-<stamp>.ndjson`: one row per betting
decision, per shoe, and per action change. No money is configured, but settled
wagers are parsed for every seat, so realized returns are observable.

## Is it worth playing?

Measure your own table first. The number that decides it is **penetration** —
how deep into the shoe the cut card sits.

```bash
npm run capture     # stops itself after two complete shoes
npm run analyze
```

- under 55% → no edge exists, whatever else you do
- 55–68% → marginal; variance and idle-kickout rules likely eat it
- over 68% → worth continuing

On the table this was built against, penetration measured **52.6% over 35
complete shoes** — below the floor. Selective play still produced a genuine
**+0.664%** edge, but throughput killed it: ~14.6 played hands an hour, and
roughly 15,000 hours before you could be 95% confident you were ahead. Betting
more does not shorten that; it only scales what is at risk while you wait.

Your table may differ. That is the point of measuring it.

## Layout

```
src/
  server.js       live or replay -> SSE -> dashboard, plus the session log
  config.js       units, ramp, thresholds, table rules. The only file to tune
  feed/           talking to the casino
    attach.js     browser -> parsed game messages. Socket filtering and token
                  redaction, nothing else
    tracker.js    messages -> exact shoe composition, phase, seats, wagers
    schema.js     records the shape of every message type seen, seated vs not
  engine/         game mathematics, no I/O
    ev.js         composition -> player advantage (effect-of-removal)
    dealer.js     composition + upcard -> exact dealer outcomes and insurance
    sidebets.js   pair and 21+3 EV, closed form
    play.js       adapter to the playing engine: rank buckets, cache, worker
    play-worker.js  runs the engine off the main thread
  advice/         decisions built on the engine
    advisor.js    tracker + config -> SIT/STAY/LEAVE/OUT/WAIT, bet, trust, and
                  the playing decision for your own hand
    grades.js     scores every other player's decisions
    behind.js     which seats to back and for how much
  util/paths.js   project-root anchor for data/ and the browser profiles
tools/            offline command-line utilities
  edge.js         launches Edge with a debugging port (cdp fallback)
  capture.js      record the feed to disk, no dashboard
  analyze.js      penetration and message-shape report from a capture
  rate.js         how often a shoe was actually worth playing
test/             the six gates. No browser, network or casino needed
ui/index.html     the dashboard. One file, no build step
vendor/
  blackjack-engine.ts   third party, unmodified. Composition-dependent EV of
                  every legal action. Fix upstream and re-copy; never edit here
data/             captures and session logs. Gitignored, ships empty
```

The dependency direction is one-way: `feed` knows nothing about advice, `engine`
knows nothing about the feed's wire format, and `advice` composes both. `tools/`
and `test/` import from `src/`; nothing in `src/` imports from them.
