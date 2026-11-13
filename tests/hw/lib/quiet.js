'use strict';
// Safety rule learned from real-hardware runs: after a key-matrix write the B6 needs ~2 s to commit (B9) and the firmware has dropped
// off USB and wiped its configuration twice when other commands arrived soon after a commit (B8, B7). So any non-read command waits
// until QUIET ms after the last matrix packet (FB_QUIET_MS, default 3500). Reads and further matrix packets are not delayed.
const hr = () => Number(process.hrtime.bigint()) / 1e6;
const st = { last: 0, quietMs: Number(process.env.FB_QUIET_MS || 3500), off: false, ring: [] };
const WRITE_OPS = new Set([0x04, 0x05, 0x06, 0x07, 0x11, 0x12, 0x16, 0x17]);
async function before(op) { if (!st.off && WRITE_OPS.has(op)) { const w = st.quietMs - (hr() - st.last); if (w > 0) await new Promise((r) => setTimeout(r, w)); } }
function note(op, b1, via = 'link') { const t = hr(); if (op === 0x09) st.last = t; st.ring.push({ t, op, b1, via }); if (st.ring.length > 60) st.ring.shift(); }
function dump(n = 25) { const e = hr(); return st.ring.slice(-n).map((r) => `${((r.t - e) / 1000).toFixed(2).padStart(7)} s  op 0x${r.op.toString(16).padStart(2, '0')} arg 0x${(r.b1 || 0).toString(16).padStart(2, '0')}  (${r.via})`).join('\n'); }
module.exports = { st, before, note, dump };
