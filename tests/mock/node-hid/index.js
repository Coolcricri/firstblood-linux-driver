// Minimal stand-in for the node-hid module: simulates a wired Firstblood B6 (and an unrelated device that must be ignored).
const EventEmitter = require("events");
let last = null; global.__log = [];
const devices = () => [
  { vendorId: 0x3151, productId: 0x4015, path: "/dev/hidraw7", usagePage: 0xffff, usage: 2, interface: 2 },
  { vendorId: 0x3151, productId: 0x4015, path: "/dev/hidraw6", usagePage: 0xffff, usage: 1, interface: 1 },
  { vendorId: 0x3151, productId: 0x4015, path: "/dev/hidraw5", usagePage: 1, usage: 6, interface: 0 },
  { vendorId: 0x2717, productId: 0x87b1, path: "/dev/hidraw9", usagePage: 0xffff, usage: 2, interface: 2 },   // not a B6: must be ignored
];
class HID extends EventEmitter {
  constructor(p) { super(); this.p = p; }
  sendFeatureReport(a) { if (a.length !== 65 || a[0] !== 0) throw new Error("bad report " + a.length); last = Buffer.from(a.slice(1)); global.__log.push(last); }
  getFeatureReport() { const r = Buffer.alloc(65); if (last && last[0] === 0x8f) { r[1] = 0x8f; r.writeUInt32LE(910, 2); } else if (last) { last.copy(r, 1); } return Array.from(r); }
  close() {}
}
module.exports = { devices, HID, setDriverType() {} };
