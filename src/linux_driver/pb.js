'use strict';
// Minimal protobuf wire encoder/decoder (only what the driver API needs).
function varint(n) { n = BigInt(n); if (n < 0n) n += (1n << 64n); const o = []; while (n > 0x7fn) { o.push(Number(n & 0x7fn) | 0x80); n >>= 7n; } o.push(Number(n)); return Buffer.from(o); }
function tag(f, w) { return varint((f << 3) | w); }
const enc = {
  uint(f, v) { return v ? Buffer.concat([tag(f, 0), varint(v)]) : Buffer.alloc(0); },
  bool(f, v) { return v ? Buffer.concat([tag(f, 0), Buffer.from([1])]) : Buffer.alloc(0); },
  str(f, s) { if (!s) return Buffer.alloc(0); const b = Buffer.from(s, 'utf8'); return Buffer.concat([tag(f, 2), varint(b.length), b]); },
  bytes(f, b) { if (!b || !b.length) return Buffer.alloc(0); b = Buffer.from(b); return Buffer.concat([tag(f, 2), varint(b.length), b]); },
  msg(f, b) { return Buffer.concat([tag(f, 2), varint(b.length), b]); },
  float(f, v) { if (!v) return Buffer.alloc(0); const b = Buffer.alloc(4); b.writeFloatLE(v); return Buffer.concat([tag(f, 5), b]); },
};
function decode(buf) {
  const out = {}; let i = 0;
  const rv = () => { let r = 0n, s = 0n; for (;;) { const b = buf[i++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return r; };
  while (i < buf.length) {
    const t = Number(rv()), f = t >> 3, w = t & 7; let v;
    if (w === 0) v = Number(rv());
    else if (w === 2) { const l = Number(rv()); v = buf.slice(i, i + l); i += l; }
    else if (w === 5) { v = buf.readFloatLE(i); i += 4; }
    else if (w === 1) { v = buf.slice(i, i + 8); i += 8; }
    else break;
    (out[f] = out[f] || []).push(v);
  }
  return out;
}
const first = (m, f, d) => (m[f] && m[f].length ? m[f][0] : d);
const str = (m, f) => { const v = first(m, f); return v === undefined ? '' : Buffer.from(v).toString('utf8'); };
module.exports = { enc, decode, first, str };
