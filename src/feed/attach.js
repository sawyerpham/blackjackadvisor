// A stream of parsed bj.* messages out of a browser. Owns browser acquisition,
// socket filtering, token redaction and JSON parsing, and nothing else: no
// tracker state, no disk writes, no HUD.
//
//   const feed = await attachFeed({ onMessage: (m, ts) => tracker.handle(m, ts) });
//   await feed.close();

import { chromium } from 'playwright';
import path from 'node:path';
import config from '../config.js';
import { fromRoot } from '../util/paths.js';
import { sideBySide, placeSideBySide } from '../util/screen.js';

export const DEFAULT_URL = config.tableUrl;

// Session tokens ride in query strings. Keep them out of logs and screenshots.
export function redact(url) {
  return String(url).replace(/([?&](?:token|jwt|auth|sid|session)=)[^&]+/gi, '$1<redacted>');
}

// Video and chat sockets carry no cards and would bloat the log.
const IGNORE = new RegExp(config.ignoreWs, 'i');

// cdp mode attaches to a browser you are also using, so without an allow-list
// every other tab would be recorded too. Unset means anything not ignored.
const ALLOW = config.allowWs ? new RegExp(config.allowWs, 'i') : null;

export async function attachFeed(opts = {}) {
  // launch by default. cdp existed to attach to your everyday Edge profile, but
  // Chromium 136 refuses --remote-debugging-port on the default profile, so cdp
  // needs a dedicated one too and has no advantage left. Tracking never needed a
  // login: the feed streams to spectators. Kept for when the bot-check rejects
  // an automated browser:  ATTACH=cdp npm run live
  const mode = opts.mode || process.env.ATTACH || 'launch';
  const url = opts.url || DEFAULT_URL;
  if (!url) {
    throw new Error('No table URL. Copy local.config.example.js to ' +
                    'local.config.js and set tableUrl, or set TABLE_URL.');
  }
  const onMessage = opts.onMessage || (() => {});
  const onFrame = opts.onFrame || (() => {});
  const onSocket = opts.onSocket || (() => {});

  function handleFrame(direction, socketUrl, payload) {
    onFrame(direction, redact(socketUrl), payload);
    if (direction !== 'recv' || typeof payload !== 'string') return;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    const ts = Date.now();
    for (const m of Array.isArray(msg) ? msg : [msg]) onMessage(m, ts);
  }

  // A page can reach attachPage from more than one event source; without this
  // guard every frame is delivered twice.
  const attached = new WeakSet();
  function attachPage(page) {
    if (!page || attached.has(page)) return;
    attached.add(page);
    page.on('websocket', (ws) => {
      const wsUrl = ws.url();
      if (ALLOW && !ALLOW.test(wsUrl)) {
        // Some other tab. Not ours to read or log.
        onSocket('skipped', redact(wsUrl));
        return;
      }
      if (IGNORE.test(wsUrl)) {
        onSocket('ignored', redact(wsUrl));
        return;
      }
      onSocket('open', redact(wsUrl));
      ws.on('framereceived', (f) => handleFrame('recv', wsUrl, f.payload));
      ws.on('framesent', (f) => handleFrame('send', wsUrl, f.payload));
      ws.on('close', () => onSocket('closed', redact(wsUrl)));
    });
  }

  if (mode === 'cdp') {
    const endpoint = opts.endpoint || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
    let browser;
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch (cause) {
      // The most common first-run failure by far. Playwright's own error is a
      // stack trace about websocket URLs, which tells you nothing.
      const err = new Error(
        `No browser is listening on ${endpoint}.\n\n` +
        `  Start one:   npm run edge\n` +
        `  (or  .\\start-edge.cmd  — PowerShell will not run a script in the\n` +
        `   current directory without the leading  .\\ )\n\n` +
        `  npm run edge now waits for the port and fails loudly if it never\n` +
        `  opens, so if it printed "Edge is listening", the browser is fine and\n` +
        `  the mismatch is the endpoint: this process wants ${endpoint}.\n` +
        `  Set CDP_ENDPOINT if you started Edge on a different port.\n\n` +
        `  You do NOT need to close your ordinary Edge windows. The launcher\n` +
        `  uses its own --user-data-dir, which is both what makes the debugging\n` +
        `  port work at all on Edge 136+ and what lets it run alongside yours.\n\n` +
        `  Or use a dedicated browser instead, e.g.  ATTACH=launch npm start`
      );
      err.code = 'NO_CDP';
      err.cause = cause;
      throw err;
    }

    const pages = [];
    for (const ctx of browser.contexts()) {
      ctx.on('page', attachPage);
      for (const p of ctx.pages()) { attachPage(p); pages.push(p); }
    }

    // page.on('websocket') only fires for sockets opened AFTER we attach, so a
    // tab already running the table is invisible to us. Reloading recreates the
    // sockets — and trust requires seeing a shoe from a clean reshuffle anyway.
    if (opts.reload !== false) {
      const host = new URL(url).host;
      for (const p of pages) {
        let sameSite = false;
        try { sameSite = new URL(p.url()).host === host; } catch { /* about:blank */ }
        if (sameSite) await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    const cdpContext = browser.contexts()[0] ?? null;
    const cdpPlace = (cdpContext && pages[0])
      ? await placeSideBySide(cdpContext, pages[0], config.windowMonitor)
      : null;

    return {
      mode,
      pageCount: pages.length,
      // Exposed so the caller can open the dashboard in this same browser.
      context: cdpContext,
      page: pages[0] ?? null,
      place: cdpPlace,
      // Deliberately no browser.close(): we do not own this browser, and
      // playwright's CDP close() has taken the browser down in some versions.
      async close() { /* no-op by design; see above */ },
    };
  }

  if (mode !== 'launch') throw new Error(`unknown ATTACH mode: ${mode} (want 'cdp' or 'launch')`);

  let place = sideBySide(config.windowMonitor);
  const profileDir = opts.profileDir || process.env.PROFILE_DIR || fromRoot('.profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: opts.channel || process.env.BROWSER_CHANNEL || 'msedge',
    headless: false,
    viewport: null,
    // Playwright defaults this to false, which passes --no-sandbox and makes the
    // browser show an "unsupported flag" banner. We log into a real site in this
    // window, so keep the renderer sandbox on.
    chromiumSandbox: true,
    // --enable-automation is a Playwright default and is very likely why the
    // site's auth bot-check refuses to let you log in inside this window.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      // Half a screen when we know the geometry, maximized otherwise.
      ...(place
        ? [`--window-position=${place.left.left},${place.left.top}`,
           `--window-size=${place.left.width},${place.left.height}`]
        : ['--start-maximized']),
      '--disable-blink-features=AutomationControlled',
    ],
  });

  context.on('page', attachPage);
  for (const p of context.pages()) attachPage(p);
  const page = context.pages()[0] || (await context.newPage());
  attachPage(page);

  // Two corrections in one: the profile remembers its last geometry and that
  // beats --window-position, and the args above are physical pixels rather than
  // the DIPs Chromium actually places in. The page settles both.
  if (place) place = (await placeSideBySide(context, page, config.windowMonitor)) ?? place;

  if (opts.navigate !== false) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
      onSocket('naverror', e.message);
    });
  }

  return {
    mode,
    context,
    page,
    place,
    async close() { await context.close().catch(() => {}); },
  };
}
