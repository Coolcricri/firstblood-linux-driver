'use strict';
const HID = require(process.env.FB_HID_MODULE || 'node-hid');
const checksum = require('./checksum');

// FB_DEBUG=1 logs frames; FB_DEBUG=2 also prefixes each line with a millisecond timestamp (@ms) so packet pacing can be analysed (tests/hw/analyze-log.js)
const log = (...a) => { if (process.env.FB_DEBUG) console.error('[fb-driver]', ...(process.env.FB_DEBUG === '2' ? ['@' + Math.round(performance.now())] : []), ...a); };
const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();

// This build supports the Firstblood B6 (6-button pad, wired): VID 0x3151, PID 0x4015.
// Extra devices can be allowed for testing with FB_EXTRA_DEVICES="3151:4015,..." (hex vid:pid list).
const WIRED = [[0x3151, 0x4015]];
for (const x of (process.env.FB_EXTRA_DEVICES || '').split(',').filter(Boolean)) { const [v, p] = x.split(':').map((h) => parseInt(h, 16)); if (v && p) WIRED.push([v, p]); }
const isWired = (d) => WIRED.some(([v, p]) => v === d.vendorId && p === d.productId) &&
  d.usagePage === 0xffff && d.usage === 2;
const isVender = (d) => d.usagePage === 0xffff && d.usage === 1 && d.interface === 1 &&
  WIRED.some(([v, p]) => v === d.vendorId && p === d.productId);

const SEND_DELAY = Number(process.env.FB_SEND_DELAY_MS || 8);
const READ_POLL = Number(process.env.FB_READ_POLL_MS || 400);
// Replies that are raw data and do NOT echo the command byte (measured on a real B6, tests/hw A5): key-matrix reads (0x89)
// and macro reads (0x8B). Waiting for an echo on these only burns READ_POLL (400 ms) per 64-byte packet.
const NO_ECHO = new Set([0x89, 0x8b].concat((process.env.FB_NO_ECHO_CMDS || '').split(',').filter(Boolean).map((x) => parseInt(x, 16))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Dev {
  constructor(info) { this.info = info; this.path = info.path; this.h = null; this.id = 0; this.q = Promise.resolve(); }
  open() { if (!this.h) this.h = new HID.HID(this.path); return this.h; }
  close() { try { this.h && this.h.close(); } catch (e) {} this.h = null; }
  // serialise all hardware access for this device
  lock(fn) { const run = this.q.then(fn, fn); this.q = run.catch(() => {}); return run; }
  _send(buf64) {
    const rep = Buffer.concat([Buffer.from([0]), buf64]); // report id 0 + 64 bytes
    log('TX', hex(buf64.slice(0, 16)));
    this.open().sendFeatureReport(Array.from(rep));
  }
  _get() {
    const r = Buffer.from(this.open().getFeatureReport(0, 65));
    const out = r.length === 65 ? r.slice(1) : r;
    log('RX', hex(out.slice(0, 16)));
    return out;
  }
  send(msg, type) { return this.lock(async () => { this.lastCmd = Buffer.from(msg)[0]; this._send(checksum.build(msg, type)); await sleep(SEND_DELAY); }); }
  // The keyboard answers a command by echoing it in byte 0. Poll until the answer to the last command is
  // ready, so a slow reply is never mistaken for an empty/stale one (which would make the UI cache empty layers).
  read() {
    return this.lock(async () => {
      const want = this.lastCmd; this.lastCmd = undefined;
      let r = this._get();
      if (want === undefined || NO_ECHO.has(want)) return r;
      const end = Date.now() + READ_POLL;
      while (r[0] !== want && Date.now() < end) { await sleep(3); r = this._get(); }
      if (r[0] !== want) log('read: no echo of cmd', want.toString(16), 'got', hex(r.slice(0, 8)));
      return r;
    });
  }
  sendRaw(msg) { return this.lock(async () => { log('TXraw', hex(Buffer.from(msg).slice(0, 16))); this.open().sendFeatureReport(Array.from(msg)); await sleep(SEND_DELAY); }); }
  async queryId() {
    // vendor driver: send 0x8F, id = u32 LE of response bytes 1..4
    this.error = '';
    for (const type of [checksum.BIT7, checksum.NONE]) {
      try {
        await this.send(Buffer.from([0x8f]), type);
        await sleep(10);
        const r = await this.read();
        if (r[0] === 0x8f) { this.id = r.readUInt32LE(1); this.error = ''; return this.id; }
        this.error = 'unexpected reply to ID request: ' + hex(r.slice(0, 12));
      } catch (e) { this.error = e.message || String(e); log('queryId error', this.error); if (/permission|denied|cannot open|EACCES/i.test(this.error)) break; }
    }
    return 0;
  }
}

class Manager {
  constructor() { this.devs = new Map(); this.listeners = new Set(); this.vender = new Set(); this.venderHandles = new Map(); this.first = true; this.timer = null; this.denied = new Set(); this.onDenied = null; }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), 1000); }
  list() { return [...this.devs.values()].filter((d) => d.id); }
  async poll() {
    if (this._busy) return; this._busy = true;
    try {
      let all = []; try { all = HID.devices(); } catch (e) { log('enumerate failed', e.message); }
      const now = new Map(all.filter(isWired).map((d) => [d.path, d]));
      let changed = false;
      for (const [p, d] of this.devs) if (!now.has(p)) { d.close(); this.devs.delete(p); changed = 'remove'; log('removed', p); }
      for (const p of [...this.denied]) if (!now.has(p)) this.denied.delete(p);
      for (const [p, info] of now) {
        if (this.devs.has(p)) continue;
        const dev = new Dev(info);
        try { await dev.queryId(); } catch (e) { log('open failed', p, e.message); dev.error = e.message; }
        const isPerm = /permission|denied|cannot open|EACCES/i.test(dev.error || '');
        if (isPerm) { if (!this.denied.has(p)) { this.denied.add(p); if (this.onDenied) this.onDenied(p); } } else this.denied.delete(p);
        if (dev.id) { this.denied.delete(p); this.devs.set(p, dev); changed = changed || 'add'; log('added', p, 'id', dev.id); }
        else { dev.close(); if (this._warned !== p + dev.error) { console.error(`[fb-driver] found ${p} (${info.vendorId.toString(16)}:${info.productId.toString(16)}) but could not read its ID: ${dev.error || 'no reply'}${/permission|denied|cannot open|EACCES/i.test(dev.error || '') ? ' -> permission problem: run the AppImage with --install-udev-rules, or temporarily: sudo chmod a+rw ' + p : ''}`); this._warned = p + dev.error; } }
      }
      this.syncVender(all);
      if (changed || this.first) { this.emit(this.first ? 0 : changed === 'add' ? 1 : changed === 'remove' ? 2 : 3); this.first = false; }
    } finally { this._busy = false; }
  }
  syncVender(all) {
    if (!this.vender.size) return;
    const wanted = new Map(all.filter(isVender).map((d) => [d.path, d]));
    for (const [p, h] of this.venderHandles) if (!wanted.has(p)) { try { h.close(); } catch (e) {} this.venderHandles.delete(p); }
    for (const [p] of wanted) {
      if (this.venderHandles.has(p)) continue;
      try {
        const h = new HID.HID(p);
        h.on('data', (d) => { for (const cb of this.vender) cb(Buffer.from(d)); });
        h.on('error', () => { try { h.close(); } catch (e) {} this.venderHandles.delete(p); });
        this.venderHandles.set(p, h);
      } catch (e) { log('vender open failed', e.message); }
    }
  }
  emit(type) { for (const cb of this.listeners) cb(this.list(), type); }
  get(path) { const d = this.devs.get(path); if (!d) throw new Error('device not found: ' + path); return d; }
}
module.exports = { Manager };
