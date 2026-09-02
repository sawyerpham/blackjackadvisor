// A pair split against a low upcard takes seconds on an 8-deck shoe; the
// dashboard pushes every 250ms. So the engine runs off the main thread.

import { parentPort } from 'node:worker_threads';
import { evaluate } from '../../vendor/blackjack-engine.ts';

parentPort.on('message', ({ id, player, dealerUp, shoe, rules, splitsTaken }) => {
  try {
    const result = evaluate(player, dealerUp, shoe, rules, splitsTaken);
    parentPort.postMessage({ id, result });
  } catch (err) {
    // Report, don't throw: one bad hand must not kill the worker.
    parentPort.postMessage({ id, error: String(err && err.message) });
  }
});
