#!/usr/bin/env node
// Starts Edge with a CDP debugging port. cdp fallback only.
//
//   npm run edge
//
// Node, not .cmd: PowerShell needs a leading `.\` to run a script from the
// current directory and cmd skips it entirely under
// NoDefaultCurrentDirectoryInExePath, so the bare name failed in both.
//
// DEDICATED PROFILE, NOT YOURS. Since Chromium 136 the browser silently drops
// --remote-debugging-port whenever the default user data directory is in play —
// no warning, nothing ever listens, and the only symptom is attach.js failing
// later with "no browser is listening". Our own --user-data-dir re-enables the
// port, and means this does not care what other Edge windows are open.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config from '../src/config.js';
import { fromRoot } from '../src/util/paths.js';
import { sideBySide } from '../src/util/screen.js';

const URL_TO_OPEN = config.tableUrl;
if (!URL_TO_OPEN) {
  console.error('No table URL. Copy local.config.example.js to local.config.js');
  console.error('and set tableUrl, or set TABLE_URL.');
  process.exit(1);
}
const PORT = Number(process.env.CDP_PORT || 9222);
// Not ./.profile, which launch mode owns: two browsers must never share one
// user data dir, and both modes can be running at once.
const PROFILE_DIR = process.env.EDGE_PROFILE_DIR || fromRoot('.edge-profile');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

// Ask the browser itself rather than testing the TCP port: one that connects
// but never answers /json/version is the exact failure we are here to catch.
function cdpVersion(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/json/version', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Already up, from an earlier run or a browser started by hand.
  const existing = await cdpVersion();
  if (existing) {
    console.log(`CDP is already listening on port ${PORT} (${existing.Browser}).`);
    console.log('Nothing to do. Open the blackjack table, then run:  npm run live');
    return;
  }

  const edge = process.env.EDGE_PATH || CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) {
    console.error(
      '\nCould not find msedge.exe in either standard location.\n' +
      '  Set the path explicitly:  $env:EDGE_PATH="C:\\path\\to\\msedge.exe"; npm run edge\n' +
      '  Or use a dedicated browser instead:  ATTACH=launch npm start\n'
    );
    process.exit(1);
  }

  const firstRun = !fs.existsSync(PROFILE_DIR);
  // Left half of the chosen screen; the dashboard window takes the right.
  const place = sideBySide(config.windowMonitor);

  // Detached, so Edge outlives this process and closing the terminal does not
  // take the browser down mid-session.
  const child = spawn(
    edge,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The dashboard shares this browser, so the table page spends time in
      // the background. The three flags Playwright passes in launch mode;
      // without them Chromium throttles the hidden tab's timers and its feed.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...(place
        ? [`--window-position=${place.left.left},${place.left.top}`,
           `--window-size=${place.left.width},${place.left.height}`]
        : []),
      URL_TO_OPEN,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.on('error', (e) => {
    console.error(`\nCould not start ${edge}: ${e.message}\n`);
    process.exit(1);
  });
  child.unref();

  // Not a word until the browser actually answers on the port. Reporting
  // success the instant spawn returned was true of the process and false of the
  // port, and sent you off to debug capture.js for a fault that was here.
  const deadline = Date.now() + 30_000;
  let version = null;
  while (Date.now() < deadline) {
    await sleep(500);
    version = await cdpVersion();
    if (version) break;
  }

  if (!version) {
    console.error(
      `\nEdge started but nothing is listening on http://127.0.0.1:${PORT} after 30s.\n\n` +
      `  Profile dir:  ${PROFILE_DIR}\n\n` +
      '  If a browser window did open, the debugging flag was refused. Delete\n' +
      `  the profile dir above and retry, or pick another port:\n` +
      '      $env:CDP_PORT="9223"; npm run edge\n' +
      '      $env:CDP_ENDPOINT="http://127.0.0.1:9223"; npm run live\n\n' +
      '  Or skip Edge entirely:  ATTACH=launch npm start\n'
    );
    process.exit(1);
  }

  console.log(`Edge is listening for CDP on port ${PORT} (${version.Browser}).`);
  console.log(`Profile: ${PROFILE_DIR}`);
  if (firstRun) {
    console.log(
      '\nThis is a fresh profile, so it is signed out. Log into the casino in the\n' +
      'window that just opened — the login persists, and you only do this once.'
    );
  }
  console.log('\nOpen the blackjack table, then run:  npm run live   (or npm run overnight)');
}

main();
