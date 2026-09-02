// Records the SHAPE of the feed, split by seated vs spectating: every field path
// seen, tagged with which state it arrived in, so the two can be diffed without
// reading 10MB of JSON by hand.

// Seat letters and game/message ids would otherwise explode into one path per
// seat and per round, burying the actual structure.
const SEAT_KEY = /^[A-G]$/;
const ID_KEY = /^[GM]\d{14}[A-Za-z0-9]+$/;

function collapse(key) {
  if (SEAT_KEY.test(key)) return '<seat>';
  if (ID_KEY.test(key)) return '<id>';
  return key;
}

export class SchemaRecorder {
  constructor({ maxDepth = 6 } = {}) {
    this.maxDepth = maxDepth;
    this.types = new Map();       // _t -> { spectating, seated }
    this.paths = new Map();       // "_t path" -> { n, spectating, seated, sample, type }
  }

  record(msg, seated) {
    if (!msg || typeof msg !== 'object') return;
    const t = typeof msg._t === 'string' ? msg._t : '(untyped)';

    let tc = this.types.get(t);
    if (!tc) { tc = { spectating: 0, seated: 0 }; this.types.set(t, tc); }
    tc[seated ? 'seated' : 'spectating'] += 1;

    this.#walk(t, '', msg, seated, 0);
  }

  #walk(t, prefix, value, seated, depth) {
    if (depth > this.maxDepth) return;
    if (Array.isArray(value)) {
      this.#note(t, `${prefix}[]`, value.length ? typeof value[0] : 'empty', seated, undefined);
      // one representative element is enough to learn the element shape
      if (value.length) this.#walk(t, `${prefix}[]`, value[0], seated, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${collapse(k)}` : collapse(k);
        if (v && typeof v === 'object') {
          this.#note(t, path, Array.isArray(v) ? 'array' : 'object', seated, undefined);
          this.#walk(t, path, v, seated, depth + 1);
        } else {
          this.#note(t, path, v === null ? 'null' : typeof v, seated, v);
        }
      }
      return;
    }
    this.#note(t, prefix || '(scalar)', typeof value, seated, value);
  }

  #note(t, path, type, seated, sample) {
    const key = `${t} ${path}`;
    let e = this.paths.get(key);
    if (!e) {
      e = { type: t, path, kind: type, n: 0, spectating: 0, seated: 0, samples: [] };
      this.paths.set(key, e);
    }
    e.n += 1;
    e[seated ? 'seated' : 'spectating'] += 1;
    if (sample !== undefined && e.samples.length < 3 && !e.samples.includes(sample)) {
      e.samples.push(sample);
    }
  }

  // Message types and field paths that ONLY ever showed up while seated.
  seatedOnly() {
    const types = [...this.types.entries()]
      .filter(([, c]) => c.seated > 0 && c.spectating === 0)
      .map(([t, c]) => ({ type: t, count: c.seated }));
    const paths = [...this.paths.values()]
      .filter((e) => e.seated > 0 && e.spectating === 0)
      .sort((a, b) => b.seated - a.seated);
    return { types, paths };
  }

  everSeated() {
    for (const c of this.types.values()) if (c.seated > 0) return true;
    return false;
  }

  toJSON() {
    return {
      types: Object.fromEntries(this.types),
      paths: [...this.paths.values()].sort((a, b) =>
        a.type.localeCompare(b.type) || a.path.localeCompare(b.path)),
      seatedOnly: this.seatedOnly(),
    };
  }

  report() {
    const lines = [];
    if (!this.everSeated()) {
      lines.push('  never seated this session — nothing to compare.');
      lines.push('  Sit down for one round and the seated-only fields will show up here.');
      return lines.join('\n');
    }
    const { types, paths } = this.seatedOnly();
    if (!types.length && !paths.length) {
      lines.push('  no new message types or fields appeared while seated.');
      lines.push('  The feed looks identical whether you play or watch.');
      return lines.join('\n');
    }
    if (types.length) {
      lines.push('  message types seen ONLY while seated:');
      for (const t of types) lines.push(`    ${t.type.padEnd(28)} ${t.count}x`);
    }
    if (paths.length) {
      lines.push('  fields seen ONLY while seated:');
      for (const p of paths.slice(0, 40)) {
        const s = p.samples.length ? `  e.g. ${p.samples.map((x) => JSON.stringify(x)).join(', ')}` : '';
        lines.push(`    ${(p.type + ' ' + p.path).padEnd(52)} ${String(p.seated).padStart(4)}x ${p.kind}${s}`);
      }
      if (paths.length > 40) lines.push(`    ... and ${paths.length - 40} more (see the .schema.json)`);
    }
    return lines.join('\n');
  }
}
