'use strict';
const BIT7 = 0, BIT8 = 1, NONE = 2;
// Same behaviour as the vendor driver: payload is padded to 64 bytes, then
// BIT7: buf[7] = ~sum(buf[0..7]);  BIT8: buf[8] = ~sum(buf[0..8]).
function build(msg, type) {
  const buf = Buffer.alloc(64);
  Buffer.from(msg).copy(buf, 0, 0, 64);
  const n = type === BIT7 ? 7 : type === BIT8 ? 8 : 0;
  if (n) { let s = 0; for (let i = 0; i < n; i++) s += buf[i]; buf[n] = (~s) & 0xff; }
  return buf;
}
module.exports = { build, BIT7, BIT8, NONE };
