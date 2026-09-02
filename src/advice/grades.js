// Scores other players' decisions against the same engine that advises your own
// hand. Runs seated as well as spectating.
//
// Your OWN seat is excluded throughout — grading and money both. Your rounds
// landing in decisionsPerHand() with no graded decisions beside them would
// deflate costPerHand for everyone and under-size every bet-behind.
//
// bj.Hands carries decision.lastDecision, so no action is inferred from cards.
// But the decision is published one message BEFORE the card it produces:
//
//   h0[5S,8C]=13    Made/Hit@681682    decision, cards not yet updated
//   h0[5S,8C,2C]=15 Made/Hit@681682    the card it produced
//
// So the first sighting of a new timestamp is the pre-decision position.

import { parseCard } from '../feed/tracker.js';

const ACTION_OF = { Hit: 'hit', Stand: 'stand', Double: 'double', Split: 'split' };

// Costs below this count as correct. Grading is composition-exact and will
// sometimes prefer a play no chart contains; when two actions are worth the same
// money to four decimals, neither is a mistake.
const TIE = 0.0005;

// Fallback until the session has measured its own: 193 decisions over 166 hands.
const DEFAULT_DECISIONS_PER_HAND = 1.16;

// Keyed by name, so a record follows a player between seats.
function emptyRecord(name) {
  return {
    name,
    seat: null,
    graded: 0,       // decisions actually scored
    best: 0,         // ...of which were the best play, or tied with it
    evLost: 0,       // total units given up — the number that actually matters
    pending: 0,      // out with the worker
    skipped: 0,      // unreadable position: hidden card, no upcard, dead worker
    timeouts: 0,     // clock ran out; not a choice, so not in the average
    net: 0,          // won or lost in feed units, since we started watching
    rounds: 0,       // settled main bets behind that number
    // Counted off the MAIN wager only, exactly like rounds, so the three sum to
    // it and the w/l/p line has one denominator. A split whose halves disagree
    // lands on whatever the main half did; the money is in net, which sums
    // every wager.
    won: 0,
    lost: 0,
    pushed: 0,       // stake returned — its own outcome, not half a win
    // Two sets, not one counter: side bets settle on the opening cards while the
    // main bet waits for the dealer, so every round has a window where the side
    // bet is banked and its hand is not.
    mainRounds: new Set(),
    sideRounds: new Set(),
  };
}

// A percentage weighted by the evidence behind it: 5/5 scores 0.566,
// 76/85 (89%) scores 0.810.
export function wilsonLower(successes, trials, z = 1.96) {
  if (!trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return (centre - spread) / (1 + z2 / trials);
}

// Only rounds whose main bet has settled count, or the ratio can exceed 1.
function sideRate(rec) {
  if (!rec.mainRounds.size) return null;
  let both = 0;
  for (const round of rec.sideRounds) if (rec.mainRounds.has(round)) both += 1;
  return both / rec.mainRounds.size;
}

export class Grades {
  constructor({ evaluate, rules, decks, displayDivisor = 1 }) {
    this.evaluate = evaluate;
    this.rules = rules;
    this.decks = decks;
    this.displayDivisor = displayDivisor;
    this.byName = new Map();     // name -> record
    this.seen = new Set();       // "seat|timestamp" of decisions already taken
    this.lastCards = new Map();  // "seat#index" -> cards at the previous sighting
    // How far we have read into tracker.results, which is append-only and
    // already deduped by round+seat+bet — so exactly one place decides what
    // counts as a settled wager.
    this.resultsCursor = 0;
  }

  // Pooled, to turn a per-decision cost into a per-hand one.
  decisionsPerHand() {
    let dec = 0;
    let hands = 0;
    for (const r of this.byName.values()) { dec += r.graded; hands += r.rounds; }
    return hands >= 20 ? dec / hands : DEFAULT_DECISIONS_PER_HAND;
  }

  // Must happen on arrival: results are keyed by seat, and players move seats.
  drainResults(tracker) {
    const log = tracker?.results;
    if (!Array.isArray(log)) return;
    for (; this.resultsCursor < log.length; this.resultsCursor += 1) {
      const r = log[this.resultsCursor];
      // The cursor still advances, so nothing banks up.
      if (r.seat === tracker.mySeat) continue;
      const name = tracker.seatNames?.[r.seat];
      if (!name) continue;
      const rec = this.record(name);
      // Side bets included: it is their money either way, and leaving them out
      // would flatter the players who lose most of it there.
      rec.net += r.net;
      if (r.bet === 'main') {
        rec.rounds += 1;
        // A push returns the stake for net exactly 0, so it is the middle case
        // rather than a rounding edge.
        if (r.net > 0) rec.won += 1;
        else if (r.net < 0) rec.lost += 1;
        else rec.pushed += 1;
        rec.mainRounds.add(r.round);
      }
      else rec.sideRounds.add(r.round);
    }
  }

  record(name) {
    let r = this.byName.get(name);
    if (!r) { r = emptyRecord(name); this.byName.set(name, r); }
    return r;
  }

  handle(msg, tracker) {
    // Drained on every message whether or not you are seated, so the seat map it
    // attributes through is always the current one.
    this.drainResults(tracker);
    if (msg?._t !== 'bj.Hands') return;
    const playerHands = msg.playerHands;
    if (!playerHands || typeof playerHands !== 'object') return;
    if (typeof tracker?.remaining !== 'function') return;

    // The second dealer card stays "**" until everyone has acted.
    const upRaw = (msg.dealerHand?.cards || []).find((c) => parseCard(c));
    const upcard = upRaw ? parseCard(upRaw).rank : null;

    let remaining = null;   // built once, and only if something needs grading

    for (const [seat, hands] of Object.entries(playerHands)) {
      if (!Array.isArray(hands)) continue;
      // Here rather than at the call site so a future caller cannot bypass it.
      // Worker contention is not the worry it looks like: seats act one at a
      // time, so the queue is empty by the time your own hand is on the clock.
      if (seat === tracker?.mySeat) continue;
      const splitsTaken = hands.length - 1;

      for (let i = 0; i < hands.length; i += 1) {
        const hand = hands[i];
        const d = hand?.decision;
        const cards = Array.isArray(hand?.cards) ? hand.cards : [];
        const slot = `${seat}#${i}`;
        const before = this.lastCards.get(slot) || [];
        this.lastCards.set(slot, cards.slice());

        if (!d || !d.lastDecisionTimestamp || !ACTION_OF[d.lastDecision]) continue;

        // One decision per seat per millisecond. Not decision.key: a split forks
        // it, which would count one split twice.
        const id = `${seat}|${d.lastDecisionTimestamp}`;
        if (this.seen.has(id)) continue;
        this.seen.add(id);

        const name = tracker.seatNames?.[seat] || `seat ${seat}`;
        const rec = this.record(name);
        rec.seat = seat;

        // Not a decision they made, so it stays out of the average.
        if (d.trigger === 'ExpiredDecisionTime' || d.decisionTrigger === 'ExpiredDecisionTime') {
          rec.timeouts += 1;
          continue;
        }

        // Normally this message's own cards, since the decision is published
        // first. If an update was dropped and the card is already here, the
        // previous sighting is a strict prefix and is the right position.
        const isPrefix = before.length >= 2 && before.length < cards.length &&
                         before.every((c, j) => c === cards[j]);
        const position = isPrefix ? before : cards;

        if (!upcard || position.length < 2 || !position.every((c) => parseCard(c))) {
          rec.skipped += 1;
          continue;
        }

        if (!remaining) remaining = tracker.remaining(this.decks);
        rec.pending += 1;
        this.score(rec, ACTION_OF[d.lastDecision], {
          cards: position.map((c) => parseCard(c).rank),
          dealerUpcard: upcard,
          remaining,
          rules: { ...this.rules, decks: this.decks },
          splitsTaken,
        });
      }
    }
  }

  async score(rec, played, position) {
    let out = null;
    try { out = await this.evaluate(position); } catch { out = null; }
    rec.pending -= 1;
    if (!out || !out.ev) { rec.skipped += 1; return; }

    const ev = out.ev;
    const bestEv = ev[out.best];
    // A natural offers no choice, so there is nothing to score.
    if (out.isBlackjack || Object.keys(ev).length < 2 || bestEv == null) return;

    // An unpriced action is one the rules disallow, so we misread the position
    // rather than catching an impossible play.
    const theirs = ev[played];
    if (theirs == null) { rec.skipped += 1; return; }

    const cost = Math.max(0, bestEv - theirs);
    rec.graded += 1;
    rec.evLost += cost;
    if (cost <= TIE) rec.best += 1;

  }

  // Driven by who is seated, so a departed player's stale seat never appears;
  // their record is kept in case they return. Your own seat is filtered here as
  // well as by the caller, so a future caller cannot put you back in.
  standings(liveSeats = {}, mySeat = null) {
    const perHand = this.decisionsPerHand();
    const rows = Object.entries(liveSeats)
      .filter(([seat, name]) => name && seat !== mySeat)
      .map(([seat, name]) => {
        const r = this.record(name);
        return {
          name,
          seat,
          graded: r.graded,
          best: r.best,
          // Null rather than 0 until something is scored: "0%" and "nothing yet"
          // are opposite claims about a player.
          pct: r.graded ? r.best / r.graded : null,
          // What "best first" actually sorts on. See wilsonLower above.
          score: wilsonLower(r.best, r.graded),
          evLostPerHand: r.graded ? r.evLost / r.graded : null,
          // What backing them costs you per hand, as a fraction of your own bet:
          // you inherit their decisions. At face value however few decisions are
          // behind it — `graded` is reported alongside so the sample is visible.
          costPerHand: r.graded ? (r.evLost / r.graded) * perHand : null,
          // Both side bets run about -4%, so this reads how someone sizes up a
          // wager — and every round is a sample, unlike the accuracy.
          sideRate: sideRate(r),
          net: r.net / this.displayDivisor,
          rounds: r.rounds,
          won: r.won,
          lost: r.lost,
          pushed: r.pushed,
          pending: r.pending,
          timeouts: r.timeouts,
        };
      });
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.graded - a.graded);
    return rows;
  }
}
