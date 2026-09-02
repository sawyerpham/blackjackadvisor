// Everything tunable, in one place.
//
// Feed values are 100x what the site displays. The main-bet minimum — 1000 feed
// = 10 display — is ONE UNIT, so every recommended bet is a whole number of
// units. No bankroll setting: picking the unit already sets the scale.

import { fromRoot } from './util/paths.js';

// Site details live in gitignored local.config.js. Env vars win over both.
let local = {};
try { local = (await import('../local.config.js')).default || {}; } catch { /* optional */ }

export const config = {
  tableUrl: process.env.TABLE_URL || local.tableUrl || '',
  allowWs: process.env.ALLOW_WS || local.allowWs || '',
  ignoreWs: process.env.IGNORE_WS || local.ignoreWs || '/ws/chat/|/video/',

  decks: 8,                       // measured, confirmed from clean data

  minBet: 1_000,                  // limits.main.min, in feed units = 1 unit
  maxBet: 10_000_000,             // limits.main.max
  displayDivisor: 100,            // feed units -> what the site shows you
  // Smaller than the main-bet minimum, so behind.js can hit its fractional
  // per-seat sizes exactly.
  backBetMin: 1,

  // One extra unit per this much advantage:
  //   +0.5% -> 2u    +1.0% -> 4u    +1.5% -> 6u    +2.0% -> 8u    +3.0% -> 12u
  advantagePerUnit: 0.0025,
  betCap: 12,                     // hard ceiling. Spreading past ~12x is loud.

  // Hysteresis. Equal thresholds would flap the advice on every card.
  sitAdvantage: 0.005,
  leaveAdvantage: 0.000,
  minCardsToSit: 25,

  // 'secondary' (first non-primary screen) | 'primary' | 'off' | screen index.
  windowMonitor: process.env.WINDOW_MONITOR || local.windowMonitor || 'secondary',

  // Measured cut positions: 221, 196, 212, 227 of 416. Draws the shoe bar only.
  expectedCutCard: 214,

  sessionLog: true,               // data/session-<stamp>.ndjson
  logDir: fromRoot('data'),

  // Read off the table, not inferred: tableSettings publishes timings, chips
  // and side bets, and nothing about how a hand may be played.
  rules: {
    decks: 8,
    hitSoft17: false,
    blackjackPays: 1.5,
    allowDoubleDown: true,
    doubleDownRestriction: 'any',
    doubleAfterSplit: false,
    lateSurrender: false,
    maxSplits: 1,
    // maxSplits is what enforces this: availableActions() gates a split on the
    // count alone and never reads the flag. playtest.js pins both.
    allowResplitAces: false,
    // Splitting is by VALUE here, so K-Q is a pair. The engine buckets T/J/Q/K
    // as one '10', which matches the table's rule. Do not "fix" it.
    allowDrawAfterSplitAces: false,
    // The dealer peeks on an ACE and NOT on a TEN. The engine has one flag for
    // both, so play.js narrows it to the ace via rulesForUpcard(). Read this as
    // "peeking happens at all".
    //
    // Evidence for the ten: 17 dealer naturals on a ten upcard in the captures,
    // two with a player double that settled Lost beside the main bet — so the
    // hand was never stopped for a check. For the ace: insurance is offered,
    // which is the peek.
    dealerPeeks: true,
  },

  port: Number(process.env.PORT) || 8080,
};

export default config;
