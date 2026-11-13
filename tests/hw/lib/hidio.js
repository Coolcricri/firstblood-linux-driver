'use strict';
const fs = require('fs'), path = require('path');
const P = require('./proto'), Q = require('./quiet');
function loadHID() {
  if (process.env.FB_HID_MODULE) return require(process.env.FB_HID_MODULE);
  for (const base of [__dirname + '/..', __dirname + '/../..', __dirname + '/../../..', process.cwd()]) {
    try { const f = require.resolve('node-hid', { paths: [base] }); process.env.FB_HID_MODULE = f; return require(f); } catch (e) {}
  }
  throw new Error('node-hid not found. In tests/hw run: npm install node-hid@3.4.0   (or set FB_HID_MODULE)');
}
// Same predicates as src/linux_driver/hid.js (restated here on purpose).
const isCmd = (d) => d.vendorId === P.VID && d.productId === P.PID && d.usagePage === 0xffff && d.usage === 2;
const isVendor = (d) => d.vendorId === P.VID && d.productId === P.PID && d.usagePage === 0xffff && d.usage === 1 && d.interface === 1;
function guard(op, flags = {}) {
  if (P.FIRMWARE_CLASS.has(op)) throw new Error(`REFUSED: opcode 0x${op.toString(16)} is firmware-class (${P.FIRMWARE_CLASS.get(op)})`);
  if (op === P.FACTORY_RESET) throw new Error('REFUSED: opcode 0x02 is factory reset; this harness never sends it');
}
class Link {
  constructor(HID, devPath) { this.HID = HID; this.path = devPath; this.h = null; this.txCount = 0; }
  open() { if (!this.h) this.h = new this.HID.HID(this.path); return this.h; }
  close() { try { this.h && this.h.close(); } catch (e) {} this.h = null; }
  tx(f) { guard(f[0]); Q.note(f[0], f[1]); this.open().sendFeatureReport([0, ...f]); this.txCount++; }
  rxRaw() { return Buffer.from(this.open().getFeatureReport(0, 65)); }
  rx() { const r = this.rxRaw(); return r.length === 65 ? r.slice(1) : r; }
  // vendor-style transaction: sleep pre, send, sleep post, ONE read
  async xfer(f, { pre = 10, post = 5 } = {}) { await P.sleep(pre); this.tx(f); await P.sleep(post); return this.rx(); }
  // measurement transaction: first read like the vendor, then keep polling for an echo of the opcode
  async probe(f, { pre = 10, post = 5, pollMs = 400 } = {}) {
    await P.sleep(pre); const t0 = process.hrtime.bigint(); this.tx(f); await P.sleep(post);
    const first = this.rx(); const echoFirst = first[0] === f[0]; let lateMs = null, last = first;
    if (!echoFirst) { const end = Date.now() + pollMs; while (Date.now() < end) { await P.sleep(3); last = this.rx(); if (last[0] === f[0]) { lateMs = Number(process.hrtime.bigint() - t0) / 1e6; break; } } }
    return { first, echoFirst, lateMs, last };
  }
  async write(f, o) { await Q.before(f[0]); await P.sleep(o && o.pre !== undefined ? o.pre : 10); this.tx(f); }
  async readMatrix(profile) { const out = []; for (let i = 0; i < P.MATRIX_PKTS; i++) out.push(await this.xfer(P.frame([P.OP.GET_KEYMATRIX, profile, i], 'bit7'))); return Buffer.concat(out); }
  async active() { return (await this.get(P.OP.GET_PROFILE))[1]; }
  // Measured on a real B6: matrix writes land in the ACTIVE layer whatever the header's layer byte says, so select the layer first.
  // Device applies the write to the ACTIVE layer (select first) and commits ~asynchronously (vendor waits BIGCMDDELAY=1000 ms).
  // confirm (default): poll until the data is visible, then wait `extra` ms; lastCommit = {ok, ms since last packet}. confirm:false = fixed `settle`.
  async writeMatrix(profile, m, { gap = 10, chk = 'ok', settle = 1000, noSwitch = false, confirm = true, maxMs = 8000, extra = 500 } = {}) {
    if (!noSwitch && (await this.active()) !== profile) await this.setProfile(profile, 500);
    let gi = 0; for (const p of P.matrixPackets(profile, m, chk)) { await P.sleep(Array.isArray(gap) ? gap[gi] : gap); gi++; this.tx(p); }
    const t0 = process.hrtime.bigint();
    if (!confirm) { await P.sleep(settle); return undefined; }
    await P.sleep(200); let ok = false;
    for (;;) { if (Buffer.compare((await this.readMatrix(profile)).slice(0, 504), Buffer.from(m).slice(0, 504)) === 0) { ok = true; break; } if (Number(process.hrtime.bigint() - t0) / 1e6 > maxMs) break; await P.sleep(100); }
    this.lastCommit = { ok, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) }; await P.sleep(extra); return ok;
  }
  async get(op, ...args) { return this.xfer(P.frame([op, ...args], 'bit7')); }
  async setProfile(p, settle = 500) { await this.write(P.frame([P.OP.SET_PROFILE, p], 'bit7')); await P.sleep(settle); }
  async readMacro(slot) { const o = []; for (let r = 0; r < 4; r++) o.push(await this.xfer(P.frame([P.OP.GET_MACRO, slot, r], 'bit7'))); return Buffer.concat(o); }
  async writeMacro(slot, b256, minPkts = 1) { await Q.before(0x16); for (const p of P.macroPackets(slot, b256, minPkts)) { await P.sleep(10); this.tx(p); } await P.sleep(500); }
}
module.exports = { loadHID, isCmd, isVendor, Link, guard };
