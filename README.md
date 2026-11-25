# blackjack-advisor

Tracks the exact composition of a live blackjack shoe from the game client's
websocket feed (no computer vision) and advises when to sit or leave, how much
to bet, how to play the hand, and which players to bet behind.

> **Advisory only.** Nothing is sent to the casino. It reads and displays; you act.

## Quick start

Needs Node.js 22.6+ (TypeScript is imported directly, no build step).

```bash
npm install                                    # also fetches Edge
cp local.config.example.js local.config.js     # set tableUrl, allowWs, ignoreWs
npm test                                       # six gates, all must PASS
npm run live                                   # dashboard on http://localhost:8080
```

`src/config.js` holds bet ramp, thresholds and table rules; check them against
your table. This one peeks on an ace but not a ten (`rulesForUpcard()` in
`src/engine/play.js`).

## Commands

| command | what it does |
|---|---|
| `npm run live` | Watch, advise and record |
| `npm start` | Same, without recording |
| `npm run replay` | Dashboard from a saved capture, no casino |
| `npm run capture` / `overnight` | Record only |
| `npm run analyze` / `rate` | Penetration and how often a shoe was worth playing |
| `npm run edge` | Fallback if the bot check blocks: then `ATTACH=cdp npm run live` |

Run only one of `live`, `start`, `replay` or a capture at a time. The `edge`
fallback leaves an unauthenticated debugging port open on your logged-in browser.

## Reading the dashboard

- **OUT / SIT / STAY / LEAVE / WAIT**: whether to be at the table. With cards,
  it shows HIT, STAND, DOUBLE or SPLIT.
- **UNTRUSTED**: the shoe was only partly seen; betting advice is off until reshuffle.
- **Edge**: worth of the remaining shoe (neutral is about −0.50%).
- **u**: one unit, the table minimum.
- **Bet behind**: shoe edge minus that player's mistake cost.

## Is it worth playing?

Measure penetration first (`npm run capture`, then `npm run analyze`): under 55%
there is no edge, 55–68% is marginal, over 68% is worth continuing.

The table this was built on measured **52.6% over 35 shoes**. Selective play
still gave a +0.664% edge, but at ~14.6 hands an hour it would take about 15,000
hours to be 95% confident of being ahead.

## Tests

No browser, network or casino needed. The six gates check shoe tracking,
advantage model, dealer probabilities, basic strategy, side-bet EV and player
grading against known compositions, published figures and closed-form maths.

## Layout

```
src/feed/    websocket messages -> shoe, seats, wagers (session tokens redacted)
src/engine/  game maths, playing EV in a worker thread
src/advice/  decisions built on the two above
src/server.js, ui/index.html   server-sent events -> single-file dashboard
tools/ test/ vendor/           CLI utilities, tests, vendored EV engine
data/                          captures and logs, gitignored
```
