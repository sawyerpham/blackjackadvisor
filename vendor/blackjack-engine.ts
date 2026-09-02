// VENDORED, UNMODIFIED, from the author's own project:
//   https://github.com/sawyerpham/blackjackdictionary  (src/engine/blackjack-engine.ts)
//
// Keep it that way. Fixes belong upstream and get re-copied down, so the two
// copies never drift into two different answers. `playtest.js` is the gate:
// 26 published 8-deck S17 basic-strategy decisions, plus an exact cross-check
// of its dealer model against dealer.js, which dealertest.js already verifies
// against published probabilities. Both must pass after any re-copy.
//
// This is the "use a mature engine rather than hand-rolling playing EV" that
// CLAUDE.md called for. It is composition-dependent, so it consumes the same
// exact remaining-shoe count the rest of this app maintains — not a chart.
//
// TypeScript is imported directly: node 22.6+ strips types natively, so there
// is still no build step.

// ============================================================================
// blackjack-engine.ts
//
// Composition-dependent blackjack EV engine.
// Pure, UI-agnostic core shared by BOTH the simulator and the calculator.
//
//   evaluate(player, dealerUp, shoe, rules)  ->  EV of every legal action
//
// The caller owns the shoe (remaining-card composition). In the calculator it
// comes from a manual editor; in the simulator it's the live shoe, decremented
// as cards are dealt (the "Auto-Deduct" mode). The engine doesn't know which.
//
// Remaining known simplification: split hands are still evaluated as if each
// resulting hand draws from the same starting shoe independently, rather than
// modeling the true sequential order in which a dealer would deal to hand 1
// then hand 2 (true joint sequential-depletion split EV is combinatorially
// much more expensive and isn't done by most practical trainers either).
// Resplitting, split aces, dealer-peek conditioning, and double-down
// restrictions are all modeled exactly.
//
// NOT modeled, by design: "Allow Ten-Value Split" (splitting K-Q vs 10-10).
// Rank buckets 10/J/Q/K into a single '10' value because face identity never
// affects EV — but that also means the engine has no way to tell a same-face
// pair from a mixed-ten pair. Gate that rule in the UI layer (the card picker
// knows the actual face), not here.
// ============================================================================

// Ranks collapse to 10 value-buckets. Suit is irrelevant to EV, so it's gone.
// Index 0 = Ace, 1..8 = 2..9, 9 = ten-value (10/J/Q/K).
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10';
export const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/** Remaining-card composition: counts[i] = cards of RANKS[i] left in the shoe. */
export type Shoe = number[]; // length 10

export type Action = 'stand' | 'hit' | 'double' | 'split' | 'surrender';

export type DoubleDownRestriction =
  | 'any' // double on any two cards
  | 'hard9to11' // hard 9, 10, or 11 only
  | 'hard10or11' // hard 10 or 11 only
  | 'hard9to11AndSoft'; // hard 9-11, plus all soft hands

export interface Rules {
  decks: number;
  hitSoft17: boolean; // dealer hits soft 17 (H17) vs stands (S17)
  doubleAfterSplit: boolean;
  lateSurrender: boolean;
  blackjackPays: number; // 1.5 = 3:2, 1.2 = 6:5
  dealerPeeks: boolean; // dealer checks hole card for BJ before further action
  allowDoubleDown: boolean;
  doubleDownRestriction: DoubleDownRestriction;
  maxSplits: number; // total splits allowed; hands = maxSplits + 1
  allowResplitAces: boolean;
  allowDrawAfterSplitAces: boolean; // false = split aces get exactly one card
}

export const VEGAS_6DECK: Rules = {
  decks: 6,
  hitSoft17: true,
  doubleAfterSplit: true,
  lateSurrender: true,
  blackjackPays: 1.5,
  dealerPeeks: true,
  allowDoubleDown: true,
  doubleDownRestriction: 'any',
  maxSplits: 3,
  allowResplitAces: false,
  allowDrawAfterSplitAces: false,
};

export interface Evaluation {
  best: Action;
  ev: Partial<Record<Action, number>>; // EV in units of the base bet; undefined = N/A
  isBlackjack: boolean;
}

// ---------------------------------------------------------------------------
// Shoe helpers (used by the callers to build/mutate composition)
// ---------------------------------------------------------------------------

export function freshShoe(decks: number): Shoe {
  const s = new Array(10).fill(4 * decks); // 4 of each rank per deck...
  s[9] = 16 * decks; // ...but 16 ten-value cards per deck.
  return s;
}

export const rankIndex = (r: Rank): number => RANKS.indexOf(r);
export const cardsLeft = (shoe: Shoe): number => shoe.reduce((a, b) => a + b, 0);

/** Returns a copy of the shoe with one card of the given rank removed. */
function removeCard(shoe: Shoe, i: number): Shoe {
  const copy = shoe.slice();
  copy[i] -= 1;
  return copy;
}

// ---------------------------------------------------------------------------
// Hand value. State is (t, aces): t counts every ace as 1; a soft hand upgrades
// one ace to 11 when it fits. bust iff t > 21 (the +10 upgrade only ever applies
// when it keeps us <= 21).
// ---------------------------------------------------------------------------

interface Hand { t: number; aces: number; }

const rankValue = (i: number): number => (i === 0 ? 1 : i === 9 ? 10 : i + 1);

function handOf(cards: Rank[]): Hand {
  let t = 0, aces = 0;
  for (const c of cards) {
    const i = rankIndex(c);
    t += rankValue(i);
    if (i === 0) aces += 1;
  }
  return { t, aces };
}

function addRank(h: Hand, i: number): Hand {
  return { t: h.t + rankValue(i), aces: h.aces + (i === 0 ? 1 : 0) };
}

const bestTotal = (h: Hand): number =>
  h.aces > 0 && h.t + 10 <= 21 ? h.t + 10 : h.t;
const isSoft = (h: Hand): boolean => h.aces > 0 && h.t + 10 <= 21;
const isBust = (h: Hand): boolean => h.t > 21;

function isDoubleAllowed(h: Hand, restriction: DoubleDownRestriction): boolean {
  const total = bestTotal(h);
  const soft = isSoft(h);
  switch (restriction) {
    case 'any':
      return true;
    case 'hard9to11':
      return !soft && total >= 9 && total <= 11;
    case 'hard10or11':
      return !soft && total >= 10 && total <= 11;
    case 'hard9to11AndSoft':
      return soft || (total >= 9 && total <= 11);
  }
}

// ---------------------------------------------------------------------------
// Dealer final-total distribution over the remaining composition.
// Returns probabilities for totals 17..21 and 'bust'. Recomputed with the
// current shoe at each leaf, because the player's own draws deplete the shoe
// the dealer then draws from (a real composition-dependent effect).
// ---------------------------------------------------------------------------

// keys: "17".."21", "bust", or "natural" (dealer 2-card 21 — beats any hand
// that reaches evStand, since a hand only gets there by NOT being a natural
// itself; see evStand).
type DealerDist = { [k: string]: number };

// Different draw ORDERS reaching the same (hand total, aces, remaining shoe)
// are indistinguishable from here on, but naive recursion re-explores each
// order's subtree separately — for a dealer needing several hits (any upcard
// 2-6), that blows up combinatorially (empirically: >2M calls, still
// climbing, for a single dealer-6 resolution against a full 6-deck shoe).
// Memoizing by that converging state collapses it back to polynomial.
function dealerDist(
  h: Hand,
  shoe: Shoe,
  rules: Rules,
  cardsDealt: number,
  memo: Map<string, DealerDist>,
): DealerDist {
  const tot = bestTotal(h);
  if (tot > 21) return { bust: 1 };
  if (cardsDealt === 2 && tot === 21) return { natural: 1 };

  const soft17 = tot === 17 && isSoft(h);
  const mustStand = tot > 17 || (tot === 17 && !(soft17 && rules.hitSoft17));
  if (mustStand) return { [String(tot)]: 1 };

  const key = `${h.t},${h.aces}|${shoe.join(',')}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const total = cardsLeft(shoe);
  const dist: DealerDist = {};
  for (let i = 0; i < 10; i++) {
    if (shoe[i] === 0) continue;
    const p = shoe[i] / total;
    const sub = dealerDist(addRank(h, i), removeCard(shoe, i), rules, cardsDealt + 1, memo);
    for (const k in sub) dist[k] = (dist[k] ?? 0) + p * sub[k];
  }
  memo.set(key, dist);
  return dist;
}

/**
 * Dealer distribution conditioned on the hole card NOT completing a blackjack
 * (i.e. the branch taken when a peek happens and comes back clean). Excludes
 * `excludeIdx` from the hole-card draw only — deeper draws (dealer hits, and
 * the player's own subsequent draws elsewhere) still see the full shoe, since
 * only one specific card (the hole card) is known not to be that rank.
 */
function dealerDistExcluding(
  dealerUp: Rank,
  excludeIdx: number,
  shoe: Shoe,
  rules: Rules,
  memo: Map<string, DealerDist>,
): DealerDist {
  const h = handOf([dealerUp]);
  const total = cardsLeft(shoe);
  const availableTotal = total - shoe[excludeIdx];
  const dist: DealerDist = {};
  if (availableTotal <= 0) return dist;
  for (let i = 0; i < 10; i++) {
    if (i === excludeIdx || shoe[i] === 0) continue;
    const p = shoe[i] / availableTotal;
    const sub = dealerDist(addRank(h, i), removeCard(shoe, i), rules, 2, memo);
    for (const k in sub) dist[k] = (dist[k] ?? 0) + p * sub[k];
  }
  return dist;
}

/**
 * Supplies the dealer's final-total distribution for a given shoe snapshot.
 * Two flavors are used: the plain (unconditioned) distribution for stand/hit,
 * and — when a peek is in play — the "no dealer blackjack" conditioned
 * distribution, threaded through every dealer-facing call in the double/split
 * subtree so the whole hand's continuation stays consistent with the peek.
 */
type DealerDistFn = (shoe: Shoe) => DealerDist;

// Each factory owns a private memo map, shared across every call the
// resulting closure makes over the course of one evaluate() invocation (its
// whole evPlay/evHit/evDouble/evSplit subtree) — that's the scope across
// which shoe states actually recur and are worth caching.
function makeDealerDistFn(dealerUp: Rank, rules: Rules): DealerDistFn {
  const memo = new Map<string, DealerDist>();
  return (shoe) => dealerDist(handOf([dealerUp]), shoe, rules, 1, memo);
}

function makeConditionedDealerDistFn(dealerUp: Rank, excludeIdx: number, rules: Rules): DealerDistFn {
  const memo = new Map<string, DealerDist>();
  return (shoe) => dealerDistExcluding(dealerUp, excludeIdx, shoe, rules, memo);
}

// ---------------------------------------------------------------------------
// EV of each action. Units are multiples of the base bet.
// ---------------------------------------------------------------------------

function evStand(playerTotal: number, dd: DealerDist): number {
  let win = 0, lose = 0; // push contributes 0
  for (const k in dd) {
    const p = dd[k];
    if (k === 'bust') { win += p; continue; }
    // Every caller of evStand is guaranteed non-natural (evaluate() only
    // reaches here after ruling out a 2-card player blackjack), so a dealer
    // natural always wins, even against a player's own non-natural 21.
    if (k === 'natural') { lose += p; continue; }
    const dealer = Number(k);
    if (dealer < playerTotal) win += p;
    else if (dealer > playerTotal) lose += p;
  }
  return win - lose;
}

// Same convergence as dealerDist: different hit orders reaching the same
// (total, aces, shoe) are worth collapsing via memoization. `memo` is scoped
// to one dealerDistFn (see PlayContext) since the cached EV depends on it.
type PlayMemo = Map<string, number>;

// Best of stand-or-hit, playing the hand out optimally.
function evPlay(h: Hand, shoe: Shoe, rules: Rules, dealerDistFn: DealerDistFn, memo: PlayMemo): number {
  if (isBust(h)) return -1;
  const key = `${h.t},${h.aces}|${shoe.join(',')}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const stand = evStand(bestTotal(h), dealerDistFn(shoe));
  const hit = evHit(h, shoe, rules, dealerDistFn, memo);
  const result = Math.max(stand, hit);
  memo.set(key, result);
  return result;
}

function evHit(h: Hand, shoe: Shoe, rules: Rules, dealerDistFn: DealerDistFn, memo: PlayMemo): number {
  const total = cardsLeft(shoe);
  let ev = 0;
  for (let i = 0; i < 10; i++) {
    if (shoe[i] === 0) continue;
    const p = shoe[i] / total;
    ev += p * evPlay(addRank(h, i), removeCard(shoe, i), rules, dealerDistFn, memo);
  }
  return ev;
}

// Double: exactly ONE card, then stand, stake doubled. This is the correct
// formula — NOT 2 x evHit (a common bug that lets the "double" branch keep
// drawing). On a stiff hand where doubling is live, that shortcut is wrong.
function evDouble(h: Hand, shoe: Shoe, dealerDistFn: DealerDistFn): number {
  const total = cardsLeft(shoe);
  let ev = 0;
  for (let i = 0; i < 10; i++) {
    if (shoe[i] === 0) continue;
    const p = shoe[i] / total;
    const nh = addRank(h, i);
    const shoe2 = removeCard(shoe, i);
    const outcome = isBust(nh) ? -1 : evStand(bestTotal(nh), dealerDistFn(shoe2));
    ev += p * outcome;
  }
  return 2 * ev;
}

// Split, with resplitting. `splitsSoFar` counts splits already taken (the
// initial split that got us here counts as 1); another resplit is offered
// only while splitsSoFar < rules.maxSplits, and only for aces if
// allowResplitAces. Split aces get exactly one forced card unless
// allowDrawAfterSplitAces is set, in which case they play out like any other
// split hand (hit/stand, and double if DAS).
function playSplitHand(
  pairIdx: number,
  shoe: Shoe,
  rules: Rules,
  dealerDistFn: DealerDistFn,
  memo: PlayMemo,
  splitsSoFar: number,
): number {
  const acesSplit = pairIdx === 0;
  const total = cardsLeft(shoe);
  let ev = 0;
  for (let i = 0; i < 10; i++) {
    if (shoe[i] === 0) continue;
    const p = shoe[i] / total;
    const shoe2 = removeCard(shoe, i);
    const canResplit =
      i === pairIdx && splitsSoFar < rules.maxSplits && (!acesSplit || rules.allowResplitAces);

    let outcome: number;
    if (canResplit) {
      outcome = evSplitPair(pairIdx, shoe2, rules, dealerDistFn, memo, splitsSoFar + 1);
    } else if (acesSplit && !rules.allowDrawAfterSplitAces) {
      const nh = addRank(handOf([RANKS[pairIdx]]), i);
      outcome = isBust(nh) ? -1 : evStand(bestTotal(nh), dealerDistFn(shoe2));
    } else {
      const nh = addRank(handOf([RANKS[pairIdx]]), i);
      const play = evPlay(nh, shoe2, rules, dealerDistFn, memo);
      const dbl = rules.doubleAfterSplit ? evDouble(nh, shoe2, dealerDistFn) : -Infinity;
      outcome = Math.max(play, dbl);
    }
    ev += p * outcome;
  }
  return ev;
}

function evSplitPair(
  pairIdx: number,
  shoe: Shoe,
  rules: Rules,
  dealerDistFn: DealerDistFn,
  memo: PlayMemo,
  splitsSoFar: number,
): number {
  return 2 * playSplitHand(pairIdx, shoe, rules, dealerDistFn, memo, splitsSoFar);
}

function evSplit(
  pairIdx: number,
  shoe: Shoe,
  rules: Rules,
  dealerDistFn: DealerDistFn,
  splitsAlreadyTaken: number,
): number {
  return evSplitPair(pairIdx, shoe, rules, dealerDistFn, new Map(), splitsAlreadyTaken + 1);
}

// ---------------------------------------------------------------------------
// Public entry point.
// `shoe` is the composition of cards STILL IN THE SHOE (player/dealer cards
// already dealt should already be removed by the caller).
// ---------------------------------------------------------------------------

/**
 * The actions evaluate() would price for this hand, without computing any EVs.
 * Mirrors evaluate()'s legality gates exactly so the UI can render action
 * buttons before the (slow) EV calculation finishes.
 */
export function availableActions(
  player: Rank[],
  rules: Rules = VEGAS_6DECK,
  splitsAlreadyTaken: number = 0,
): Action[] {
  const h = handOf(player);
  const isTwoCard = player.length === 2;
  const isPair = isTwoCard && rankIndex(player[0]) === rankIndex(player[1]);
  const actions: Action[] = ['stand', 'hit'];
  if (isTwoCard && rules.allowDoubleDown && isDoubleAllowed(h, rules.doubleDownRestriction)) {
    actions.push('double');
  }
  if (isPair && splitsAlreadyTaken < rules.maxSplits) actions.push('split');
  if (isTwoCard && rules.lateSurrender) actions.push('surrender');
  return actions;
}

export function evaluate(
  player: Rank[],
  dealerUp: Rank,
  shoe: Shoe,
  rules: Rules = VEGAS_6DECK,
  // Splits already taken on THIS hand's lineage (0 for a fresh, never-split
  // hand). Lets the simulator re-evaluate a post-split hand without
  // overstating its remaining resplit budget.
  splitsAlreadyTaken: number = 0,
): Evaluation {
  const h = handOf(player);
  const isTwoCard = player.length === 2;
  const isPair = isTwoCard && rankIndex(player[0]) === rankIndex(player[1]);
  const isBlackjack = isTwoCard && bestTotal(h) === 21;

  const ev: Partial<Record<Action, number>> = {};

  if (isBlackjack) {
    // A natural isn't really a "decision", but report its value for display.
    ev.stand = rules.blackjackPays;
    return { best: 'stand', ev, isBlackjack: true };
  }

  const dealerUpIdx = rankIndex(dealerUp);
  // Peek only matters when the upcard could be hiding a natural: A needs a
  // ten in the hole, 10 needs an ace.
  const bjHoleIdx = dealerUpIdx === 0 ? 9 : dealerUpIdx === 9 ? 0 : -1;
  const shoeTotal = cardsLeft(shoe);
  const pBlackjack =
    rules.dealerPeeks && bjHoleIdx !== -1 && shoeTotal > 0 ? shoe[bjHoleIdx] / shoeTotal : 0;

  const plainDealerDistFn = makeDealerDistFn(dealerUp, rules);
  const actingDealerDistFn: DealerDistFn =
    pBlackjack > 0 ? makeConditionedDealerDistFn(dealerUp, bjHoleIdx, rules) : plainDealerDistFn;

  // Stand/hit EV is invariant to peek timing: both branches of a peek risk
  // exactly the original bet, so blending "peeked BJ -> lose 1" with "no BJ ->
  // conditioned EV" always collapses back to the unconditioned calculation.
  ev.stand = evStand(bestTotal(h), plainDealerDistFn(shoe));
  ev.hit = evHit(h, shoe, rules, plainDealerDistFn, new Map());

  // Double/split risk MORE than the original bet, so peek timing matters: if
  // the dealer has blackjack, the player never gets to commit the extra stake.
  if (isTwoCard && rules.allowDoubleDown && isDoubleAllowed(h, rules.doubleDownRestriction)) {
    const noPeekEv = evDouble(h, shoe, actingDealerDistFn);
    ev.double = pBlackjack > 0 ? pBlackjack * -1 + (1 - pBlackjack) * noPeekEv : noPeekEv;
  }
  if (isPair && splitsAlreadyTaken < rules.maxSplits) {
    const noPeekEv = evSplit(rankIndex(player[0]), shoe, rules, actingDealerDistFn, splitsAlreadyTaken);
    ev.split = pBlackjack > 0 ? pBlackjack * -1 + (1 - pBlackjack) * noPeekEv : noPeekEv;
  }
  if (isTwoCard && rules.lateSurrender) ev.surrender = -0.5;

  let best: Action = 'stand';
  let bestEv = -Infinity;
  for (const a in ev) {
    const v = ev[a as Action]!;
    if (v > bestEv) { bestEv = v; best = a as Action; }
  }

  return { best, ev, isBlackjack: false };
}

// ---------------------------------------------------------------------------
// Example (the reference hand): player Q,7 (hard 17) vs dealer 10.
//
//   const shoe = freshShoe(6);
//   // remove the three known cards from the shoe:
//   for (const r of ['10','7','10'] as Rank[]) shoe[rankIndex(r)]--;
//   const result = evaluate(['10','7'], '10', shoe);
//   // -> best: 'stand', ev.stand ≈ negative (~ -0.42), ev.double correct,
//   //    ev.split undefined (not a pair).
// ---------------------------------------------------------------------------
