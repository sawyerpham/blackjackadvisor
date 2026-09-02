// The last few completed rounds, for the dashboard's recap strip. An observer
// like grades.js: nothing here touches tracker.js.
//
// The live round is re-snapshotted every message and pushed when `roundKey`
// changes, so what lands is the tracker's LAST state for that round. Waiting
// for the boundary would be too late — startRound() clears `roundNet` and
// `lastDealerCards` on that same message.

import { SEATS, settledResult } from './advisor.js';

export const HISTORY_MAX = 4;

export class History {
  constructor(max = HISTORY_MAX) {
    this.max = max;
    this.rounds = [];   // newest LAST; the dashboard reverses it
    this.key = null;
    this.live = null;
  }

  handle(_msg, tracker) {
    if (!tracker) return;
    const key = tracker.roundKey;
    if (key !== this.key) {
      // The round turned over, so `this.live` is the finished one.
      if (this.live && this.live.seats.length) this.push(this.live);
      this.key = key;
      this.live = null;
    }
    this.live = snapshot(tracker);
  }

  push(round) {
    this.rounds.push(round);
    while (this.rounds.length > this.max) this.rounds.shift();
  }

  recent() {
    return this.rounds.slice().reverse();
  }
}

// Dealt seats only: `lastPlayerHands` keeps a departed player's entry around.
function snapshot(tracker) {
  const seats = [];
  for (const seat of SEATS) {
    const hands = (tracker.lastPlayerHands?.[seat] || []).filter((h) => h && h.length);
    if (!hands.length) continue;
    seats.push({
      seat,
      name: tracker.seatNames?.[seat] || null,
      mine: tracker.mySeat === seat,
      hands: hands.map((h) => h.slice()),
      // Same rule the felt's outline uses, so the two cannot disagree.
      result: settledResult(tracker.roundNet?.[seat]),
    });
  }
  return {
    key: tracker.roundKey,
    shoe: tracker.shoe?.index ?? null,
    dealer: (tracker.lastDealerCards || []).slice(),
    seats,
  };
}
