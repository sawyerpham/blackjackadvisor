#!/usr/bin/env node
// The gate for player grading. MUST print PASS. Run after touching grades.js,
// play.js, advisor.js, or the vendored engine.
//
//   1. READING. Did it score the position the player actually faced? Grading
//      the post-hit hand would be invisible in the output, so extraction is
//      tested against a stub engine that records what it was asked.
//   2. SCORING. Given the right position, is the verdict right?
//   3. What sitting down changes: the standings keep running with your own seat
//      out of them, and the on-clock readout stops dead.

import { Grades, wilsonLower } from '../src/advice/grades.js';
import { advise, handTotal } from '../src/advice/advisor.js';
import { betBehind, stakeUnits, SEAT_CORRELATION } from '../src/advice/behind.js';
import { evaluatePosition, shutdownPlay } from '../src/engine/play.js';
import { RANKS, Tracker } from '../src/feed/tracker.js';
import config from '../src/config.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// Grading reads exactly two things off a tracker, so those two are all this
// has: anything else it reached for would be a bug worth catching.
function fakeTracker(names, inPlay = []) {
  const remaining = {};
  for (const r of RANKS) remaining[r] = 32;
  for (const r of inPlay) remaining[r] -= 1;
  return { seatNames: names, remaining: () => remaining };
}

const handsMsg = (playerHands, dealerCards = ['QS', '**']) =>
  ({ _t: 'bj.Hands', dealerHand: { cards: dealerCards }, playerHands });

const hand = (cards, decision = null) => ({ cards, decision });
const decided = (what, ts, trigger = 'PlayerChoice') =>
  ({ lastDecision: what, lastDecisionTimestamp: ts, trigger, decisionTrigger: trigger });

// ---------------------------------------------------------------- part 1 ----

console.log('=== reading the position the player faced ===\n');

const asked = [];
const stub = new Grades({
  // Answers that whatever they did was best, so this half measures extraction
  // only.
  evaluate: async (pos) => {
    asked.push(pos);
    return { best: 'stand', ev: { stand: 0, hit: -0.1 }, isBlackjack: false };
  },
  rules: config.rules,
  decks: 8,
});

const tracker = fakeTracker({ A: 'seat-a', B: 'seat-b', C: 'seat-c', D: 'seat-d', E: 'seat-e' });
const feed = (playerHands, dealer) => stub.handle(handsMsg(playerHands, dealer), tracker);

// As the feed publishes it: the decision arrives one message before its card.
feed({ A: [hand(['5S', '8C'])] });
feed({ A: [hand(['5S', '8C'], decided('Hit', 1000))] });
feed({ A: [hand(['5S', '8C', '2C'], decided('Hit', 1000))] });   // same decision, resent
feed({ A: [hand(['5S', '8C', '2C'], decided('Stand', 2000))] });

const aHit = asked.find((q) => q.cards.join() === '5,8');
const aStand = asked.find((q) => q.cards.join() === '5,8,2');
check('a hit is scored on the hand BEFORE the card it drew', !!aHit);
check('the follow-up stand is scored on the hand after it', !!aStand);
check('a resent decision is not scored twice',
  asked.filter((q) => q.cards.join() === '5,8').length === 1);
check('the dealer upcard comes from the first dealer card', aHit?.dealerUpcard === 'Q');

// Both new hands inherit the parent's key and timestamp, and the first is then
// reissued a fresh key — so keying on the key counts one split as two. The pair
// must be what gets scored, not the halves.
feed({ B: [hand(['4S', '4D'])] });
feed({ B: [hand(['4S', '4D'], decided('Split', 3000))] });
feed({ B: [hand(['4S'], decided('Split', 3000)), hand(['4D'], decided('Split', 3000))] });
feed({ B: [hand(['4S', '2H'], decided('Split', 3000)), hand(['4D', '8H'], decided('Split', 3000))] });

const splits = asked.filter((q) => q.cards.join() === '4,4');
check('a split is scored once, on the pair', splits.length === 1,
  `${splits.length} evaluation(s)`);
check('and as a hand that has not split yet', splits[0]?.splitsTaken === 0);

// By the time the second half acts, one split is spent — which the engine has
// to know or it offers a resplit the table does not allow.
feed({ B: [hand(['4S', '2H'], decided('Stand', 3100)), hand(['4D', '8H'], decided('Stand', 3200))] });
const post = asked.find((q) => q.cards.join() === '4,8');
check('a post-split hand is scored with its split already spent', post?.splitsTaken === 1);

// A clock running out is not a play.
feed({ C: [hand(['9S', '7H'], decided('Stand', 4000, 'ExpiredDecisionTime'))] });
check('a timeout is recorded but not graded',
  stub.record('seat-c').timeouts === 1 && stub.record('seat-c').graded === 0);
check('and no evaluation is even requested for it',
  !asked.some((q) => q.cards.join() === '9,7'));

// A card never shown cannot be evaluated, and guessing is worse than a gap.
feed({ D: [hand(['9S', '**'], decided('Stand', 5000))] });
check('a hidden card is skipped, not guessed', stub.record('seat-d').skipped === 1);

// If the message announcing the decision already carries the card it drew — a
// dropped update — the previous sighting is a strict prefix of what we hold now,
// and is still the right position.
feed({ E: [hand(['TS', '6H'])] });
feed({ E: [hand(['TS', '6H', '5C'], decided('Hit', 6000))] });
const guarded = asked.find((q) => q.dealerUpcard === 'Q' && q.cards.join() === 'T,6');
check('a dropped update falls back to the previous sighting', !!guarded,
  guarded ? '' : `scored ${JSON.stringify(asked.at(-1)?.cards)} instead`);

// Your OWN seat is never scored, seated or not. Everyone else keeps being
// scored while you sit: seats act one at a time, so the worker queue is empty by
// the time your hand is up.
const seatedTracker = { ...tracker, mySeat: 'D' };
const askedWhileOut = asked.length;
stub.handle(handsMsg({ D: [hand(['9S', '8H'], decided('Stand', 7000))] }), seatedTracker);
check('seated, your own seat is not graded', asked.length === askedWhileOut);
check('and your own decision is not even marked seen',
  !stub.seen.has('D|7000'));
stub.handle(handsMsg({ E: [hand(['9S', '8H'], decided('Stand', 7100))] }), seatedTracker);
check('but the other seats still are', asked.length === askedWhileOut + 1,
  `${asked.length - askedWhileOut} evaluation(s)`);
check('and their decision is marked seen as usual', stub.seen.has('E|7100'));

// Nothing should be read out of a message that is not a hand snapshot.
const askedBefore = asked.length;
stub.handle({ _t: 'bj.Game', cuttingCard: true }, tracker);
stub.handle({ _t: 'bj.Seats', seats: {} }, tracker);
check('other message types are ignored', asked.length === askedBefore);

// ---------------------------------------------------------------- part 2 ----

console.log('\n=== scoring, against the real engine ===\n');

// Positions no chart and no count argue about. The composition passed in has
// the cards on the table already removed, which is what the live tracker hands
// over.
const live = new Grades({ evaluate: evaluatePosition, rules: config.rules, decks: 8 });
const names = { A: 'sharp', B: 'loose' };

const play = (seat, cards, decision, ts, upcard) => {
  const t = fakeTracker(names, [...cards.map((c) => c.slice(0, -1)), upcard.slice(0, -1)]);
  live.handle(handsMsg({ [seat]: [hand(cards, decided(decision, ts))] }, [upcard, '**']), t);
};

play('A', ['TS', 'TH'], 'Stand', 10, '6D');   // stand on 20 v 6
play('A', ['5S', '6H'], 'Double', 20, '5D');  // double 11 v 5
play('A', ['9S', '7H'], 'Hit', 30, 'TD');     // hit 16 v 10
play('B', ['TS', 'TH'], 'Hit', 40, '6D');     // hit 20 v 6
play('B', ['9S', '9H'], 'Hit', 50, '6D');     // hit 18 v 6

const deadline = Date.now() + 30000;
while ([...live.byName.values()].some((r) => r.pending > 0) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25));
}

const LIVE = { A: 'sharp', B: 'loose' };
const rows = Object.fromEntries(live.standings(LIVE).map((r) => [r.name, r]));
check('every decision was scored', rows.sharp?.graded === 3 && rows.loose?.graded === 2,
  `sharp ${rows.sharp?.graded}, loose ${rows.loose?.graded}`);
check('correct play scores 100%', rows.sharp?.pct === 1,
  `${((rows.sharp?.pct ?? 0) * 100).toFixed(0)}%  best ${rows.sharp?.best}/${rows.sharp?.graded}`);
check('obviously bad play scores 0%', rows.loose?.pct === 0,
  `${((rows.loose?.pct ?? 1) * 100).toFixed(0)}%`);
check('correct play gives up nothing', (rows.sharp?.evLostPerHand ?? 1) <= 0.0005,
  `${rows.sharp?.evLostPerHand?.toFixed(4)} units/decision`);
check('hitting a 20 is priced as the disaster it is',
  (rows.loose?.evLostPerHand ?? 0) > 0.5, `${rows.loose?.evLostPerHand?.toFixed(3)} units/decision`);
check('standings put the better player first', live.standings(LIVE)[0]?.name === 'sharp');

// The panel sits under a picture of seven seats and has to describe those
// seats. A departed player's row would keep a seat letter pointing at a chair
// someone else is now in.
check('a player who has left the table is gone entirely',
  live.standings({ A: 'sharp' }).every((r) => r.name !== 'loose'));

const fresh = live.standings({ ...LIVE, C: 'newcomer' }).find((r) => r.name === 'newcomer');
check('a seat that has just filled appears with nothing scored yet',
  !!fresh && fresh.pct === null && fresh.graded === 0);

// Sitting down does not stop the panel, and your own seat never appears in it.
const kept = live.standings(LIVE).length;
const gradedBefore = live.standings(LIVE).find((r) => r.name === 'sharp')?.graded;
const seatedT = { ...fakeTracker(names), mySeat: 'B' };
live.handle(handsMsg({ A: [hand(['TS', 'TH'], decided('Hit', 60))] }, ['6D', '**']), seatedT);
const deadline2 = Date.now() + 30000;
while ([...live.byName.values()].some((r) => r.pending > 0) && Date.now() < deadline2) {
  await new Promise((r) => setTimeout(r, 25));
}
check('seated, the other seats keep being scored',
  live.standings(LIVE).find((r) => r.name === 'sharp')?.graded === gradedBefore + 1,
  `${gradedBefore} -> ${live.standings(LIVE).find((r) => r.name === 'sharp')?.graded}`);
check('and no record is lost by sitting down', live.standings(LIVE).length === kept);
check('your own seat is left out of the standings even if it is passed in',
  live.standings(LIVE, 'B').every((r) => r.seat !== 'B') &&
  live.standings(LIVE, 'B').length === kept - 1,
  `${live.standings(LIVE, 'B').map((r) => r.seat).join(',') || 'none'}`);

// ---- ranking -----------------------------------------------------------

// A raw percentage treats 5/5 and 85/85 as the same claim; the score does not.
const pc = (s, n) => wilsonLower(s, n);
check('a perfect tiny sample ranks below a strong large one',
  pc(5, 5) < pc(76, 85), `5/5 -> ${(pc(5, 5) * 100).toFixed(1)}, 76/85 -> ${(pc(76, 85) * 100).toFixed(1)}`);
check('but a perfect LARGE sample still wins',
  pc(17, 17) > pc(76, 85), `17/17 -> ${(pc(17, 17) * 100).toFixed(1)}`);
check('more evidence at the same rate ranks higher',
  pc(80, 100) > pc(12, 15), `80/100 -> ${(pc(80, 100) * 100).toFixed(1)}, 12/15 -> ${(pc(12, 15) * 100).toFixed(1)}`);
check('the score never exceeds the rate it is derived from',
  pc(76, 85) < 76 / 85 && pc(5, 5) < 1);
check('and converges upward on it as evidence accumulates',
  pc(890, 1000) > pc(89, 100) && pc(890, 1000) < 0.89);
check('nothing observed has no score at all', pc(0, 0) === null);
check('an all-wrong player floors at zero rather than going negative', pc(0, 6) >= 0);

// ---- money -------------------------------------------------------------

// Settlements are keyed by SEAT and players move seats, so attribution has to
// happen as they arrive. Wrong, it pays one player's losses to whoever sits in
// their chair next — a bug that reads as a funny result rather than a fault.
const money = new Grades({ evaluate: async () => null, rules: config.rules, decks: 8, displayDivisor: 100 });
const tr = { seatNames: { A: 'sharp', B: 'loose' }, results: [], remaining: () => ({}) };
let roundNo = 0;
const settle = (seat, bet, net) => tr.results.push({ seat, bet, net, round: `r${roundNo}` });

roundNo = 1;
settle('A', 'main', 1000); settle('A', 'pair', -200); settle('A', '21+3', -100);
settle('B', 'main', -3000);
money.drainResults(tr);
let m = Object.fromEntries(money.standings({ A: 'sharp', B: 'loose' }).map((r) => [r.name, r]));
check('side bets count toward the balance, in on-screen units',
  m.sharp.net === 7, `${m.sharp.net}`);
check('and a loss is a loss', m.loose.net === -30, `${m.loose.net}`);
check('only the main bet counts as a round played', m.sharp.rounds === 1);
check('a side bet in the same round is counted once, not per bet type',
  m.sharp.sideRate === 1, `${m.sharp.sideRate}`);
check('a player who takes no side bets reads as zero, not missing',
  m.loose.sideRate === 0, `${m.loose.sideRate}`);

// Side bets settle on the opening cards and the main bet waits for the dealer,
// so every round has a window where a naive ratio reports "side bets on 108% of
// hands".
roundNo = 9;
settle('B', 'pair', -100);          // side bet home, main still out with the dealer
money.drainResults(tr);
m = Object.fromEntries(money.standings({ B: 'loose' }).map((r) => [r.name, r]));
check('a side bet whose hand is still live does not count yet',
  m.loose.sideRate === 0, `${m.loose.sideRate}`);
settle('B', 'main', -1000);         // dealer finishes, the hand completes
money.drainResults(tr);
m = Object.fromEntries(money.standings({ B: 'loose' }).map((r) => [r.name, r]));
check('and counts as soon as it does', m.loose.sideRate === 0.5, `${m.loose.sideRate}`);

// The money must move with the player, not stay in the chair.
tr.seatNames = { C: 'sharp', B: 'loose' };
roundNo = 2;
settle('C', 'main', 500);
money.drainResults(tr);
m = Object.fromEntries(money.standings({ C: 'sharp', B: 'loose' }).map((r) => [r.name, r]));
check('a balance follows the player between seats', m.sharp.net === 12, `${m.sharp.net}`);

// And a stranger takes their old chair.
tr.seatNames = { A: 'stranger', C: 'sharp' };
roundNo = 3;
settle('A', 'main', -700);
money.drainResults(tr);
m = Object.fromEntries(money.standings({ A: 'stranger', C: 'sharp' }).map((r) => [r.name, r]));
check('and does not inherit the last occupant of the seat',
  m.stranger.net === -7 && m.sharp.net === 12, `stranger ${m.stranger.net}, sharp ${m.sharp.net}`);

// Seated, the log is still drained on every message, so the seat map it
// attributes through is always the current one and nothing banks up.
settle('C', 'main', 999900);
money.handle({ _t: 'bj.Hands', playerHands: {} }, { ...tr, mySeat: 'D' });
m = Object.fromEntries(money.standings({ C: 'sharp' }).map((r) => [r.name, r]));
check('other players\' money is still attributed while you are seated',
  m.sharp.net === 10011, `${m.sharp.net}`);

// Your own is not: it would show nowhere, and your rounds landing in
// decisionsPerHand() with no graded decisions beside them would deflate
// costPerHand for everyone and under-size every bet-behind.
roundNo += 1;
settle('D', 'main', 5000000);
money.handle({ _t: 'bj.Hands', playerHands: {} }, { ...tr, mySeat: 'D', seatNames: { ...tr.seatNames, D: 'you' } });
check('but your own money is not banked against anyone',
  !money.byName.has('you'), [...money.byName.keys()].join(','));

// ---------------------------------------------------------------- part 3 ----

console.log('\n=== what sitting down changes ===\n');

// A real tracker, because advise() reads a great deal more of one than the
// stand-in above provides.
const live2 = new Tracker({});
const at = Date.now() * 1e6;
live2.handle({ _t: 'bj.Seats', _at: at, seats: { E: { name: 'seat-e', mySeat: false } } }, Date.now());
live2.handle({
  _t: 'bj.Hands', _at: at,
  dealerHand: { cards: ['6D', '**'], score: 6, soft: false, active: false },
  // active:true is how the feed names the hand the table is waiting on.
  playerHands: { E: [{ cards: ['TS', '6H'], score: 16, soft: false, active: true }] },
}, Date.now());

const spectating = advise(live2, config);
check('spectating, the seat on the clock is reported',
  spectating.onClock?.seat === 'E', `got ${JSON.stringify(spectating.onClock?.seat)}`);
check('with the name and the cards that are actually in front of them',
  spectating.onClock?.name === 'seat-e' && spectating.onClock?.cards.join() === 'TS,6H');

// Over 21 there is nothing left to advise. The engine still prices stand and
// hit at -1 apiece and answers 'stand', which reads as advice when it is not.
// Its own tracker, so it does not disturb the felt comparison below.
const bustT = new Tracker({});
bustT.handle({ _t: 'bj.Seats', _at: at, seats: { E: { name: 'seat-e', mySeat: false } } }, Date.now());
bustT.handle({
  _t: 'bj.Hands', _at: at,
  dealerHand: { cards: ['6D', '**'], score: 6, soft: false, active: false },
  playerHands: { E: [{ cards: ['TS', '9H', '5D'], score: 24, soft: false, active: true }] },
}, Date.now());
check('a busted hand reads BUST, not STAND',
  advise(bustT, config).onClock?.advice?.action === 'bust',
  String(advise(bustT, config).onClock?.advice?.action));
check('and an ace still counts soft where it fits',
  handTotal(['A', 'A', '9']) === 21 && handTotal(['A', '5', '5']) === 21);

// Sitting down is the whole test. Nothing about the felt may change.
live2.handle({ _t: 'bj.Seats', _at: at, seats: { E: { name: 'seat-e', mySeat: false },
                                                 B: { name: 'you', mySeat: true } } }, Date.now());
const seated = advise(live2, config);
check('seated, there is no on-clock advice at all', seated.onClock === null);
check('and the felt itself is unchanged',
  JSON.stringify(seated.table.seats.map((x) => x.hands)) ===
  JSON.stringify(spectating.table.seats.map((x) => x.hands)));

// A green or red seat says the HAND is over. Insurance settles at the dealer's
// peek and the side bets settle on the opening cards, so any of them can bank
// while the player is still drawing — which is exactly how a seat holding
// 8 2 A (an 11, or a soft 21) came to be outlined as a loss.
const felt = new Tracker({});
felt.handle({ _t: 'bj.Seats', _at: at, seats: { E: { name: 'seat-e', mySeat: false } } }, Date.now());
felt.handle({
  _t: 'bj.Hands', _at: at,
  dealerHand: { cards: ['AS', '**'], score: 11, active: false },
  playerHands: { E: [{ cards: ['8C', '2H'], score: 10, active: true }] },
}, Date.now());
const seatE = () => advise(felt, config).table.seats.find((s) => s.seat === 'E');

check('a seat with cards out and nothing settled has no verdict', seatE().result === null,
  String(seatE().result));

felt.handle({
  _t: 'bj.PlayerChips', _at: at,
  chips: { E: { insurance: { amount: 1500, resultType: 'Lost', payout: 0, status: 'accepted' } } },
}, Date.now());
check('a lost insurance bet does not mark the hand lost', seatE().result === null,
  String(seatE().result));

felt.handle({
  _t: 'bj.PlayerChips', _at: at,
  chips: { E: { '21+3': { amount: 500, resultType: 'Lost', payout: 0, status: 'accepted' } } },
}, Date.now());
check('nor does a lost side bet', seatE().result === null, String(seatE().result));

// The hand the bug was reported on. Every ace counts 1 in the hard total, so
// this is an 11 with a soft 21 available — nowhere near bust.
check('8 2 A is 21, not a bust', handTotal(['8', '2', 'A']) === 21,
  String(handTotal(['8', '2', 'A'])));

felt.handle({
  _t: 'bj.PlayerChips', _at: at,
  chips: { E: { main: { amount: 1000, resultType: 'Win', payout: 2000, status: 'accepted' } } },
}, Date.now());
check('once the main bet settles the seat gets its verdict', seatE().result === 'win',
  String(seatE().result));

// A push is a real answer and must not read as an unfinished hand.
const pushT = new Tracker({});
pushT.handle({ _t: 'bj.Seats', _at: at, seats: { E: { name: 'seat-e', mySeat: false } } }, Date.now());
pushT.handle({
  _t: 'bj.PlayerChips', _at: at,
  chips: { E: { main: { amount: 1000, resultType: 'Push', payout: 1000, status: 'accepted' } } },
}, Date.now());
check('a push settles as a push, not as nothing',
  advise(pushT, config).table.seats.find((s) => s.seat === 'E').result === 'push');

felt.startRound('next-round', Date.now());
check('and the next round clears it', seatE().result === null, String(seatE().result));

// ---------------------------------------------------------------- part 4 ----

console.log('\n=== bet behind: sizing and seat choice ===\n');

const K = config.advantagePerUnit;
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

// One seat must be sized exactly like any other bet, or the panel and the
// headline would disagree about the same money.
check('a single backed seat matches the ordinary ramp',
  near(stakeUnits([0.01], K)[0], 0.01 / K), `${stakeUnits([0.01], K)[0].toFixed(3)}u vs ${(0.01 / K)}u`);

// With equal edges the general solver has to collapse to the textbook divisor.
const four = stakeUnits([0.01, 0.01, 0.01, 0.01], K);
check('four equal seats each get 1/(1+3r) of that',
  near(four[0], (0.01 / K) / (1 + 3 * SEAT_CORRELATION)), `${four[0].toFixed(3)}u`);
check('and the total is larger than one seat but far short of four',
  four.reduce((a, b) => a + b, 0) > 0.01 / K &&
  four.reduce((a, b) => a + b, 0) < 2.5 * (0.01 / K),
  `${four.reduce((a, b) => a + b, 0).toFixed(2)}u vs ${(0.01 / K).toFixed(2)}u on one`);

// Total action asymptotes, which is why backing every seat is not the answer.
// Each SUCCESSIVE seat has to add less than the one before it — the cumulative
// jump from 2 seats to 7 is of course larger than 1 to 2, being five steps.
const totalFor = (n) => stakeUnits(Array(n).fill(0.01), K).reduce((a, b) => a + b, 0);
const steps = [];
for (let n = 1; n < 7; n += 1) steps.push(totalFor(n + 1) - totalFor(n));
check('each extra seat is worth less than the last',
  steps.every((s, i) => i === 0 || s < steps[i - 1]),
  steps.map((s) => s.toFixed(2)).join(' > '));
check('and seven seats never reach twice the money of one',
  totalFor(7) < 2.1 * totalFor(1), `${totalFor(7).toFixed(2)}u vs ${totalFor(1).toFixed(2)}u`);

// A sharper player is worth more money than a looser one at the same table.
const uneven = stakeUnits([0.012, 0.006], K);
check('the better seat is backed harder than the worse one', uneven[0] > uneven[1],
  `${uneven[0].toFixed(2)}u vs ${uneven[1].toFixed(2)}u`);

const roster = (costs) => costs.map(([name, seat, cost, graded]) =>
  ({ name, seat, costPerHand: cost, graded }));
const TABLE = roster([
  ['sharp', 'D', 0.0035, 40],
  ['fair', 'F', 0.0058, 40],
  ['loose', 'E', 0.0151, 40],
  ['awful', 'A', 0.1508, 40],
]);

// Below the bar, nothing is worth backing however good the count feels.
const cold = betBehind({ players: TABLE, advantage: 0.004, cfg: config });
check('a thin edge backs nobody', cold.seats.length === 0);
check('and the reason names the edge the best seat would need',
  /needs a 0.85% shoe/.test(cold.reason), cold.reason);

const warm = betBehind({ players: TABLE, advantage: 0.0135, cfg: config });
check('a good edge backs the cheap seats', warm.seats.length >= 2, `${warm.seats.length} seats`);
check('cheapest player first', warm.seats[0].name === 'sharp');
check('and the worst player is never backed',
  !warm.seats.some((s) => s.name === 'awful'));
check('per-seat stake is well under the single-seat ramp',
  warm.seats[0].units < 0.0135 / K,
  `${warm.seats[0].units.toFixed(2)}u each vs ${(0.0135 / K).toFixed(2)}u on one`);
check('every stake is a whole number of the bet-behind minimum',
  warm.seats.every((s) => s.display >= config.backBetMin && Number.isInteger(s.display)),
  warm.seats.map((s) => s.display).join('/'));

// The point of the whole panel: adding seats must move money sideways, not up.
const wide = betBehind({ players: TABLE, advantage: 0.025, cfg: config });
check('a bigger edge backs more seats', wide.seats.length >= warm.seats.length,
  `${warm.seats.length} -> ${wide.seats.length}`);
check('total stays under twice the single-seat bet',
  wide.totalUnits < 2.2 * (0.025 / K),
  `${wide.totalUnits.toFixed(1)}u total vs ${(0.025 / K).toFixed(1)}u on one seat`);

// Cost is taken at face value however thin the sample. Two clean decisions and
// forty clean decisions read the same, by design — the decision count is
// reported so the sample stays visible rather than being priced in.
const rec = (name, best, graded, evLost, rounds) => {
  const g = new Grades({ evaluate: async () => null, rules: config.rules, decks: 8 });
  const r = g.record(name);
  r.best = best; r.graded = graded; r.evLost = evLost; r.rounds = rounds;
  return g.standings({ A: name })[0];
};
const thinRow = rec('newcomer', 2, 2, 0, 2);
const seenRow = rec('regular', 40, 40, 0, 35);
check('a clean short record reads the same as a clean long one',
  thinRow.costPerHand === seenRow.costPerHand,
  `${(thinRow.costPerHand * 100).toFixed(2)}% on ${thinRow.graded} vs ` +
  `${(seenRow.costPerHand * 100).toFixed(2)}% on ${seenRow.graded}`);
check('and both get backed at a good count',
  betBehind({ players: [thinRow], advantage: 0.02, cfg: config }).seats.length === 1 &&
  betBehind({ players: [seenRow], advantage: 0.02, cfg: config }).seats.length === 1);
check('the sample size travels with the row so the panel can show it',
  thinRow.graded === 2 && seenRow.graded === 40);

// The flip side of the same rule: one observed mistake is charged in full, so
// a thin record swings hard.
const slipped = rec('slipped', 1, 2, 0.9, 2);
check('a single observed mistake is charged at face value',
  slipped.costPerHand > 0.4, (slipped.costPerHand * 100).toFixed(1) + '% a hand');
check('and takes that seat out of contention',
  betBehind({ players: [slipped], advantage: 0.02, cfg: config }).seats.length === 0);

// The standings sort still weighs the sample: a leaderboard and a bet are
// different questions, and only the bet was asked to ignore sample size.
check('the ranking score still discounts a thin record',
  thinRow.score < seenRow.score,
  (thinRow.score * 100).toFixed(1) + ' vs ' + (seenRow.score * 100).toFixed(1));

shutdownPlay();

if (failures) {
  console.log(`\nFAIL — ${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nPASS — grading reads the right position, scores it correctly, ' +
            'and keeps your own seat out of the panel when you sit.');
