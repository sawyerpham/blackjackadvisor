// Tracker state -> a decision you can act on. Advisory only.
//
// Selective play: watch from outside, sit only on a positive shoe, stand up
// rather than idle. Standing up is what sidesteps kickoutAfterIdleGames: 3.

import { RANKS, parseCard } from '../feed/tracker.js';
import { advantage, trueCount, runningCount, cardsLeft, rankSkew } from '../engine/ev.js';
import { dealerOutcomes, insuranceEdge } from '../engine/dealer.js';
import { playAdvice } from '../engine/play.js';

// The dealer recursion costs a few ms and only changes when a card is dealt.
let dealerMemo = { key: null, value: null };
function dealerView(remaining, upcard, dealt) {
  if (!upcard) return null;
  const key = `${upcard}|${dealt}`;
  if (dealerMemo.key === key) return dealerMemo.value;
  const outcomes = dealerOutcomes(remaining, [upcard]);
  const value = { upcard, bust: outcomes.bust, outcomes };
  dealerMemo = { key, value };
  return value;
}

export const ACTIONS = {
  OUT: 'OUT',          // not seated, count is not worth joining
  SIT: 'SIT',          // not seated, count is good — take a seat and bet
  STAY: 'STAY',        // seated, count still good — keep betting
  LEAVE: 'LEAVE',      // seated, count has gone — stand up
  WAIT: 'WAIT',        // can't advise (untrusted shoe, or mid-round)
};

// The composition means something only if we watched from a clean reshuffle
// with no gap; otherwise say so rather than report a wrong edge.
export function trustState(tracker, { socketDropped, manualUntrust } = {}) {
  // For what the feed cannot report: a misdeal, a misread card, a hand played
  // off-camera. Only ever moves in the safe direction; clears at the reshuffle.
  if (manualUntrust) {
    return { trusted: false, reason: 'marked untrusted by you — clears at the next reshuffle' };
  }
  if (socketDropped) {
    return { trusted: false, reason: 'socket dropped — shoe history has a hole' };
  }
  if (!tracker.shoe.startedClean) {
    return { trusted: false, reason: 'joined mid-shoe — waiting for next reshuffle' };
  }
  if (tracker.warnings.length > 0) {
    return { trusted: false, reason: `${tracker.warnings.length} dedup warning(s)` };
  }
  return { trusted: true, reason: 'watched from a clean reshuffle' };
}

// In units of the table minimum: rises with edge, capped.
export function betUnitsFor(adv, cfg) {
  if (adv <= 0) return 0;
  const units = Math.round(adv / cfg.advantagePerUnit);
  return Math.max(1, Math.min(cfg.betCap, units));
}

// Deal order, which is also alphabetical. A is first base, at a seated player's
// right, so the dashboard mirrors this array by default.
export const SEATS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

// Null until the MAIN bet settles — the only wager that waits for the dealer.
// A push (0) is a result, not a gap.
export function settledResult(entry) {
  if (!entry || !entry.done) return null;
  if (entry.net > 0) return 'win';
  if (entry.net < 0) return 'loss';
  return 'push';
}

function tablePicture(tracker) {
  const dealingTo = (tracker.dealingSequence || []).map((d) => String(d).split('-')[0]);
  const seats = SEATS.map((seat) => {
    const hands = tracker.lastPlayerHands[seat] || null;
    // Who the table is waiting on. dealingSequence is empty in most messages.
    const acting = tracker.lastSeatActive?.[seat] || [];
    const occupied = tracker.occupiedSeats.has(seat) || hands != null;
    return {
      seat,
      occupied,
      // Gated on occupancy: tracker.seatNames never forgets a departed player,
      // so ungated it leaves the last occupant's name on an empty chair.
      name: occupied ? (tracker.seatNames?.[seat] || null) : null,
      mine: tracker.mySeat === seat,
      dealing: dealingTo.includes(seat),
      acting: acting.includes(true),
      activeHand: acting.indexOf(true) < 0 ? null : acting.indexOf(true),
      result: settledResult(tracker.roundNet?.[seat]),
      // Per hand, in the order the hands are drawn. A split can win one half and
      // lose the other, which `result` — their sum — reports as a push.
      handResults: Array.from(tracker.handNet?.[seat] || [], settledResult),
      hands: hands || [],
      scores: tracker.lastSeatScores[seat] || [],
    };
  });
  return {
    seats,
    dealer: {
      cards: (tracker.lastDealerCards || []).slice(),
      score: tracker.lastDealerScore || 0,
      dealing: dealingTo.includes('Dealer'),
      acting: tracker.lastDealerActive === true,
    },
  };
}

// Skips "**" — an unshown card cannot be evaluated. After a split,
// dealingSequence ("C-Second") names which hand the table is waiting on.
function ourHand(tracker) {
  const seat = tracker.mySeat;
  if (!seat) return null;
  const hands = tracker.lastPlayerHands[seat];
  if (!Array.isArray(hands) || !hands.length) return null;

  let idx = 0;
  for (const step of tracker.dealingSequence || []) {
    const [who, which] = String(step).split('-');
    if (who !== seat) continue;
    if (which === 'Second') idx = 1;
    else if (which === 'Third') idx = 2;
    break;
  }
  const cards = (hands[idx] || []).filter((c) => parseCard(c));
  return { index: idx, cards: cards.map((c) => parseCard(c).rank), splitsTaken: hands.length - 1 };
}

// From active:true. dealingSequence would blink off between cards.
function actingHand(tracker) {
  for (const seat of SEATS) {
    const flags = tracker.lastSeatActive?.[seat];
    if (!Array.isArray(flags)) continue;
    const index = flags.indexOf(true);
    if (index < 0) continue;

    const hands = tracker.lastPlayerHands[seat] || [];
    const cards = hands[index] || [];
    if (cards.length < 2 || !cards.every((c) => parseCard(c))) return null;
    return {
      seat,
      index,
      cards,
      ranks: cards.map((c) => parseCard(c).rank),
      splitsTaken: hands.length - 1,
    };
  }
  return null;
}

const TENS = ['T', 'J', 'Q', 'K'];

// Aces count 11 while that fits.
export function handTotal(ranks) {
  let total = 0;
  let aces = 0;
  for (const r of ranks) {
    if (r === 'A') { aces += 1; total += 11; }
    else total += TENS.includes(r) ? 10 : Number(r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

// Over 21 there is nothing to decide, but the engine still reports "stand".
const BUSTED = { action: 'bust', ev: {}, isBlackjack: false, margin: 0, thinking: false };

export function advise(tracker, cfg, { socketDropped = false, manualUntrust = false, now = Date.now() } = {}) {
  const decks = cfg.decks;
  const shoe = tracker.shoe;
  const remaining = tracker.remaining(decks);
  const left = cardsLeft(remaining);
  const dealt = shoe.cards.length;

  const trust = trustState(tracker, { socketDropped, manualUntrust });
  const adv = advantage(remaining, decks);
  const tc = trueCount(remaining, decks);
  const rc = runningCount(remaining, decks);
  const seated = tracker.mySeat != null;

  // timeRemainingMs is a snapshot from arrival, so subtract elapsed wall time.
  let bettingMsLeft = null;
  if (tracker.phase === 'Betting' && tracker.timeRemainingMs != null && tracker.phaseAt != null) {
    bettingMsLeft = Math.max(0, tracker.timeRemainingMs - (now - tracker.phaseAt));
  }

  const cardsBeforeCut = Math.max(0, cfg.expectedCutCard - dealt);
  const shoeNearlyDone = cardsBeforeCut < cfg.minCardsToSit;

  // A warning only: this round is still dealt off the counted stub, so the edge
  // is real. Everything after the reshuffle is not.
  const shoeSpent = shoe.cutSeenAtCard != null;

  let action;
  let why;
  if (!trust.trusted) {
    action = seated ? ACTIONS.LEAVE : ACTIONS.WAIT;
    why = trust.reason;
  } else if (seated) {
    if (adv < cfg.leaveAdvantage) {
      action = ACTIONS.LEAVE;
      why = `edge ${(adv * 100).toFixed(2)}% is below leave threshold`;
    } else {
      action = ACTIONS.STAY;
      why = `edge ${(adv * 100).toFixed(2)}% still positive`;
    }
  } else if (shoeNearlyDone) {
    action = ACTIONS.OUT;
    why = `only ~${cardsBeforeCut} cards before the cut card`;
  } else if (adv >= cfg.sitAdvantage) {
    action = ACTIONS.SIT;
    why = `edge ${(adv * 100).toFixed(2)}% — take a seat`;
  } else {
    action = ACTIONS.OUT;
    why = `edge ${(adv * 100).toFixed(2)}% below sit threshold`;
  }

  const betUnits = (action === ACTIONS.SIT || action === ACTIONS.STAY)
    ? betUnitsFor(adv, cfg) : 0;
  const betFeed = Math.min(betUnits * cfg.minBet, cfg.maxBet);

  // What to bet if you play anyway. Never zero.
  const betIfPlaying = Math.max(1, betUnitsFor(adv, cfg));
  const betIfPlayingFeed = Math.min(betIfPlaying * cfg.minBet, cfg.maxBet);

  // "**" parses to null and is ignored.
  const upRaw = tracker.lastDealerCards.find((c) => parseCard(c));
  const upcard = upRaw ? parseCard(upRaw).rank : null;
  const dealer = dealerView(remaining, upcard, dealt);

  // Exact ten-density of what remains. At 2:1, profitable above one third.
  const ins = insuranceEdge(remaining);
  const insurance = upcard === 'A'
    ? { ...ins, offered: true }
    : { ...ins, offered: false };

  const hand = ourHand(tracker);
  const play = !(hand && hand.cards.length >= 2 && upcard && cfg.rules) ? null
    : handTotal(hand.cards) > 21 ? BUSTED
    : playAdvice({
        cards: hand.cards,
        dealerUpcard: upcard,
        remaining,
        rules: { ...cfg.rules, decks },
        splitsTaken: hand.splitsTaken,
      });

  // The best play for EVERY seat holding cards, so the felt can label each hand
  // rather than only whoever is on the clock. Your own seat is skipped — its
  // advice is `play` above.
  //
  // Cheap despite the seat count: play.js caches on (hand, upcard, exact shoe),
  // so a seat is recomputed only when a card actually moves.
  const table = tablePicture(tracker);
  if (upcard && cfg.rules) {
    for (const st of table.seats) {
      if (!st.occupied || st.mine) continue;
      // The hand being played, or the first if the seat is not acting.
      const cards = (st.hands[st.activeHand ?? 0] || []).filter((c) => parseCard(c));
      if (cards.length < 2) continue;
      const ranks = cards.map((c) => parseCard(c).rank);
      st.advice = handTotal(ranks) > 21 ? BUSTED : playAdvice({
        cards: ranks,
        dealerUpcard: upcard,
        remaining,
        rules: { ...cfg.rules, decks },
        // Same derivation ourHand() uses, so a seat that has split is not
        // offered a double it cannot take.
        splitsTaken: st.hands.length - 1,
      });
    }
  }

  // Off while seated — the engine belongs to your own hand then. Same rule as
  // grades.js.
  const acting = seated ? null : actingHand(tracker);
  const onClock = (acting && upcard && cfg.rules)
    ? {
        seat: acting.seat,
        name: tracker.seatNames?.[acting.seat] || null,
        // Records which hand the advice is for. gradetest.js checks it.
        cards: acting.cards,
        handIndex: acting.splitsTaken ? acting.index : null,
        advice: handTotal(acting.ranks) > 21 ? BUSTED : playAdvice({
          cards: acting.ranks,
          dealerUpcard: upcard,
          remaining,
          rules: { ...cfg.rules, decks },
          splitsTaken: acting.splitsTaken,
        }),
      }
    : null;

  return {
    action,
    why,
    seated,
    mySeat: tracker.mySeat,
    trusted: trust.trusted,
    trustReason: trust.reason,

    advantage: adv,          // true worth of what is left in the shoe
    shoeSpent,               // cut card is out: this is the shoe's last round
    sitAdvantage: cfg.sitAdvantage,   // the bar, for the dashboard to name
    trueCount: tc,                      // Hi-Lo tagged; display only
    runningCount: rc,
    betUnits,                           // what you act on: N x table minimum
    betFeed,
    betDisplay: betFeed / cfg.displayDivisor,

    // What to bet if you are playing anyway. Never zero.
    betIfPlaying,
    betIfPlayingDisplay: betIfPlayingFeed / cfg.displayDivisor,

    dealt,
    cardsLeft: left,
    decksLeft: left / 52,
    shoeIndex: shoe.index,
    rounds: shoe.rounds.length,
    cutSeenAtCard: shoe.cutSeenAtCard,
    expectedCutCard: cfg.expectedCutCard,
    cutReached: shoe.cutSeenAtCard != null,

    phase: tracker.phase,
    bettingMsLeft,
    occupiedSeats: [...tracker.occupiedSeats].sort(),
    table,

    play,
    onClock,                            // spectating only

    dealerUpcard: upcard,
    dealerBust: dealer ? dealer.bust : null,
    insurance,

    remaining,
    skew: rankSkew(remaining, decks),
    ranks: RANKS,

    warnings: tracker.warnings.length,
    tableName: tracker.tableSettings?.tableName || null,
  };
}
