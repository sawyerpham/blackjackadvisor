// Casino bj.* messages -> exact shoe composition.
//
// Everything rides on the dedup rule. Hands arrive as CUMULATIVE arrays, and one
// card code legitimately appears twice in a round (two seats holding "TH"), so
// cards are deduped per (round, seat) over the multiset of that seat's cards —
// see ingestSeat below.
//
// "**" is a face-down card: never counted, counted exactly once when it flips.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const DEALER_SEAT = '_DEALER'; // distinct from player seat "D"

const CARD_RE = /^([A2-9TJQK])([SHDC])$/;

export function parseCard(s) {
  if (typeof s !== 'string') return null;
  const up = s.toUpperCase();
  const m = CARD_RE.exec(up);
  if (!m) return null; // covers "**" and any other placeholder
  return { rank: m[1], suit: m[2], code: up };
}

export function isHidden(s) {
  return typeof s === 'string' && !CARD_RE.test(s.toUpperCase());
}

// _at arrives in seconds (10 digits), ms (13) or ns (19). Normalize to ms.
export function normalizeTs(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const d = Math.abs(Math.trunc(v)).toString().length;
  if (d <= 11) return v * 1000;
  if (d <= 14) return v;
  if (d <= 17) return v / 1000;
  return v / 1e6;
}

// Wagers that settle EARLY and say nothing about how the hand went: 21+3 and
// pair on the opening cards, insurance at the peek. Kept out of the per-round
// win/loss tally the felt colours seats by.
const SIDE_BETS = new Set(['pair', '21+3', 'insurance']);

// Which hand a wager belongs to, in the order the hands are drawn. Checked
// against every split round in the captures where the two halves ended
// differently — 24 of them, all in this order, none reversed. `double` rides
// with the first hand because this table has no double after split.
const HAND_BET = { main: 0, double: 0, split: 1 };

function emptyShoe(index, startedClean, tStart) {
  return {
    index,
    startedClean,          // true only if we saw the edge that opened it
    endedClean: false,     // true only if we saw the edge that closed it
    tStart,
    tEnd: null,
    cards: [],             // ordered [{code, rank, suit, round, seat, hand, idx, ts}]
    rounds: [],
    rankCounts: Object.fromEntries(RANKS.map((r) => [r, 0])),
    codeCounts: {},
    cutSeenAtCard: null,   // cards dealt when cuttingCard fired
    burnEvents: 0,
    unknownRemoved: 0,     // cards known to have left the shoe, value never seen
  };
}

export class Tracker {
  constructor(opts = {}) {
    this.onCard = opts.onCard || null;
    this.onShoeClose = opts.onShoeClose || null;

    this.shoeIndex = 0;
    this.shoe = emptyShoe(0, false, null);
    this.shoes = [];

    // "round|seat" -> Map(code -> how many counted for this seat this round).
    // See ingestSeat for why this is a multiset and not a positional key.
    this.seen = new Map();
    this.roundKey = null;
    this.currentGameId = null;
    this.roundSeq = 0;
    this.lastDealerCards = [];

    this.prevFlags = { changeCards: false, cuttingCard: false, burnCard: false };
    this.phases = new Set();
    this.msgTypes = new Map();
    this.tableSettings = null;
    this.seatNames = {};
    this.warnings = [];

    // Live table state, for the advisor. Composition needs none of it.
    this.phase = null;
    this.timeRemainingMs = null;
    this.phaseAt = null;          // wall clock when the phase message arrived
    this.mySeat = null;
    this.occupiedSeats = new Set();

    // Live felt picture, dashboard only — the count comes from commit(). Raw
    // feed strings, "**" included, so it can be checked against the table.
    this.lastPlayerHands = {};    // seat -> array of hands, each an array of codes
    this.lastSeatScores = {};
    // Whose turn it is. The feed marks the hand the table is waiting on with
    // active:true and moves it seat by seat — a far better signal than
    // dealingSequence, which is empty in most messages.
    this.lastSeatActive = {};
    this.lastDealerActive = false;
    this.dealingSequence = [];
    this.lastDealerScore = 0;

    // Settled bets, every seat's and not just ours:
    // {round, seat, bet, amount, payout, net, resultType}. net = payout -
    // amount, so a Push (stake returned) is 0.
    this.results = [];
    this.settled = new Set();
    // seat -> {net, done}: money settled this round, and whether the main bet is
    // in. Cleared by startRound, which clears the felt marks.
    this.roundNet = {};
    // The same money split by hand. A split can win one half and lose the
    // other, and roundNet's sum cannot say so.
    this.handNet = {};
  }

  // ---- message routing -----------------------------------------------------

  handle(msg, wallTs) {
    if (!msg || typeof msg !== 'object') return;
    const t = msg._t;
    if (typeof t !== 'string') return;
    this.msgTypes.set(t, (this.msgTypes.get(t) || 0) + 1);
    // Wall clock, not the feed's _at — the betting countdown is compared against
    // Date.now(), and replaying a capture must not skew it.
    this.lastWallTs = wallTs ?? Date.now();

    const ts = normalizeTs(msg._at) ?? wallTs ?? Date.now();

    switch (t) {
      case 'bj.Game':
        this.handleGame(msg, ts);
        break;
      case 'bj.PlayerTableState':
        this.handleTableState(msg, ts);
        break;
      case 'bj.Hands':
        this.ingestHands(msg.dealerHand, msg.playerHands, ts, msg.gameId, msg.dealingSequence);
        break;
      case 'bj.Seats':
        this.handleSeats(msg, wallTs);
        break;
      case 'bj.PlayerChips':
        this.handleChips(msg);
        break;
      default:
        break;
    }
  }

  // Occupancy and, critically, whether WE are seated — the advisor needs to know
  // whether it is telling you to sit down or to stand up.
  handleSeats(msg, wallTs) {
    if (!msg.seats || typeof msg.seats !== 'object') return;
    this.occupiedSeats = new Set(Object.keys(msg.seats));
    this.mySeat = null;
    for (const [seat, v] of Object.entries(msg.seats)) {
      if (v && typeof v.name === 'string') this.seatNames[seat] = v.name;
      if (v && v.mySeat === true) this.mySeat = seat;
    }
  }

  // A bet appears first as {amount, status:'pending'} and later gains
  // {resultType, payout}. The settled message repeats, so each wager is recorded
  // once, keyed by round + seat + bet type.
  handleChips(msg) {
    if (!msg.chips || typeof msg.chips !== 'object') return;
    for (const [seat, bets] of Object.entries(msg.chips)) {
      if (!bets || typeof bets !== 'object') continue;
      for (const [bet, v] of Object.entries(bets)) {
        if (!v || typeof v !== 'object') continue;
        if (typeof v.resultType !== 'string' || typeof v.payout !== 'number') continue;
        const key = `${this.roundKey}|${seat}|${bet}`;
        if (this.settled.has(key)) continue;
        this.settled.add(key);
        const amount = typeof v.amount === 'number' ? v.amount : 0;
        this.results.push({
          round: this.roundKey,
          shoe: this.shoe.index,
          seat,
          bet,
          amount,
          payout: v.payout,
          net: v.payout - amount,
          resultType: v.resultType,
        });
        // Summed rather than read off one `resultType`, so a split or a double
        // lands as one verdict for the seat whatever the feed names the extra
        // wagers.
        if (!SIDE_BETS.has(bet)) {
          const e = this.roundNet[seat] ?? (this.roundNet[seat] = { net: 0, done: false });
          e.net += v.payout - amount;
          // The main bet cannot settle until the dealer has drawn, so it is the
          // signal the hand is over. The SIDE_BETS list alone is not enough: any
          // new early-settling type would mark a live seat won or lost.
          if (bet === 'main') e.done = true;

          // And again per hand, by the same rule — `main` closes the first hand,
          // `split` the second; a double settles with its hand, not ahead of it.
          const idx = HAND_BET[bet];
          if (idx != null) {
            const hands = this.handNet[seat] ?? (this.handNet[seat] = []);
            const h = hands[idx] ?? (hands[idx] = { net: 0, done: false });
            h.net += v.payout - amount;
            if (bet === 'main' || bet === 'split') h.done = true;
          }
        }
      }
    }
  }

  myResults() {
    if (!this.mySeat) return [];
    return this.results.filter((r) => r.seat === this.mySeat);
  }

  notePhase(msg) {
    if (typeof msg.phase === 'string' && msg.phase !== this.phase) {
      this.phase = msg.phase;
      this.phaseAt = this.lastWallTs;
      this.timeRemainingMs = null;
    }
    if (typeof msg.timeRemainingMs === 'number') {
      this.timeRemainingMs = msg.timeRemainingMs;
      this.phaseAt = this.lastWallTs;
    }
  }

  handleGame(msg, ts) {
    this.notePhase(msg);
    if (typeof msg.phase === 'string') this.phases.add(msg.phase);
    if (msg.gameId) this.noteGameId(msg.gameId, ts);

    // Edge detection: flags stay true across repeated messages.
    const flags = ['changeCards', 'cuttingCard', 'burnCard'];
    for (const f of flags) {
      const now = msg[f] === true;
      const before = this.prevFlags[f];
      if (now && !before) this.onFlagRise(f, ts);
      else if (!now && before) this.onFlagFall(f, ts);
      this.prevFlags[f] = now;
    }
  }

  onFlagRise(flag, ts) {
    if (flag === 'changeCards') {
      this.closeShoe(ts, true);
    } else if (flag === 'cuttingCard') {
      this.shoe.cutSeenAtCard = this.shoe.cards.length;
    } else if (flag === 'burnCard') {
      this.shoe.burnEvents += 1;
    }
  }

  // changeCards is NEVER true here (141 bj.Game messages, zero rises).
  // cuttingCard is the only shoe-lifecycle signal: true at the cut card, held
  // through the last round, falling at the reshuffle. That falling edge is the
  // shoe boundary; using changeCards merged every shoe into one bucket.
  onFlagFall(flag, ts) {
    if (flag === 'cuttingCard') this.closeShoe(ts, true);
  }

  handleTableState(msg, ts) {
    this.notePhase(msg);
    if (typeof msg.phase === 'string') this.phases.add(msg.phase);
    if (msg.tableSettings) this.tableSettings = msg.tableSettings;
    if (msg.seats) {
      for (const [k, v] of Object.entries(msg.seats)) {
        if (v && typeof v.name === 'string') this.seatNames[k] = v.name;
      }
    }
    if (msg.gameId) this.noteGameId(msg.gameId, ts);
    this.ingestHands(msg.dealerHand, msg.playerHands, ts, msg.gameId, msg.dealingSequence);
  }

  // ---- round boundaries ----------------------------------------------------

  noteGameId(gameId, ts) {
    if (!gameId || gameId === this.currentGameId) return;
    // A bj.Hands for round N+1 often beats the bj.Game naming it, so dealer
    // regression opens a synthetic round. Adopt the real id in place —
    // startRound would clear `seen` and recount everything already committed.
    this.currentGameId = gameId;
    this.startRound(gameId, ts);
  }

  startRound(key, ts) {
    this.roundSeq += 1;
    this.roundKey = key || `seq-${this.roundSeq}`;
    this.seen.clear();
    this.roundNet = {};
    this.handNet = {};
    this.lastDealerCards = [];
    if (this.shoe.tStart == null) this.shoe.tStart = ts;
    this.shoe.rounds.push(this.roundKey);
  }

  // bj.Hands carries no gameId, so it can arrive for round N+1 before the
  // bj.Game announcing N+1. Dealer-hand regression is the backstop: a shorter
  // hand, or a hole card reappearing, means a new round started.
  dealerSuggestsNewRound(dealerCards) {
    const prev = this.lastDealerCards;
    if (!prev.length || !dealerCards.length) return false;
    if (dealerCards.length < prev.length) return true;
    // A hidden card where a real one was, at the SAME index. "Any hidden now,
    // none before" false-positives every round: [QS] -> [QS,"**"] is ordinary
    // dealing here, and splitting there recommitted every seat's cards.
    const shared = Math.min(prev.length, dealerCards.length);
    for (let i = 0; i < shared; i++) {
      if (isHidden(dealerCards[i]) && !isHidden(prev[i])) return true;
    }
    if (prev[0] && dealerCards[0] && !isHidden(prev[0]) && !isHidden(dealerCards[0])
        && prev[0] !== dealerCards[0]) return true;
    return false;
  }

  // ---- card ingestion ------------------------------------------------------

  ingestHands(dealerHand, playerHands, ts, gameId, dealingSequence) {
    if (gameId) this.noteGameId(gameId, ts);

    const dealerCards = Array.isArray(dealerHand?.cards) ? dealerHand.cards : [];

    if (this.dealerSuggestsNewRound(dealerCards)) {
      this.startRound(null, ts);
    }
    if (this.roundKey == null) this.startRound(gameId || null, ts);

    if (dealerCards.length) {
      this.ingestSeat(DEALER_SEAT, [{ cards: dealerCards }], ts);
      this.lastDealerCards = dealerCards.slice();
    }

    if (playerHands && typeof playerHands === 'object') {
      for (const [seat, hands] of Object.entries(playerHands)) {
        if (!Array.isArray(hands)) continue;
        this.ingestSeat(seat, hands, ts);
      }
    }

    this.noteTablePicture(dealerHand, playerHands, dealingSequence);
  }

  // Display-only mirror of the last bj.Hands, separate from ingestSeat, which is
  // a one-way ratchet — the felt has to empty out between rounds. An unoccupied
  // seat is absent from playerHands, so "no key" and "no cards yet" stay
  // distinguishable.
  noteTablePicture(dealerHand, playerHands, dealingSequence) {
    if (Array.isArray(dealingSequence)) this.dealingSequence = dealingSequence.slice();
    this.lastDealerScore = Number(dealerHand?.score) || 0;
    this.lastDealerActive = dealerHand?.active === true;

    if (!playerHands || typeof playerHands !== 'object') return;
    const hands = {};
    const scores = {};
    const active = {};
    for (const [seat, seatHands] of Object.entries(playerHands)) {
      if (!Array.isArray(seatHands)) continue;
      hands[seat] = seatHands.map((h) => (Array.isArray(h?.cards) ? h.cards.slice() : []));
      scores[seat] = seatHands.map((h) => Number(h?.score) || 0);
      active[seat] = seatHands.map((h) => h?.active === true);
    }
    this.lastPlayerHands = hands;
    this.lastSeatScores = scores;
    this.lastSeatActive = active;
  }

  // Per (round, seat) over the MULTISET of that seat's cards, not per position.
  // The collection only grows within a round, so new cards are the positive
  // delta.
  //
  // Positional keying broke on splits, where hand 0 shrinks and a new hand takes
  // the card that left it:
  //
  //   E:[AC AD] -> E:[AC][AD] -> E:[AC 6H][AD] -> E:[AC 6H][AD 2C]
  //
  // That undercounted one card and overcounted another per split. A multiset
  // makes the rearrangement a no-op. Still per seat, so two seats holding TH in
  // one round are independent and both counted.
  ingestSeat(seat, hands, ts) {
    const key = `${this.roundKey}|${seat}`;

    // "**" contributes nothing until it flips.
    const current = new Map();
    const where = new Map();
    hands.forEach((hand, handIdx) => {
      const cards = Array.isArray(hand?.cards) ? hand.cards : [];
      cards.forEach((raw, idx) => {
        const card = parseCard(raw);
        if (!card) return;
        current.set(card.code, (current.get(card.code) || 0) + 1);
        if (!where.has(card.code)) where.set(card.code, { handIdx, idx });
      });
    });

    let counted = this.seen.get(key);
    if (!counted) {
      counted = new Map();
      this.seen.set(key, counted);
    }

    for (const [code, n] of current) {
      const already = counted.get(code) || 0;
      if (n <= already) continue;          // unchanged, or a hand shrank
      const pos = where.get(code) || { handIdx: 0, idx: 0 };
      for (let i = already; i < n; i++) {
        this.commit(parseCard(code), seat, pos.handIdx, pos.idx, ts);
      }
      counted.set(code, n);
    }
  }

  commit(card, seat, handIdx, idx, ts) {
    const rec = {
      code: card.code,
      rank: card.rank,
      suit: card.suit,
      round: this.roundKey,
      seat,
      hand: handIdx,
      idx,
      ts,
    };
    this.shoe.cards.push(rec);
    this.shoe.rankCounts[card.rank] += 1;
    this.shoe.codeCounts[card.code] = (this.shoe.codeCounts[card.code] || 0) + 1;
    if (this.shoe.tStart == null) this.shoe.tStart = ts;
    this.shoe.tEnd = ts;
    if (this.onCard) this.onCard(rec, this.shoe);
  }

  // ---- shoe boundaries -----------------------------------------------------

  closeShoe(ts, clean) {
    // Nothing dealt yet, so this is already a fresh shoe. Two boundary signals
    // can land back to back (changeCards rising in the same message that drops
    // cuttingCard); don't spin the index or lose the clean-start flag.
    if (this.shoe.cards.length === 0) {
      this.shoe.startedClean = true;
      this.shoe.tStart = ts;
      return;
    }
    this.shoe.tEnd = ts;
    this.shoe.endedClean = !!clean;
    if (this.shoe.cards.length > 0) {
      this.shoes.push(this.shoe);
      if (this.onShoeClose) this.onShoeClose(this.shoe);
    }
    this.shoeIndex += 1;
    this.shoe = emptyShoe(this.shoeIndex, true, ts);
    this.seen.clear();
    this.lastDealerCards = [];
  }

  // Idempotent: shutdown can fire twice (SIGINT and context close), and a second
  // push would duplicate the in-progress shoe in the summary.
  finish(ts = Date.now()) {
    if (this.finished) return this.shoes;
    this.finished = true;
    if (this.shoe.cards.length > 0) {
      this.shoe.tEnd = ts;
      this.shoe.endedClean = false;
      this.shoes.push(this.shoe);
    }
    return this.shoes;
  }

  // Only shoes watched open to close give a real penetration number.
  completeShoes() {
    return this.shoes.filter((s) => s.startedClean && s.endedClean);
  }

  remaining(decks) {
    const out = {};
    for (const r of RANKS) out[r] = decks * 4 - (this.shoe.rankCounts[r] || 0);
    return out;
  }
}

// If one exact card (e.g. "TH") showed up 7 times, the shoe holds >= 7 decks.
export function deckLowerBound(shoe) {
  const counts = Object.values(shoe.codeCounts);
  return counts.length ? Math.max(...counts) : 0;
}

export function deckFloorFromTotal(shoe) {
  return Math.ceil(shoe.cards.length / 52);
}
