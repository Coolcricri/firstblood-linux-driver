'use strict';
// Observes what the keyboard types. 'evdev' reads /dev/input/event* nodes of 3151:4015 (read-only, no grab).
// 'sim' asks the simulator. Real runs need read access to those nodes (see README).
const fs = require('fs');
const P = require('./proto');
function evdevNodes() {
  let txt; try { txt = fs.readFileSync('/proc/bus/input/devices', 'utf8'); } catch (e) { return []; }
  return txt.split(/\n\n/).filter((b) => /Vendor=3151 Product=4015/.test(b)).map((b) => (/Handlers=.*?(event\d+)/.exec(b) || [])[1]).filter(Boolean).map((e) => '/dev/input/' + e);
}
class Evdev {
  constructor(nodes) { this.nodes = nodes; this.ev = []; this.fds = []; this.kind = 'evdev'; this.raw = 0; }
  start() {
    if (process.stdin.isTTY) require('child_process').spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });   // keys typed by the test must not echo into the terminal
    for (const n of this.nodes) this.fds.push(fs.openSync(n, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK));
    this.timer = setInterval(() => this.poll(), 4);
  }
  poll() {
    const buf = Buffer.alloc(24 * 64);
    for (const fd of this.fds) for (;;) {
      let n; try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') break; throw e; }
      if (!n) break;
      for (let o = 0; o + 24 <= n; o += 24) { const type = buf.readUInt16LE(o + 16), code = buf.readUInt16LE(o + 18), val = buf.readInt32LE(o + 20); if (type === 1 && val !== 2) { this.ev.push({ code, val, t: Date.now() }); this.raw++; } }
    }
  }
  stop() { clearInterval(this.timer); this.fds.forEach((f) => { try { fs.closeSync(f); } catch (e) {} }); if (process.stdin.isTTY) require('child_process').spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); }
  async capture(label, { timeoutMs = 20000, settleMs = 500 } = {}) {
    process.stdout.write(`     >>> PRESS and RELEASE: ${label}  (waiting up to ${timeoutMs / 1000}s) `); await P.sleep(200); this.poll(); this.ev.length = 0;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { await P.sleep(20); const l = this.ev[this.ev.length - 1]; if (l && Date.now() - l.t > settleMs && this.ev.some((e) => e.val === 1)) break; }
    const down = [...new Set(this.ev.filter((e) => e.val === 1).map((e) => e.code))].sort((a, b) => a - b); console.log('-> ' + (down.length ? 'got ' + down.join(',') : 'nothing'));
    return down;
  }
}
class Sim {
  constructor() { this.kind = 'sim'; this.sim = require(process.env.FB_HID_MODULE).sim; }
  start() {} stop() {}
  async capture(label) { const i = P.PHYS.findIndex((p) => label.startsWith(p.name)); await P.sleep(5); return this.sim.press(i).slice().sort((a, b) => a - b); }
}
function make(kind) {
  if (process.env.FB_HID_MODULE && /sim/.test(process.env.FB_HID_MODULE)) return new Sim();
  if (kind === 'none') return null;
  const nodes = evdevNodes(); if (!nodes.length) return null;
  try { const o = new Evdev(nodes); o.start(); return o; } catch (e) { console.log('  (cannot read ' + nodes.join(', ') + ': ' + e.code + ' -> e.g. sudo setfacl -m u:$USER:r ' + nodes.join(' ') + ')'); return null; }
}
module.exports = { make, evdevNodes };
