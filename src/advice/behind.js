// Which seats to back, and for how much. Advisory only.
//
// Two corrections shrink the bet: you inherit the player's mistakes
// (0.003-0.130 units/decision, against a counting edge peaking near 0.03), and
// seats correlate because every hand plays the same dealer card.

// Measured: 5,658 seat-pairs over 429 rounds.
export const SEAT_CORRELATION = 0.400;

// Stake per seat for n correlated bets with unequal edges:
//
//   b_i = [e_i - (r / (1 + (n-1)r)) * sum(e)] / (k * (1 - r))
//
// `k` is advantagePerUnit. At n = 1 this reduces to betUnitsFor.
export function stakeUnits(netEdges, k, rho = SEAT_CORRELATION) {
  const n = netEdges.length;
  if (!n) return [];
  const total = netEdges.reduce((a, b) => a + b, 0);
  const shrink = rho / (1 + (n - 1) * rho);
  return netEdges.map((e) => (e - shrink * total) / (k * (1 - rho)));
}

// `players` are standings rows: {name, seat, costPerHand, graded}.
export function betBehind({ players, advantage, cfg }) {
  const none = (reason, best = null) =>
    ({ seats: [], totalUnits: 0, totalDisplay: 0, reason, best });

  if (!Array.isArray(players) || !players.length) return none('nobody is seated to back');

  // Shoe edge less that player's own cost, at face value — no sample-size
  // allowance. `graded` travels along so the panel can show the count.
  const rated = players
    .filter((p) => p.costPerHand != null)
    .map((p) => ({ ...p, net: advantage - p.costPerHand }))
    .sort((a, b) => b.net - a.net);

  if (!rated.length) return none('no decisions graded yet — watching');
  const best = rated[0];

  // A backed seat clears the same bar you would demand of your own.
  const bar = cfg.sitAdvantage;
  const eligible = rated.filter((p) => p.net >= bar);
  if (!eligible.length) {
    return none(
      // Seat letter first, to match against the felt without re-reading.
      `best seat is ${best.seat ? `${best.seat} · ` : ''}${best.name}, whose mistakes cost ` +
      `${(best.costPerHand * 100).toFixed(2)}% a hand — needs a ` +
      `${((bar + best.costPerHand) * 100).toFixed(2)}% shoe, this one is ` +
      `${(advantage * 100).toFixed(2)}%`,
      best,
    );
  }

  // Add seats in net-edge order until one earns a non-positive weight — that
  // seat is not worth the correlation it brings.
  let chosen = [];
  let units = [];
  for (let k = 1; k <= eligible.length; k += 1) {
    const take = eligible.slice(0, k);
    const u = stakeUnits(take.map((p) => p.net), cfg.advantagePerUnit);
    if (u.some((x) => x <= 0)) break;
    chosen = take;
    units = u;
  }
  if (!chosen.length) return none('the correlation between seats eats the whole edge', best);

  // Back-bets take a smaller minimum than a main bet, which is what makes these
  // fractional sizes reachable: 23 rounded to 30 on four seats overbets by 32%.
  const perUnit = cfg.minBet / cfg.displayDivisor;
  const seats = chosen.map((p, i) => {
    const display = Math.max(cfg.backBetMin, Math.round(units[i] * perUnit));
    return {
      name: p.name,
      seat: p.seat,
      display,
      units: display / perUnit,
      net: p.net,
      cost: p.costPerHand,
      graded: p.graded,
    };
  });

  const totalDisplay = seats.reduce((a, s) => a + s.display, 0);
  return {
    seats,
    advantage,
    totalUnits: totalDisplay / perUnit,
    totalDisplay,
    reason: `${seats.length} seat${seats.length === 1 ? '' : 's'} clear the ` +
            `${(bar * 100).toFixed(2)}% bar after their own mistakes`,
    best,
  };
}
