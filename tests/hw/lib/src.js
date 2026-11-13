'use strict';
// Locates the driver source tree (needed only by tests that exercise src/linux_driver/*). --src DIR | FB_SRC | autodetect.
const fs = require('fs'), path = require('path');
const i = process.argv.indexOf('--src');
const cands = [i > 0 && process.argv[i + 1], process.env.FB_SRC, path.join(__dirname, '../../../src'), path.join(__dirname, '../../src'), path.join(__dirname, '../src'), path.join(process.cwd(), 'src'), path.join(process.cwd(), '../src')].filter(Boolean);
let dir = null; for (const c of cands) if (fs.existsSync(path.join(c, 'linux_driver', 'driver.js'))) { dir = path.resolve(c); break; }
module.exports = { dir, req(n) { if (!dir) throw Object.assign(new Error('driver source not found: pass --src <firstblood-linux>/src or set FB_SRC'), { skip: true }); return require(path.join(dir, 'linux_driver', n)); } };
