// bash expands `data/feed-*.ndjson`; PowerShell and cmd do not, and npm scripts
// on Windows run through cmd. So the tools expand it themselves.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function expandFiles(patterns) {
  const out = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      // Named file missing but a .gz beside it: compressed after the fact.
      const gz = `${pattern}.gz`;
      out.push(!fs.existsSync(pattern) && fs.existsSync(gz) ? gz : pattern);
      continue;
    }
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    // Escape regex metacharacters, then let `*` mean anything. The optional
    // `.gz` keeps every documented `feed-*.ndjson` command working.
    const rx = new RegExp(
      '^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '(?:\\.gz)?$'
    );
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { /* no such directory */ }
    for (const f of entries) if (rx.test(f)) out.push(path.join(dir, f));
  }
  return [...new Set(out)].sort();
}

export function existingFiles(patterns) {
  return expandFiles(patterns).filter((f) => {
    try { return fs.statSync(f).isFile(); } catch { return false; }
  });
}

// Captures are kept gzipped (~14x on this feed); every reader goes through here.
export function readStream(file) {
  const raw = fs.createReadStream(file);
  return file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
}
