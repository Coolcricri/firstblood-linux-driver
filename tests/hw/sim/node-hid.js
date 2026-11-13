'use strict';
// Protocol simulator of a B6 for validating the harness without hardware (use: FB_HID_MODULE=<this file>).
// Behaviour follows the vendor bundle. SIM_QUIRKS=comma list injects faults: nochk, dropfast, nonatomic, slowprofile,
// pacingcrash (a gap > 50 ms inside a 9-packet matrix write drops the device and wipes config), wipeonled (a LED write < 3 s after a matrix write drops the device and WIPES config to defaults), crashonswitch (a layer switch < 700 ms after a matrix write drops the device off USB for 3 s), slowcommit (matrix commit completes 800 ms after the last packet, into the then-active layer), writeheader (matrix write honours header layer byte; real B6 does not), slowreply, volatile, echomatrix, ifaceminus1, novendorid, swapwire, noledbit8
const EventEmitter = require('events');
const P = require('../lib/proto'), K = require('../lib/keymap');
const quirks = new Set((process.env.SIM_QUIRKS || '').split(',').filter(Boolean));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const S = { present: true, gen: 0, profile: 1, rate: [1, 1, 1], led: [13, 4, 0, 0, 0, 200, 200], debounce: 1, kb: [0, 0, 0], auto: 1,
  mats: [0, 1, 2].map(() => P.defaultMatrix()), macro: Buffer.alloc(256), pending: {}, reply: Buffer.alloc(64), lastTx: 0 };
S.lastMatrix = 0; const sim = { S, quirks, vendor: new Set(), wire: [0, 1, 2, 3, 4, 5], log: [] };
if (quirks.has('swapwire')) sim.wire = [1, 0, 2, 3, 4, 5];
const base = () => 3 + (S.gen % 2) * 10;
const paths = () => ({ typing: '/dev/hidraw' + base(), vendor: '/dev/hidraw' + (base() + 1), cmd: '/dev/hidraw' + (base() + 2) });
function devices() {
  if (!S.present) return []; const p = paths(), v = { vendorId: 0x3151, productId: 0x4015, product: 'B6', release: 0x100 };
  const iface = (n) => (quirks.has('ifaceminus1') ? -1 : n);
  return [{ ...v, path: p.typing, usagePage: 1, usage: 6, interface: iface(0) }, { ...v, path: p.vendor, usagePage: 0xffff, usage: 1, interface: iface(1) },
    { ...v, path: p.cmd, usagePage: 0xffff, usage: 2, interface: iface(2) }, { vendorId: 0x046d, productId: 0xc52b, path: '/dev/hidraw99', usagePage: 1, usage: 6, interface: 0 }];
}
const idx0 = (p) => p[4];
const ok = (p, n) => quirks.has('nochk') || p[n] === ((~[...p.slice(0, n)].reduce((a, b) => a + b, 0)) & 0xff);
function setReply(buf) { if (quirks.has('slowreply')) setTimeout(() => { S.reply = buf; }, 40); else S.reply = buf; }
function handle(p) {
  const t = now(), gap = t - S.lastTx; S.lastTx = t; const op = p[0];
  if (op === 0x09) {                                    // key matrix write packet
    if (quirks.has('pacingcrash') && S.inSeq && gap > 50 && idx0(p) > 0) { S.present = false; setTimeout(() => { S.gen++; S.present = true; S.profile = 0; S.mats = [0, 1, 2].map(() => P.defaultMatrix()); S.led = [3, 2, 4, 0, 255, 255, 255]; }, 3000); S.inSeq = false; return; }
    S.inSeq = p[4] < 8; S.lastMatrix = t; if (quirks.has('dropfast') && gap < 3) return; if (!ok(p, 7)) return;
    const prof = quirks.has('writeheader') ? p[1] % 3 : S.profile, idx = p[4]; const pend = S.pending[prof] || (S.pending[prof] = Buffer.from(S.mats[prof]));
    p.slice(8, 64).copy(pend, idx * 56, 0, Math.min(56, 512 - idx * 56));
    if (quirks.has('slowcommit') && idx === 8) { const data = Buffer.from(pend); delete S.pending[prof]; setTimeout(() => { S.mats[S.profile] = data; }, quirks.has('layer2slow') && S.profile === 2 ? 1700 : 800); return; }   // commit lands in whatever layer is ACTIVE when it completes
    if (quirks.has('nonatomic') || idx === 8) { S.mats[prof] = Buffer.from(pend); delete S.pending[prof]; } return;
  }
  const rep = Buffer.alloc(64); rep[0] = op;
  switch (op) {
    case 0x8f: rep.writeUInt32LE(910, 1); return setReply(rep);
    case 0x80: rep[1] = 0x12; rep[2] = 0x01; return setReply(rep);
    case 0x85: rep[1] = S.profile; return setReply(rep);
    case 0x84: rep[1] = p[1]; rep[2] = S.rate[p[1] % 3]; return setReply(rep);
    case 0x86: rep[1] = p[1]; rep[2] = S.kb[0]; rep[3] = S.kb[1]; rep[4] = S.kb[2]; return setReply(rep);
    case 0x87: Buffer.from(S.led).copy(rep, 1); return setReply(rep);
    case 0x91: rep[2] = S.debounce; return setReply(rep);
    case 0x92: rep[1] = 120; return setReply(rep);
    case 0x97: rep[1] = S.auto; return setReply(rep);
    case 0x89: { const m = S.mats[p[1] % 3].slice(p[2] * 64, p[2] * 64 + 64); const r = Buffer.from(m); if (quirks.has('echomatrix')) r[0] = 0x89; return setReply(r); }
    case 0x8b: return setReply(Buffer.from(S.macro.slice(p[2] * 64, p[2] * 64 + 64)));
    case 0x05: if (!ok(p, 7)) return; if (quirks.has('crashonswitch') && t - S.lastMatrix < 700) { S.present = false; setTimeout(() => { S.gen++; S.present = true; S.profile = 0; }, 3000); return; } if (quirks.has('slowprofile')) setTimeout(() => { S.profile = p[1] % 3; }, 300); else S.profile = p[1] % 3; return;
    case 0x04: if (ok(p, 7)) S.rate[p[1] % 3] = p[2]; return;
    case 0x11: if (ok(p, 7)) S.debounce = p[2]; return;
    case 0x07: if (quirks.has('wipeonled') && t - S.lastMatrix < 3000) { S.present = false; setTimeout(() => { S.gen++; S.present = true; S.profile = 0; S.mats = [0, 1, 2].map(() => P.defaultMatrix()); S.led = [3, 2, 4, 0, 255, 255, 255]; }, 3000); return; } if (quirks.has('noledbit8') ? ok(p, 7) : ok(p, 8)) S.led = [...p.slice(1, 8)]; return;
    case 0x16: if (!ok(p, 7)) return; S.macro.fill(0, p[2] * 56 >= 256 ? 255 : p[2] * 56, Math.min(256, p[2] * 56 + 56)); p.slice(8, 64).copy(S.macro, p[2] * 56, 0, Math.max(0, Math.min(56, 256 - p[2] * 56))); return;
    default: sim.log.push('unhandled op 0x' + op.toString(16));
  }
}
class HID extends EventEmitter {
  constructor(path) { super(); const d = devices().find((x) => x.path === path); if (!d) throw new Error('cannot open ' + path); this.path = path; this.d = d; if (d.usage === 1 && d.usagePage === 0xffff) sim.vendor.add(this); }
  sendFeatureReport(a) { if (!devices().some((x) => x.path === this.path)) throw new Error('could not send feature report to device: ioctl (SFEATURE): No such device'); if (this.d.usage !== 2) throw new Error('not command interface'); if (a.length !== 65 || a[0] !== 0) throw new Error('bad report'); handle(Buffer.from(a.slice(1))); return a.length; }
  getFeatureReport() { if (!devices().some((x) => x.path === this.path)) throw new Error('could not get feature report from device: ioctl (GFEATURE): Protocol error'); if (this.d.usage !== 2) throw new Error('not command interface'); return [0, ...S.reply]; }
  close() { sim.vendor.delete(this); }
}
function emit(bytes) { const b = quirks.has('novendorid') ? Buffer.from(bytes) : Buffer.concat([Buffer.from([5]), Buffer.from(bytes)]); for (const h of sim.vendor) h.emit('data', b); }
// operator pressing physical button i (0..5 = PHYS order) -> evdev codes
sim.press = (i) => {
  const e = P.entryAt(S.mats[S.profile], sim.wire[i] === undefined ? 99 : P.PHYS[sim.wire[i]].slot), t = e[0];
  if (t === 6) emit([e[1], e[2], e[3]]);
  if (t === 8) { S.profile = e[2] === 1 ? (S.profile + 1) % 3 : e[2] === 2 ? (S.profile + 2) % 3 : (S.profile + 1) % 3; emit([1, S.profile, 0]); }
  return K.entryToKeys(e) || [];
};
sim.replug = async (ms = 800) => { S.present = false; await new Promise((r) => setTimeout(r, ms)); S.gen++; S.present = true;
  if (quirks.has('volatile')) { S.mats = [0, 1, 2].map(() => P.defaultMatrix()); S.profile = 0; } };
module.exports = { devices, HID, setDriverType() {}, sim };
