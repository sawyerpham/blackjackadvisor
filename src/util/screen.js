// Monitor geometry, so the table and the dashboard can be placed side by side
// without dragging them every session. Windows only; elsewhere monitors()
// returns [] and placement is skipped.
//
// TWO COORDINATE SPACES, and they disagree. Windows reports physical pixels;
// Chromium positions windows in DIPs, which are physical divided by that
// monitor's scale factor. A 4K primary at 150% occupies 0..2560 in DIP space, so
// a second monitor at physical x=3840 starts at DIP x=2560 — placing by the
// physical number puts the window 1280px too far right.
//
// Modelling Chromium's mixed-DPI mapping is a losing game, so we don't: the
// Windows query only gets the window onto the right screen, and then the page
// itself is asked where that screen actually is. See placeSideBySide.

import { execFileSync } from 'node:child_process';

// Per-monitor DPI awareness first, or Screen reports the primary already divided
// by its scale while leaving every other monitor in physical pixels — a mix that
// is wrong in both spaces.
const QUERY = [
  "Add-Type -Name W -Namespace D -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'",
  '[D.W]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
    '"{0},{1},{2},{3},{4}" -f $_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height,$_.Primary }',
].join('; ');

// Spawning PowerShell costs ~200ms and the answer cannot change often enough to
// matter.
let cached;

// PHYSICAL pixels.
export function monitors() {
  if (cached) return cached;
  if (process.platform !== 'win32') return (cached = []);
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    cached = out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [x, y, width, height, primary] = line.split(',');
      return { x: +x, y: +y, width: +width, height: +height, primary: primary === 'True' };
    });
  } catch {
    cached = [];
  }
  return cached;
}

// 'secondary' | 'primary' | 'off' | screen index. Null when off or unknown.
export function pickMonitor(which) {
  if (which === 'off' || which == null) return null;
  const all = monitors();
  if (!all.length) return null;
  if (Number.isInteger(which)) return all[which] ?? null;
  if (which === 'primary') return all.find((m) => m.primary) ?? all[0];
  return all.find((m) => !m.primary) ?? all[0];
}

// Keys are named for Browser.setWindowBounds, which is what does the placing —
// --window-position is only a hint and loses to a profile's remembered geometry.
export function halves({ left, top, width, height }) {
  const half = Math.floor(width / 2);
  return {
    left: { left, top, width: half, height },
    right: { left: left + half, top, width: width - half, height },
  };
}

// PHYSICAL pixels: a starting guess only.
export function sideBySide(which) {
  const m = pickMonitor(which);
  if (!m) return null;
  return { monitor: m, ...halves({ left: m.x, top: m.y, width: m.width, height: m.height }) };
}

// Best effort; never throws.
export async function placeWindow(context, page, bounds) {
  if (!context || !page || !bounds) return false;
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    // A maximized window ignores every other field, so normalise first.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
    return true;
  } catch {
    return false;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

// The working area of whichever screen the page's window is on, in Chromium's
// own DIPs. This is the authority: no DPI arithmetic, right at any scaling.
// avail* rather than width/height so the taskbar is left alone.
export async function screenOfPage(page) {
  try {
    const r = await page.evaluate(() => ({
      left: window.screen.availLeft ?? 0,
      top: window.screen.availTop ?? 0,
      width: window.screen.availWidth,
      height: window.screen.availHeight,
    }));
    return r && r.width > 0 && r.height > 0 ? r : null;
  } catch {
    return null;
  }
}

// Park the window on the target screen, ask that screen where it really is, then
// place exactly. Returns the corrected halves, for a second window.
export async function placeSideBySide(context, page, which) {
  const guess = sideBySide(which);
  if (!guess) return null;

  // Physical coordinates overshoot to the right on a scaled primary, never to
  // the left, so this lands on the target screen even when the numbers are off.
  await placeWindow(context, page, guess.left);

  const real = await screenOfPage(page);
  const place = real ? { monitor: guess.monitor, ...halves(real) } : guess;
  await placeWindow(context, page, place.left);
  return place;
}
