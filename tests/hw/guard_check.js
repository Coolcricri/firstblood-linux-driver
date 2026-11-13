'use strict';
// Runs ONLY against the simulator: does the driver refuse firmware-class opcodes? (never touches real hardware)
process.env.FB_HID_MODULE = require('path').join(__dirname, 'sim/node-hid.js'); process.env.FB_DRIVER_PORT = '38149'; delete process.env.FB_ALLOW_FIRMWARE;
const G = require('./lib/grpcweb'), P = require('./lib/proto'), sim = require('./sim/node-hid').sim;
const drv = require('./lib/src').req('driver'); drv.start();
(async () => {
  await P.sleep(1500); const path = require('./sim/node-hid').devices().find((d) => d.usage === 2).path; const res = [];
  const ops = [...P.FIRMWARE_CLASS.keys(), P.FACTORY_RESET];
  for (const op of ops) {
    for (const via of ['sendMsg', 'sendRawFeature']) {
      sim.log.length = 0; let r;
      if (via === 'sendMsg') r = await G.sendMsg(38149, path, Buffer.from([op, 0x55, 0xaa, 0x55, 0xaa]), 0);
      else r = await G.call(38149, 'sendRawFeature', Buffer.concat([G.enc.str(1, path), G.enc.bytes(2, Buffer.concat([Buffer.from([0]), P.frame([op, 0x55, 0xaa, 0x55, 0xaa], 'none')])), G.enc.uint(3, 2)])).then((o) => (o[0][1].length ? G.str(G.decode(o[0][1]), 1) : ''));
      const reached = sim.log.some((l) => l.includes('0x' + op.toString(16)));
      res.push({ op, via, blocked: /^blocked/.test(r), reachedDevice: reached });
    }
  }
  console.log(JSON.stringify(res)); process.exit(0);
})();
