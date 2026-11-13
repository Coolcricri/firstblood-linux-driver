'use strict';
// Regression tests for findings from the first real-B6 run (tests/hw): no-echo matrix replies must not stall, firmware-class opcodes blocked.
const path = require('path'), assert = require('assert');
process.env.FB_HID_MODULE = path.join(__dirname, 'hw/sim/node-hid.js'); process.env.FB_DRIVER_PORT = '38152'; delete process.env.FB_ALLOW_FIRMWARE;
const G = require('./hw/lib/grpcweb'), P = require('./hw/lib/proto'), sim = require('./hw/sim/node-hid');
const drv = require('../src/linux_driver/driver'); drv.start();
let n = 0; const ok = (m) => { n++; console.log('  ok  ', m); };
(async () => {
  await P.sleep(1500); const dev = sim.devices().find((d) => d.usage === 2).path;
  let t0 = Date.now(), parts = [];
  for (let i = 0; i < 8; i++) { assert.strictEqual(await G.sendMsg(38152, dev, Buffer.from([0x89, 0, i]), 0), ''); parts.push(await G.readMsg(38152, dev)); }
  const t = Date.now() - t0; assert(t < 600, `8 matrix packets took ${t} ms (echo-wait stall?)`); assert.deepStrictEqual(Buffer.concat(parts), sim.sim.S.mats[0]); ok(`matrix read (no-echo replies) is fast (${t} ms) and byte-exact`);
  await G.sendMsg(38152, dev, Buffer.from([0x85]), 0); const r = await G.readMsg(38152, dev); assert.strictEqual(r[0], 0x85); assert.strictEqual(r[1], sim.sim.S.profile); ok('echoing getter (0x85) still returns its echoed reply');
  for (const op of [0x7f, 0x2c, 0xac, 0x40, 0x41, 0x30, 0x31]) { sim.sim.log.length = 0; const e = await G.sendMsg(38152, dev, Buffer.from([op, 0x55, 0xaa]), 0); assert(/^blocked/.test(e), `0x${op.toString(16)} not blocked`); assert.strictEqual(sim.sim.log.length, 0); }
  ok('firmware-class opcodes 0x7F 0x2C 0xAC 0x40 0x41 0x30 0x31 are blocked and never reach the device');
  console.log(`readpath: all ${n} tests passed`); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
