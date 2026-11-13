#!/usr/bin/env node
'use strict';
// Hardware verification harness for the Firstblood B6 Linux driver. See README.md / HARDWARE-TEST-PLAN.md.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), readline = require('readline');
const Q = require('./lib/quiet'), SRC = require('./lib/src'), P = require('./lib/proto'), K = require('./lib/keymap'), H = require('./lib/hidio'), O = require('./lib/observer');
const argv = process.argv.slice(2), has = (f) => argv.includes(f), val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (has('--help') || has('-h')) { console.log(fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8').split('\n## ')[0]); process.exit(0); }
const PHASES = (val('--phase', 'A')).toUpperCase().split(','), ONLY = (val('--only', '') || '').split(',').filter(Boolean);
const REPS = Number(val('--reps', 4)), SCRATCH = Number(val('--scratch-layer', 2)), PORT = Number(val('--port', 38142)), OUT = val('--out', path.join(__dirname, 'reports'));
const want = (ph) => PHASES.includes('ALL') || PHASES.includes(ph);
const SNAPDIR = process.env.FB_SNAP_DIR || path.join(os.homedir(), '.local', 'share', 'firstblood-hwtests');
function snapPath(f) { if (fs.existsSync(f)) return f; const alt = path.join(SNAPDIR, path.basename(f)); if (fs.existsSync(alt)) return alt; const l = fs.existsSync(SNAPDIR) ? fs.readdirSync(SNAPDIR).filter((x) => /^snapshot-/.test(x)) : []; console.log(`snapshot not found: ${f}\nsnapshots in ${SNAPDIR}: ${l.join(', ') || '(none)'}`); process.exit(2); }
const results = []; const ctx = { flags: { write: has('--allow-write') } };
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const ask = (q) => new Promise((r) => { if (!process.stdin.isTTY || ctx.obs && ctx.obs.kind === 'sim') return r('y'); const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q + ' ', (a) => { rl.close(); r(a.trim().toLowerCase()); }); });
const say = (...a) => console.log('     ' + a.join(' '));

// ---------- device state snapshot / restore (safety net for every write test) ----------
async function readState(l) {
  const s = { profile: (await l.get(P.OP.GET_PROFILE))[1], led: [...(await l.get(P.OP.GET_LED)).slice(1, 8)], debounce: (await l.get(P.OP.GET_DEBOUNCE))[2], rate: [], mats: [], kb: [...(await l.get(P.OP.GET_KBOPTION, 0)).slice(2, 5)] };
  for (let p = 0; p < 3; p++) { s.rate.push((await l.get(P.OP.GET_REPORT, p))[2]); s.mats.push((await l.readMatrix(p)).toString('base64')); }
  s.macro = (await l.readMacro(P.MACRO_SLOT)).toString('base64'); return s;
}
async function restoreMatrices(l, s, log = true) {
  // The vendor waits BIGCMDDELAY=1000 ms after a matrix write and the device targets the ACTIVE layer, so: select layer, write, wait, VERIFY, retry.
  for (let pass = 1; pass <= 3; pass++) {
    let clean = true;
    for (let p = 0; p < 3; p++) {
      const want = Buffer.from(s.mats[p], 'base64'); if (eq((await l.readMatrix(p)).slice(0, 504), want.slice(0, 504))) continue;
      clean = false; if (log) console.log(`     pass ${pass}: layer ${p} differs -> select layer ${p}, write, wait 1000 ms, verify`);
      await l.setProfile(p, 600); await l.writeMatrix(p, want, { noSwitch: true });
    }
    if (clean) return true;
  }
  for (let p = 0; p < 3; p++) if (!eq((await l.readMatrix(p)).slice(0, 504), Buffer.from(s.mats[p], 'base64').slice(0, 504))) return false;
  return true;
}
async function restoreState(l, s) {
  await restoreMatrices(l, s);
  for (let p = 0; p < 3; p++) { await l.setProfile(p, 400); await l.write(P.frame([P.OP.SET_REPORT, p, s.rate[p]], 'bit7')); await P.sleep(300); }
  await l.write(P.frame([P.OP.SET_LED, ...s.led], 'bit8')); await P.sleep(500); await l.write(P.frame([P.OP.SET_DEBOUNCE, 0, s.debounce], 'bit7')); await P.sleep(500);
  await l.writeMacro(P.MACRO_SLOT, Buffer.from(s.macro, 'base64'), 5); await l.setProfile(s.profile, 600); await restoreMatrices(l, s, false);
}
async function diffState(l, s) {
  const n = await readState(l), d = []; for (const k of Object.keys(s)) if (JSON.stringify(n[k]) !== JSON.stringify(s[k])) d.push(k); return d;
}
async function needSnap() {
  if (ctx.snap) return ctx.snap; if (!ctx.flags.write) throw new Error('write tests need --allow-write');
  const a = await readState(ctx.link), b = await readState(ctx.link);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('device state differs between two consecutive reads; refusing to write (see A5/A6)');
  ctx.snap = a; fs.mkdirSync(OUT, { recursive: true }); ctx.snapFile = path.join(OUT, 'snapshot-' + Date.now() + '.json'); fs.writeFileSync(ctx.snapFile, JSON.stringify(a)); fs.mkdirSync(SNAPDIR, { recursive: true }); fs.writeFileSync(path.join(SNAPDIR, path.basename(ctx.snapFile)), JSON.stringify(a));
  say('state snapshot saved:', ctx.snapFile, 'and', SNAPDIR, '(restore: node hwtest.js --restore <file>)'); return a;
}
function explain(now, ref) {
  const out = []; for (let p = 0; p < 3; p++) { const a = Buffer.from(now.mats[p], 'base64'), b = Buffer.from(ref.mats[p], 'base64'); const sl = []; for (let i = 0; i < 128; i++) if (!eq(a.slice(i * 4, i * 4 + 4), b.slice(i * 4, i * 4 + 4))) sl.push(`slot ${i}: now [${[...a.slice(i * 4, i * 4 + 4)]}] should be [${[...b.slice(i * 4, i * 4 + 4)]}]`); if (sl.length) out.push(`layer ${p} differs: ${sl.join('; ')}`); }
  for (const k of ['profile', 'led', 'debounce', 'rate', 'kb', 'macro']) if (JSON.stringify(now[k]) !== JSON.stringify(ref[k])) out.push(`${k} differs: now ${JSON.stringify(now[k])} should be ${JSON.stringify(ref[k])}`);
  return out;
}
const mat = (p) => Buffer.from(ctx.snap.mats[p], 'base64');
const F = (n) => 104 + (n - 13); // HID usage of F13..F24

// ---------- tests ----------
const T = [];
const test = (id, ph, risk, title, fn) => T.push({ id, ph, risk, title, fn });
const R = (status, detail, data) => ({ status, detail, data });
const LOST = /No such device|Protocol error|Input\/output error|ENODEV|cannot open/i;
async function relink(maxMs) {   // wait for the keyboard to come back (after a drop-off/reset) and re-open it
  const end = Date.now() + maxMs; let told = false;
  while (Date.now() < end) { const d = ctx.HID.devices().find(H.isCmd); if (d) { try { ctx.link && ctx.link.close(); ctx.cmd = d; ctx.link = new H.Link(ctx.HID, d.path); await P.sleep(1500); await ctx.link.probe(P.frame([P.OP.GET_INFO], 'bit7'), { pollMs: 200 }); return true; } catch (e) {} } if (!told && Date.now() > end - maxMs + 8000) { console.log('     keyboard has not come back: unplug it, wait 3 s, plug it in again'); told = true; } await P.sleep(500); }
  return false;
}

test('A1', 'A', 'R0', 'Enumeration shape matches the driver\'s predicates', async () => {
  const all = ctx.HID.devices().filter((d) => d.vendorId === P.VID); ctx.all = all;
  for (const d of all) say(`${d.path}  pid=${d.productId.toString(16)} iface=${d.interface} usagePage=0x${d.usagePage.toString(16)} usage=${d.usage}`);
  const cmd = all.filter(H.isCmd), ven = all.filter(H.isVendor), typ = all.filter((d) => d.usagePage === 1), bad = [], warn = [];
  if (cmd.length !== 1) bad.push(`${cmd.length} command interfaces (expected exactly 1: usagePage 0xFFFF usage 2 pid 4015)`);
  if (ven.length !== 1) bad.push(`${ven.length} vendor-event interfaces matching usage 1 + interface 1 (if interface shows -1 the driver never opens it)`);
  if (cmd.length === 1 && cmd[0].interface !== 2) warn.push('command interface number is ' + cmd[0].interface + ', README says 2');
  if (!typ.length) warn.push('no typing interface (usagePage 1) found');
  if (all.some((d) => d.productId !== P.PID)) warn.push('other 3151 devices present (dongle?) - ignored by driver');
  if (bad.length) return R('FAIL', bad.join('; '));
  ctx.cmd = cmd[0]; ctx.ven = ven[0];
  let l; try { const { Manager } = SRC.req('hid'); const m = new Manager(); await m.poll(); l = m.list(); m.devs.forEach((d) => d.close()); } catch (e) { if (!e.skip) throw e; warn.push(e.message + ' (driver cross-check skipped)'); return R('WARN', warn.join('; ')); }
  if (l.length !== 1 || l[0].path !== ctx.cmd.path || l[0].id !== 910) return R('FAIL', `driver Manager sees ${JSON.stringify(l.map((d) => [d.path, d.id]))}, harness sees ${ctx.cmd.path}`);
  return R(warn.length ? 'WARN' : 'PASS', warn.join('; ') || `cmd=${ctx.cmd.path} vendor=${ctx.ven.path}; driver Manager agrees (id 910)`);
});
test('A2', 'A', 'R0', 'Permissions: udev rule gives user access to interfaces 1-2 only', async () => {
  if (/sim/.test(process.env.FB_HID_MODULE || '')) return R('SKIP', 'simulator'); const lines = [], bad = []; const root = process.getuid && process.getuid() === 0;
  for (const d of ctx.all) { let a = 'rw'; try { fs.accessSync(d.path, fs.constants.R_OK | fs.constants.W_OK); } catch (e) { a = 'no'; } lines.push(`${d.path}(iface ${d.interface})=${a}`); if ((d === ctx.cmd || d === ctx.ven) && a !== 'rw') bad.push(d.path + ' not accessible'); }
  const rules = '/etc/udev/rules.d/70-firstblood.rules'; let inst = 'not installed';
  try { inst = fs.readFileSync(rules, 'utf8') === fs.readFileSync(path.join(SRC.dir || '/nonexistent', '70-firstblood.rules'), 'utf8') ? 'installed, current' : 'installed, DIFFERS from bundled'; } catch (e) {}
  say(lines.join('  ')); say('rule file:', inst, root ? '| running as ROOT' : '');
  if (bad.length) return R('FAIL', bad.join('; ') + '; rule ' + inst);
  if (root) return R('WARN', 'running as root hides permission problems; re-run as your normal user');
  const typ = ctx.all.find((d) => d.usagePage === 1); const typOpen = typ && lines.find((l) => l.startsWith(typ.path)).endsWith('=rw');
  return R(typOpen ? 'WARN' : 'PASS', typOpen ? 'typing interface is also user-accessible (extra ACL/group?) - rule scope not proven' : 'only interfaces 1-2 accessible: rule scope as intended');
});
test('A3', 'A', 'R0', 'Device identity (0x8F) with BIT7 / none / BIT8 checksums', async () => {
  const l = ctx.link, rows = {}; let id;
  for (const c of ['bit7', 'none', 'bit8']) { let okc = 0, late = 0; for (let i = 0; i < 10; i++) { const r = await l.probe(P.frame([P.OP.GET_INFO], c)); const v = r.echoFirst ? r.first : r.last; if (v[0] === 0x8f && v.readUInt32LE(1) === P.DEVICE_ID) { okc++; if (!r.echoFirst) late++; } id = v.readUInt32LE(1); } rows[c] = { ok: okc, lateEcho: late }; }
  say(JSON.stringify(rows)); ctx.idRows = rows;
  if (rows.bit7.ok === 10) return R(rows.none.ok === 10 ? 'PASS' : 'PASS', `BIT7 10/10 (none ${rows.none.ok}/10, bit8 ${rows.bit8.ok}/10); id=${P.DEVICE_ID}`);
  if (rows.none.ok === 10) return R('WARN', `BIT7 only ${rows.bit7.ok}/10 but none 10/10: the driver's first attempt fails, fallback works (each failed attempt costs up to 400 ms)`);
  return R('FAIL', `no checksum variant gives a stable 910 reply (last id seen ${id})`);
});
test('A4', 'A', 'R0', 'Feature-report framing: 65-byte GET, leading report-ID 0, reply echo at payload[0]', async () => {
  const l = ctx.link; await P.sleep(10); l.tx(P.frame([P.OP.GET_INFO], 'bit7')); await P.sleep(10); const raw = l.rxRaw();
  say('raw length', raw.length, 'head', P.hex(raw, 8));
  if (raw.length !== 65) return R('FAIL', `getFeatureReport(0,65) returned ${raw.length} bytes; driver strips a leading byte only when length is 65`);
  if (raw[0] !== 0) return R('FAIL', 'first byte is 0x' + raw[0].toString(16) + ', not report-ID 0');
  return raw[1] === 0x8f ? R('PASS', 'length 65, byte0=0, payload[0]=0x8F') : R('FAIL', 'payload not aligned: ' + P.hex(raw, 8));
});
test('A5', 'A', 'R0', 'Getter survey: echo of opcode, latency, idempotence (drives READ_POLL stall risk)', async () => {
  const l = ctx.link, rows = [], items = [['GET_REV', [0x80]], ['GET_INFO', [0x8f]], ['GET_PROFILE', [0x85]], ['GET_REPORT', [0x84, 0]], ['GET_KBOPTION', [0x86, 0]], ['GET_LED', [0x87]], ['GET_DEBOUNCE', [0x91]], ['GET_SLEEP', [0x92]], ['GET_AUTOOS', [0x97]]];
  for (let p = 0; p < 3; p++) for (let i = 0; i < 8; i++) items.push([`GET_KEYMATRIX p${p} #${i}`, [0x89, p, i]]);
  for (let r = 0; r < 4; r++) items.push([`GET_MACRO slot0 #${r}`, [0x8b, 0, r]]);
  for (const [name, b] of items) {
    const r = await l.probe(P.frame(b, 'bit7')); await P.sleep(20); const again = l.rx();
    const row = { name, op: b[0], echoAtVendorRead: r.echoFirst, lateEchoMs: r.lateMs === null ? null : Math.round(r.lateMs), stable: eq(again, r.last), zeros: r.last.every((x) => !x), head: P.hex(r.last, 8) }; rows.push(row);
    say(name.padEnd(24), row.echoAtVendorRead ? 'echo@5ms' : row.lateEchoMs !== null ? `echo@${row.lateEchoMs}ms` : 'NO ECHO  ', row.stable ? 'stable' : 'CHANGES', row.head);
  }
  ctx.survey = rows;
  const core = rows.filter((r) => !/KEYMATRIX|MACRO|KBOPTION|SLEEP|AUTOOS/.test(r.name)), noEcho = rows.filter((r) => !r.echoAtVendorRead && r.lateEchoMs === null), late = rows.filter((r) => !r.echoAtVendorRead && r.lateEchoMs !== null);
  const m0 = Buffer.concat(rows.filter((r) => r.name.startsWith('GET_KEYMATRIX p0')).map((r) => Buffer.from(r.head.replace(/ /g, ''), 'hex'))); void m0;
  if (core.some((r) => !r.echoAtVendorRead && r.lateEchoMs === null)) return R('FAIL', 'core getters never echo: ' + core.filter((r) => r.lateEchoMs === null && !r.echoAtVendorRead).map((r) => r.name).join(', '));
  if (rows.some((r) => !r.stable)) return R('WARN', 'replies change between identical reads: ' + rows.filter((r) => !r.stable).map((r) => r.name).join(', '));
  const stall = noEcho.length + late.length;
  if (stall) return R('WARN', `${stall} of ${rows.length} reads do not echo at the vendor read time (${noEcho.length} never). The driver waits up to READ_POLL (400 ms) for each: matrix read of 3 layers could cost ~${(noEcho.filter((r) => /KEYMATRIX/.test(r.name)).length * 0.4).toFixed(1)} s. See A7.`);
  return R('PASS', 'every getter echoes its opcode at the vendor read time and is stable');
});
test('A6', 'A', 'R0', 'Read soak: 300 mixed getters, miss/invalid rate', async () => {
  const l = ctx.link, ops = [[0x85], [0x91], [0x87], [0x8f]]; let miss = 0, wrong = 0, worst = 0;
  for (let i = 0; i < 300 && miss < 20; i++) { const b = ops[i % 4], r = await l.probe(P.frame(b, 'bit7'), { pre: 5, pollMs: 100 }); if (!r.echoFirst) { if (r.lateMs === null) miss++; else worst = Math.max(worst, r.lateMs); } else if (b[0] === 0x8f && r.first.readUInt32LE(1) !== 910) wrong++; }
  return miss + wrong === 0 ? R('PASS', `0 misses, 0 wrong ids in 300 reads (worst late echo ${Math.round(worst)} ms)`) : R('FAIL', `${miss} misses, ${wrong} wrong in 300 reads`);
});
test('A8', 'A', 'R0', 'Matrix/command read latency floor (min delay between send and a correct reply)', async () => {
  const l = ctx.link, res = {}; const ref = []; for (let i = 0; i < 8; i++) { await P.sleep(10); l.tx(P.frame([0x89, 0, i], 'bit7')); await P.sleep(40); ref.push(l.rx()); }
  for (const d of [0, 1, 2, 3, 5, 8, 12]) { let ok = 0, n = 0; for (let rep = 0; rep < 6; rep++) for (let i = 0; i < 8; i++) { await P.sleep(15); l.tx(P.frame([0x89, 0, i], 'bit7')); await P.sleep(d); n++; if (eq(l.rx(), ref[i])) ok++; } res[d] = `${ok}/${n}`; say(`read ${d} ms after send: ${ok}/${n} correct`); }
  const good = Object.keys(res).map(Number).filter((d) => res[d].split('/')[0] === res[d].split('/')[1]), min = good.length ? Math.min(...good) : null;
  if (min === null || min > 8) return R('FAIL', 'no tested delay <= 8 ms gives 100% correct reads: ' + JSON.stringify(res));
  return R('PASS', `correct from ${min} ms after send (driver waits 8 ms, vendor 5 ms): ` + JSON.stringify(res), res);
});
async function driverUp() {
  if (ctx.drvStarted) return; process.env.FB_DRIVER_PORT = String(PORT); const drv = SRC.req('driver'); drv.start(); ctx.drv = drv; ctx.drvStarted = true; await P.sleep(2000);
}
test('A7', 'A', 'R0', 'Driver end-to-end read path: 3 layers via gRPC (UI-style), correctness + time', async () => {
  await driverUp(); const G = require('./lib/grpcweb'); const rows = []; let bad = 0;
  for (let p = 0; p < 3; p++) {
    const t0 = process.hrtime.bigint(), parts = [];
    for (let i = 0; i < 8; i++) { const e = await G.sendMsg(PORT, ctx.cmd.path, Buffer.from([0x89, p, i]), 0); if (e) return R('FAIL', 'sendMsg error: ' + e); parts.push(await G.readMsg(PORT, ctx.cmd.path)); }
    const t = ms(t0), raw = await ctx.link.readMatrix(p), same = eq(Buffer.concat(parts), raw); if (!same) bad++; rows.push(`layer${p}: ${Math.round(t)} ms ${same ? 'identical to raw read' : 'DIFFERS from raw read'}`); ctx['drvMs' + p] = t;
  }
  rows.forEach((r) => say(r)); const worst = Math.max(ctx.drvMs0, ctx.drvMs1, ctx.drvMs2);
  if (bad) return R('FAIL', 'driver-returned matrix differs from direct read: ' + rows.join('; '));
  return worst > 1500 ? R('WARN', `correct but slow: worst layer ${Math.round(worst)} ms (vendor app ~150 ms). Echo-wait stall; see A5`) : R('PASS', `correct; worst layer ${Math.round(worst)} ms`);
});

// ---- Phase B (reversible writes; every test restores; snapshot first) ----
const pattern = (p) => { let m = mat(p); P.KEY_SLOTS.forEach((s, i) => { m = P.setEntry(m, s, [0, 0, F(p === 2 ? 18 - i : 13 + i + 6 * p), 0]); }); return m; };
test('B0', 'B', 'R1', 'Which layer does a matrix write hit: the header layer byte or the ACTIVE layer?', async () => {
  await needSnap(); const l = ctx.link, active = SCRATCH === 0 ? 1 : 0, w = P.setEntry(mat(SCRATCH), 0, [0, 0, F(24), 0]); let hit = null;
  await l.setProfile(active, 700); await l.writeMatrix(SCRATCH, w, { noSwitch: true, confirm: false, settle: 1500 });
  const names = []; for (let p = 0; p < 3; p++) if (eq((await l.readMatrix(p)).slice(0, 8), w.slice(0, 8)) && !eq(mat(p).slice(0, 8), w.slice(0, 8))) names.push(p);
  hit = names.length === 1 ? names[0] : names.length ? names : 'none';
  const clean = await restoreMatrices(l, ctx.snap, false);
  const kind = hit === SCRATCH ? 'HEADER layer byte (writes can target any layer)' : hit === active ? 'ACTIVE layer (header layer byte ignored): always select a layer before writing it' : 'unexpected: ' + JSON.stringify(hit);
  if (!clean) return R('FAIL', 'layers not restored after test; header ' + SCRATCH + ' / active ' + active + ' -> hit ' + hit);
  return R(hit === SCRATCH || hit === active ? 'PASS' : 'FAIL', `header=layer ${SCRATCH}, active=layer ${active}: write landed in layer ${hit} => device honours the ${kind}`);
});
test('B9', 'B', 'R1', 'Commit latency per layer: ms from the last matrix packet until reads show the new data (never switches layers while waiting)', async () => {
  await needSnap(); const l = ctx.link, rows = {}; let worst = 0, never = [];
  for (const p of [2, 1, 0]) {
    await l.setProfile(p, 800); const lat = [];
    for (let i = 0; i < Math.max(REPS, 4) - (Math.max(REPS, 4) % 2); i++) {
      const w = i % 2 === 0 ? pattern(p) : mat(p); await l.writeMatrix(p, w, { noSwitch: true, confirm: true, maxMs: 6000, extra: 1500 }); const c = l.lastCommit; lat.push(c.ok ? c.ms : null);
      if (!c.ok) { never.push(p); break; } worst = Math.max(worst, c.ms);
    }
    rows[p] = lat; say(`layer ${p} commit ms: ${lat.map((x) => (x === null ? 'NEVER(6s)' : x)).join(', ')}`);
  }
  await restoreMatrices(l, ctx.snap, false);
  if (never.length) return R('FAIL', 'data never became visible within 6 s on layer(s) ' + [...new Set(never)].join(','), rows);
  return worst <= 1000 ? R('PASS', `commit visible within ${worst} ms on every layer (vendor waits 1000 ms)`, rows) : R('WARN', `slowest commit ${worst} ms > vendor's 1000 ms wait; use >= ${Math.ceil(worst * 1.5 / 100) * 100} ms before switching layers or reloading. per layer: ${JSON.stringify(rows)}`, rows);
});
test('B8', 'B', 'R2', 'Commit window: is it safe to switch layers N ms after the last matrix packet? (vendor waits 1000 ms)', async () => {
  if (!has('--risky')) throw Object.assign(new Error('B8 deliberately switches layers INSIDE the commit window. On a real B6 this made the keyboard drop off USB and reset (first run). Only with --risky, ideally only with --only B8'), { skip: true });
  Q.st.off = true; await needSnap(); const l = ctx.link; await restoreMatrices(l, ctx.snap, false); const res = {}, other = SCRATCH === 0 ? 1 : 0, w = pattern(SCRATCH);
  for (const settle of [1500, 1000, 600, 300]) {
    await l.setProfile(SCRATCH, 700); await l.writeMatrix(SCRATCH, w, { noSwitch: true, confirm: false, settle }); await l.setProfile(other, 700); await P.sleep(1500);
    const got = []; for (let p = 0; p < 3; p++) got.push((await l.readMatrix(p)).slice(0, 504)); const okS = eq(got[SCRATCH], w.slice(0, 504)), okO = [0, 1, 2].filter((p) => p !== SCRATCH).every((p) => eq(got[p], mat(p).slice(0, 504)));
    res[settle] = okS && okO ? 'safe' : (!okS && !okO ? 'MISDIRECTED' : 'partial'); say(`switch ${settle} ms after last packet: ${res[settle]}`);
    if (!(await restoreMatrices(l, ctx.snap, false))) return R('FAIL', 'could not restore layers during B8; run --check/--restore');
  }
  const min = [1500, 1000, 600, 300].filter((x) => [1500, 1000, 600, 300].filter((y) => y >= x).every((y) => res[y] === 'safe')).pop();
  if (res[1000] !== 'safe') return R('FAIL', 'even 1000 ms is not enough before a layer switch: ' + JSON.stringify(res), res);
  return R(min <= 600 ? 'PASS' : 'WARN', `layer switch safe from ${min} ms after the last packet (vendor 1000 ms): ` + JSON.stringify(res), res);
});
test('B1', 'B', 'R1', 'Layer switch (0x05): settle time until 0x85 reports the new layer', async () => {
  await needSnap(); const l = ctx.link, t = []; let worst = 0;
  for (const p of [1, 2, 0, 2, 0]) { await l.write(P.frame([P.OP.SET_PROFILE, p], 'bit7')); const t0 = process.hrtime.bigint(); let got = -1; while (ms(t0) < 1000) { const r = await l.get(P.OP.GET_PROFILE); if (r[0] === 0x85 && r[1] === p) { got = ms(t0); break; } await P.sleep(5); } if (got < 0) return R('FAIL', `layer ${p} never reported within 1 s`); t.push(Math.round(got)); worst = Math.max(worst, got); }
  await l.setProfile(ctx.snap.profile, 300); const same = eq(await l.readMatrix(0), mat(0));
  say('settle ms:', t.join(', ')); if (!same) return R('FAIL', 'switching layers changed layer-0 matrix');
  return worst <= 100 ? R('PASS', 'settles within 100 ms ' + t.join('/')) : worst <= 500 ? R('WARN', `settle up to ${Math.round(worst)} ms; UI must wait before reading/pressing (vendor waits 500 ms)`) : R('FAIL', 'settle > 500 ms');
});
test('B2', 'B', 'R1', 'Key matrix write/readback round-trip on all 3 layers (vendor 9-packet protocol)', async () => {
  await needSnap(); const l = ctx.link, bad = [];
  const lat = [];
  for (let p = 0; p < 3; p++) {
    const w = pattern(p); const ok1 = await l.writeMatrix(p, w, { maxMs: 8000 }); lat.push(l.lastCommit.ms); if (!ok1) bad.push(`layer ${p}: new data still not visible ${l.lastCommit.ms} ms after the last packet`);
    const ok2 = await l.writeMatrix(p, mat(p), { maxMs: 8000 }); lat.push(l.lastCommit.ms); if (!ok2) bad.push(`layer ${p}: restore still not visible ${l.lastCommit.ms} ms after the last packet`);
  }
  say('ms from last packet until the data was readable (layer0 write/restore, layer1 ..., layer2 ...):', lat.join(', ')); const slow = Math.max(...lat);
  if (bad.length) return R('FAIL', bad.join('; '));
  return slow > 1000 ? R('WARN', `all layers round-trip, but a commit took up to ${slow} ms (vendor UI waits 1000 ms): UI may show stale data if it reloads right after saving. ms: ${lat.join(',')}`) : R('PASS', `write+readback identical on layers 0,1,2; commit visible within ${slow} ms (vendor waits 1000)`);
});
test('B3', 'B', 'R1', 'Inter-packet delay sweep on matrix write (driver default FB_SEND_DELAY_MS=8, vendor 10)', async () => {
  await needSnap(); const l = ctx.link, res = {}; const a = pattern(0), b = P.setEntry(a, 0, [0, 0, F(24), 0]);
  for (const gap of [0, 1, 2, 4, 8, 10, 20]) { let okc = 0; for (let i = 0; i < REPS; i++) { const w = i % 2 ? a : b; if (await l.writeMatrix(SCRATCH, w, { gap, maxMs: 3500, extra: 300 })) okc++; } res[gap] = okc; say(`gap ${gap} ms: ${okc}/${REPS}`); }
  await l.writeMatrix(SCRATCH, mat(SCRATCH)); const min = Object.keys(res).map(Number).find((g) => Object.keys(res).map(Number).filter((x) => x >= g).every((x) => res[x] === REPS));
  if (res[8] !== REPS || res[10] !== REPS) return R('FAIL', `driver delay 8 ms / vendor 10 ms not reliable: ${JSON.stringify(res)}; raise FB_SEND_DELAY_MS`, res);
  return R(min !== undefined && min <= 4 ? 'PASS' : 'WARN', `reliable from ${min} ms; 8 ms default ${res[8]}/${REPS}` + (min > 4 ? ' (thin margin)' : ''), res);
});
test('B4', 'B', 'R1', 'Checksum enforcement: matrix packets and LED command (BIT8) accepted / rejected', async () => {
  await needSnap(); const l = ctx.link, out = []; const w = pattern(0);
  await l.writeMatrix(SCRATCH, w, { chk: 'bad', confirm: false, settle: 1500 }); const applied = eq((await l.readMatrix(SCRATCH)).slice(0, 504), w.slice(0, 504)); out.push('matrix packets with WRONG checksum: ' + (applied ? 'APPLIED (firmware does not validate)' : 'ignored (firmware validates)'));
  await l.writeMatrix(SCRATCH, mat(SCRATCH));
  const base = ctx.snap.led, tgt = base.slice(); tgt[5] = base[5] === 100 ? 90 : 100; const res = {}; const led = async () => [...(await l.get(P.OP.GET_LED)).slice(1, 8)];   // harmless change: one colour byte, same mode
  for (const c of ['bad8', 'bit7', 'none', 'bit8']) { await l.write(P.frame([P.OP.SET_LED, ...base], 'bit8'), { pre: 500 }); await P.sleep(300); await l.write(P.frame([P.OP.SET_LED, ...tgt], c), { pre: 500 }); await P.sleep(500); const s = await led(); res[c] = eq(s, tgt) ? 'applied' : eq(s, base) ? 'ignored' : 'changed-differently ' + s.join(','); }
  out.push('LED set (mode ' + base[0] + ', colour byte changed): ' + JSON.stringify(res)); out.forEach((o) => say(o));
  await l.write(P.frame([P.OP.SET_LED, ...base], 'bit8'), { pre: 500 }); await P.sleep(500);
  if (!eq(await led(), base)) return R('FAIL', 'LED state not restored');
  if (res.bit8 !== 'applied') return R(Object.values(res).every((v) => v === 'ignored') ? 'WARN' : 'FAIL', 'valid BIT8 LED command not applied (mode ' + base[0] + ' may ignore that byte; retry with a different effect set in the UI): ' + out.join(' | '));
  return R('PASS', out.join(' | '), res);
});
test('B5', 'B', 'R1', 'Debounce (0x11) and report-rate (0x04) set/readback', async () => {
  await needSnap(); const l = ctx.link, bad = [];
  for (const v of [4, 7, 10, ctx.snap.debounce]) { await l.write(P.frame([P.OP.SET_DEBOUNCE, 0, v], 'bit7')); await P.sleep(500); const g = await l.get(P.OP.GET_DEBOUNCE); if (g[2] !== v) bad.push(`debounce set ${v} read ${g[2]}`); }
  const pr = ctx.snap.profile; for (const c of [2, 4, 8, ctx.snap.rate[pr]]) { await l.write(P.frame([P.OP.SET_REPORT, pr, c], 'bit7')); await P.sleep(300); const g = await l.get(P.OP.GET_REPORT, pr); if (g[2] !== c) bad.push(`rate code ${c} read ${g[2]}`); }
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', 'debounce 4/7/10 and report-rate codes 2/4/8 read back; originals restored');
});
test('B6', 'B', 'R1', 'Macro slot round-trip: write via 0x16, read via 0x8B (asymmetric opcodes), slot 49', async () => {
  await needSnap(); const l = ctx.link, orig = Buffer.from(ctx.snap.macro, 'base64'); const pat = Buffer.alloc(256); for (let i = 0; i < 256; i++) pat[i] = (i % 250) + 1;
  await l.writeMacro(P.MACRO_SLOT, pat, 5); const r = await l.readMacro(P.MACRO_SLOT); const same = eq(r, pat);
  await l.writeMacro(P.MACRO_SLOT, orig, 5); const back = eq(await l.readMacro(P.MACRO_SLOT), orig);
  if (!back) return R('FAIL', 'could not restore macro slot 49 to its original content');
  return same ? R('PASS', 'pattern written with 0x16 read back identically with 0x8B; slot restored') : R('FAIL', `readback differs at byte ${[...r].findIndex((x, i) => x !== pat[i])}: macro write/read opcodes do not mirror each other`);
});
test('B7', 'B', 'R2', 'Driver end-to-end MATRIX write path through gRPC (no LED), verified by direct read', async () => {
  if (!has('--risky')) throw Object.assign(new Error('B7 made a real B6 drop off USB and reset to factory defaults twice. Run the isolating experiments X1-X3 first (--phase X --risky)'), { skip: true });
  await needSnap(); await driverUp(); const G = require('./lib/grpcweb'), l = ctx.link, bad = [], lat = [];
  await l.setProfile(SCRATCH, 800);   // the device writes to the ACTIVE layer (B0)
  for (const w of [pattern(0), mat(SCRATCH)]) {
    const t0 = process.hrtime.bigint();
    for (const p of P.matrixPackets(SCRATCH, w)) { const e = await G.sendMsg(PORT, ctx.cmd.path, p, 2); if (e) return R('FAIL', 'sendMsg: ' + e); }
    let seen = false; for (let i = 0; i < 60 && !seen; i++) { await P.sleep(150); seen = eq((await l.readMatrix(SCRATCH)).slice(0, 504), w.slice(0, 504)); } lat.push(Math.round(ms(t0)));
    if (!seen) bad.push('matrix written via driver never became visible within 9 s'); await P.sleep(1500);
  }
  await P.sleep(2500);   // quiet period before anything else is sent
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', `9-packet matrix writes via the driver read back identical (visible after ${lat.join(' / ')} ms incl. sending); layer restored`);
});
test('B7b', 'B', 'R2', 'Driver LED path through gRPC (BIT8, same mode, one colour byte), >= 3.5 s after any matrix write', async () => {
  if (!has('--risky')) throw Object.assign(new Error('skipped with B7 (needs --risky)'), { skip: true });
  await needSnap(); await driverUp(); const G = require('./lib/grpcweb'), l = ctx.link, base = ctx.snap.led, tgt = base.slice(); tgt[5] = base[5] === 100 ? 90 : 100; const led = async () => [...(await l.get(P.OP.GET_LED)).slice(1, 8)];
  await G.sendMsg(PORT, ctx.cmd.path, Buffer.from([7, ...tgt]), 1); await P.sleep(700); const got = await led();
  await G.sendMsg(PORT, ctx.cmd.path, Buffer.from([7, ...base]), 1); await P.sleep(700); const back = await led();
  if (!eq(back, base)) return R('FAIL', 'LED not restored: ' + back.join(','));
  return eq(got, tgt) ? R('PASS', 'BIT8 LED frame sent through the driver was applied and restored') : R('FAIL', 'LED via driver not applied: ' + got.join(','));
});

// ---- Phase X: isolating experiments for the B7 crash (each changes ONE thing vs the failing B7). All need --risky; a drop auto-restores.
const needRisky = () => { if (!has('--risky')) throw Object.assign(new Error('experiment that may crash the keyboard: needs --risky'), { skip: true }); };
test('X1', 'X', 'R2', 'Pacing: the 9 packets of the failing B7 written DIRECTLY with its observed gaps (10,70,110,10,10,10,10,10,10 ms)', async () => {
  needRisky(); await needSnap(); const l = ctx.link, w = pattern(0), gaps = [10, 70, 110, 10, 10, 10, 10, 10, 10];
  await l.setProfile(SCRATCH, 800); const ok = await l.writeMatrix(SCRATCH, w, { noSwitch: true, gap: gaps, maxMs: 9000 }); const ms1 = l.lastCommit.ms;
  await P.sleep(2500); await restoreMatrices(l, ctx.snap, false);
  return ok ? R('PASS', `uneven packet gaps tolerated; data visible after ${ms1} ms. Pacing is NOT the B7 trigger`) : R('FAIL', 'uneven gaps: data never became visible (write silently dropped); pacing matters');
});
test('X2', 'X', 'R2', 'Driver write path WITHOUT gRPC or polling: Manager+Dev.send() with uniform pacing, second handle only reads', async () => {
  needRisky(); await needSnap(); const { Manager } = SRC.req('hid'), CK = SRC.req('checksum'), l = ctx.link, m = new Manager(); await m.poll(); const dev = m.get(ctx.cmd.path), bad = [];
  await l.setProfile(SCRATCH, 800);
  for (const w of [pattern(0), mat(SCRATCH)]) {
    for (const p of P.matrixPackets(SCRATCH, w)) { Q.note(p[0], p[1], 'Dev.send'); await dev.send(p, CK.NONE); }
    let seen = false; for (let i = 0; i < 60 && !seen; i++) { await P.sleep(150); seen = eq((await l.readMatrix(SCRATCH)).slice(0, 504), w.slice(0, 504)); } if (!seen) bad.push('not visible within 9 s'); await P.sleep(2000);
  }
  m.devs.forEach((d) => d.close()); await P.sleep(1500);
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', 'driver Dev.send write path (uniform pacing, no HTTP, no polling timer) is safe');
});
test('X3', 'X', 'R2', 'Driver RUNNING (1 Hz polling, device handle open) while the layout is written DIRECTLY with uniform pacing', async () => {
  needRisky(); await needSnap(); await driverUp(); const l = ctx.link, w = pattern(0);
  await l.setProfile(SCRATCH, 800); const ok = await l.writeMatrix(SCRATCH, w, { noSwitch: true, maxMs: 9000 }); const ms1 = l.lastCommit.ms; await P.sleep(2500); await restoreMatrices(l, ctx.snap, false);
  return ok ? R('PASS', `layout written while the driver polls: fine (visible after ${ms1} ms). Driver background activity is NOT the trigger`) : R('FAIL', 'write while driver is running did not become visible');
});

// ---- Phase C (guided; operator presses buttons) ----
const needObs = () => { if (!ctx.obs) throw Object.assign(new Error('no key observer: need read access to /dev/input/event* of 3151:4015 (see README)'), { skip: true }); };
const idx = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
test('C1', 'C', 'R0', 'Factory/default output of each physical button vs matrix contents (confirms slot map + UI picture)', async () => {
  needObs(); const l = ctx.link, prof = (await l.get(P.OP.GET_PROFILE))[1], m = await l.readMatrix(prof), bad = [];
  say(`active layer ${prof}. Buttons will type their normal keys (Ctrl+C, arrows, Ctrl+V): click a blank window first.`);
  for (const ph of P.PHYS) { const got = await ctx.obs.capture(`${ph.name} button (UI label "${ph.label}")`), exp = K.entryToKeys(P.entryAt(m, ph.slot)); if (!exp || !idx(got, exp)) bad.push(`${ph.name}: saw [${K.names(got)}] expected [${K.names(exp)}] from slot ${ph.slot} ${JSON.stringify(P.entryAt(m, ph.slot))}`); }
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', 'all 6 buttons emit exactly what their assumed matrix slot (0,6,12 / 1,7,13) says');
});
test('C2', 'C', 'R1', 'Per-layer remap with unique F13-F24 codes: physical button -> slot map holds on all 3 layers', async () => {
  needObs(); await needSnap(); const l = ctx.link, bad = [], map = {};
  for (let p = 0; p < 3; p++) await l.writeMatrix(p, pattern(p));
  for (let p = 0; p < 3; p++) { await l.setProfile(p); say('--- layer', p); for (const [i, ph] of P.PHYS.entries()) { const got = await ctx.obs.capture(`${ph.name} on layer ${p}`), exp = K.entryToKeys(P.entryAt(pattern(p), ph.slot)); if (!idx(got, exp)) bad.push(`L${p} ${ph.name}: saw [${K.names(got)}] expected [${K.names(exp)}]`); } }
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', '18/18 presses produced the code written to the assumed slot; layer switching changes output');
});
test('C3', 'C', 'R1', 'Encoding coverage: modifier combos, key+key2, consumer keys (vol+/-)', async () => {
  needObs(); await needSnap(); const l = ctx.link, enc = [[0, 224, F(13), 0], [0, 225, F(14), 0], [0, 226, F(15), 0], [0, 227, F(16), 0], [3, 0, 233, 0], [3, 0, 234, 0]], bad = []; let m = mat(SCRATCH);
  P.KEY_SLOTS.forEach((s, i) => { m = P.setEntry(m, s, enc[i]); }); await l.writeMatrix(SCRATCH, m); await l.setProfile(SCRATCH); say('slots hold Ctrl+F13, Shift+F14, Alt+F15, Super+F16, Vol+, Vol- (volume ends unchanged if you press each once)');
  for (const [i, ph] of P.PHYS.entries()) { const got = await ctx.obs.capture(`${ph.name}`), exp = K.entryToKeys(enc[i]); if (!idx(got, exp)) bad.push(`${ph.name} ${JSON.stringify(enc[i])}: saw [${K.names(got)}] expected [${K.names(exp)}]`); }
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', 'ctrl/shift/alt/super(227) modifier byte and consumer usage encodings behave as the UI assumes');
});
test('C4', 'C', 'R1', 'Vendor-event interface through the DRIVER: mic [6,128,0,0], program1 [6,128,0,1], profile+ [8,0,1,0] -> bytes 1..3 contract', async () => {
  await needSnap(); await driverUp(); const G = require('./lib/grpcweb'), l = ctx.link, evs = []; let m = mat(SCRATCH);
  const asg = [[6, 128, 0, 0], [6, 128, 0, 1], [8, 0, 1, 0]]; asg.forEach((e, i) => { m = P.setEntry(m, P.KEY_SLOTS[i], e); }); await l.writeMatrix(SCRATCH, m); await l.setProfile(SCRATCH);
  const st = await G.call(PORT, 'watchVender', Buffer.alloc(0), { stream: true, onData: (b) => { const v = G.first(G.decode(b), 1); if (v) evs.push(Buffer.from(v)); } }); await P.sleep(1800);
  const exp = [[128, 0, 0], [128, 0, 1], [1]], bad = [], seen = [];
  for (let i = 0; i < 3; i++) { evs.length = 0; const label = P.PHYS[i].name + ['  (assigned: MIC toggle)', '  (assigned: open-program-1)', '  (assigned: PROFILE+)'][i];
    if (ctx.obs && ctx.obs.kind === 'sim') await ctx.obs.capture(label); else { process.stdout.write(`     >>> PRESS and RELEASE: ${label} `); const e = Date.now() + 20000; while (!evs.length && Date.now() < e) await P.sleep(50); console.log(evs.length ? '-> event' : '-> nothing'); }
    await P.sleep(300); const ev = evs[0]; if (!ev) { bad.push(`${P.PHYS[i].name}: no vendor event arrived through driver`); continue; } seen.push(P.hex(ev, 8));
    const c = [...ev.slice(1, 4)], e = exp[i]; if (!e.every((x, k) => c[k] === x)) bad.push(`${P.PHYS[i].name}: event ${P.hex(ev, 8)} -> bytes1..3=[${c}] but UI expects [${e}]${[...ev.slice(0, 3)].slice(0, e.length).every((x, k) => x === e[k]) ? ' (off by one: report-ID byte missing)' : ''}`); }
  st.close(); say('raw events:', seen.join(' | ')); const now = (await l.get(P.OP.GET_PROFILE))[1]; say('active layer after profile+ press:', now);
  return bad.length ? R('FAIL', bad.join('; ')) : R('PASS', 'driver delivers events with a leading report-ID byte; UI decoding contract holds. raw: ' + seen.join(' | '));
});
async function waitGone(ms_) { const e = Date.now() + ms_; while (Date.now() < e) { if (!ctx.HID.devices().some(H.isCmd)) return true; await P.sleep(100); } return false; }
async function waitBack(ms_) { const e = Date.now() + ms_; while (Date.now() < e) { const d = ctx.HID.devices().find(H.isCmd); if (d) return d; await P.sleep(100); } return null; }
async function replug(label) {
  if (ctx.obs && ctx.obs.kind === 'sim') { process.env.FB_HID_MODULE && require(process.env.FB_HID_MODULE).sim.replug(800); } else console.log(`     >>> ${label}: UNPLUG the keyboard now, wait ~3 s, plug it back in (60 s limit)`);
  if (!(await waitGone(60000))) return null; const t0 = process.hrtime.bigint(); const d = await waitBack(60000); return d ? { d, enumMs: ms(t0) } : null;
}
test('C5', 'C', 'R1', 'Persistence: marker in layer 2 survives unplug/replug; time to first valid 0x8F', async () => {
  await needSnap(); const l = ctx.link, w = P.setEntry(mat(SCRATCH), 0, [0, 0, F(20), 0]); await l.writeMatrix(SCRATCH, w); l.close();
  const r = await replug('PERSISTENCE'); if (!r) return R('FAIL', 'keyboard did not disappear/reappear'); ctx.cmd = r.d; ctx.link = new H.Link(ctx.HID, r.d.path); let up = null; const t0 = process.hrtime.bigint();
  while (ms(t0) < 10000) { try { const g = await ctx.link.probe(P.frame([P.OP.GET_INFO], 'bit7'), { pollMs: 100 }); if ((g.echoFirst ? g.first : g.last).readUInt32LE(1) === 910) { up = ms(t0); break; } } catch (e) {} await P.sleep(100); }
  if (up === null) return R('FAIL', 'device re-enumerated but never answered 0x8F within 10 s');
  const keep = eq((await ctx.link.readMatrix(SCRATCH)).slice(0, 504), w.slice(0, 504)); await ctx.link.writeMatrix(SCRATCH, mat(SCRATCH)); ctx.snap.profile = (await ctx.link.get(P.OP.GET_PROFILE))[1];
  say(`re-enumerated in ${Math.round(r.enumMs)} ms, first valid 0x8F after ${Math.round(up)} ms, path ${r.d.path}`);
  return keep ? R(up > 1500 ? 'WARN' : 'PASS', `layout persisted across replug; answers after ${Math.round(up)} ms` + (up > 1500 ? ' (driver retries every 1 s: fine, UI may show a delay)' : '')) : R('FAIL', 'configuration is NOT persistent (volatile RAM only)');
});
test('C6', 'C', 'R0', 'Hot-plug through the DRIVER: remove (2) then add (1) events, device usable afterwards', async () => {
  await driverUp(); const G = require('./lib/grpcweb'), ev = []; const dec = (b) => { const t = G.decode(b); return { type: G.first(t, 2, 0), n: (t[1] || []).length }; };
  const st = await G.call(PORT, 'watchDevList', Buffer.alloc(0), { stream: true, onData: (b) => ev.push({ ...dec(b), t: Date.now() }) }); await P.sleep(1500); ctx.link.close();
  const r = await replug('HOT-PLUG'); await P.sleep(4000); st.close(); if (!r) return R('FAIL', 'keyboard did not disappear/reappear');
  ctx.cmd = r.d; ctx.link = new H.Link(ctx.HID, r.d.path); say('driver events:', ev.map((e) => `type${e.type}/n${e.n}`).join(' '));
  const rem = ev.find((e) => e.type === 2), add = ev.find((e) => e.type === 1 && (!rem || e.t > rem.t)); if (!rem || !add) return R('FAIL', 'driver did not emit remove+add: ' + JSON.stringify(ev));
  const e = await G.sendMsg(PORT, r.d.path, Buffer.from([0x8f]), 0), rep = await G.readMsg(PORT, r.d.path);
  return !e && rep[0] === 0x8f && rep.readUInt32LE(1) === 910 ? R('PASS', `remove then add seen (${add.t - rem.t} ms apart); 0x8F works via driver on new path ${r.d.path}`) : R('FAIL', 'device not usable through driver after replug: ' + (e || P.hex(rep, 8)));
});
test('S1', 'S', 'R0', 'Safety guard (SIMULATOR ONLY): driver refuses firmware-class opcodes 0x7F 0x2C 0xAC 0x40 0x41 0x30 0x31', async () => {
  SRC.req('driver');
  const o = cp.spawnSync(process.execPath, [path.join(__dirname, 'guard_check.js')], { encoding: 'utf8', env: { ...process.env, SIM_QUIRKS: '' } });
  let r; try { r = JSON.parse(o.stdout.trim().split('\n').pop()); } catch (e) { return R('FAIL', 'guard_check crashed: ' + o.stderr); }
  const pass = r.filter((x) => x.reachedDevice && ![0x02, 0x1c, 0x1e].includes(x.op)).map((x) => `0x${x.op.toString(16)}/${x.via}`); say('blocked:', r.filter((x) => x.blocked).length + '/' + r.length);
  return pass.length ? R('FAIL', `${pass.length} dangerous commands reach the device unblocked: ${[...new Set(pass.map((p) => p.split('/')[0]))].join(' ')}`) : R('PASS', 'all firmware-class opcodes blocked');
});

// ---------- runner ----------
(async () => {
  if (has('--probe-writes')) {
    ctx.HID = H.loadHID(); const d = ctx.HID.devices().find(H.isCmd); if (!d) { console.log('no B6 found'); process.exit(1); } const l = new H.Link(ctx.HID, d.path);
    const mats = async () => { const o = []; for (let p = 0; p < 3; p++) o.push(await l.readMatrix(p)); return o; }, key = (m) => K.names(K.entryToKeys(P.entryAt(m, 0)) || []) || '?';
    const show = (m) => m.map((x, p) => `L${p}[${P.KEY_SLOTS.map((sl) => K.names(K.entryToKeys(P.entryAt(x, sl)) || []) || '?').join(' ')}]`).join('  ');
    const start = await mats(), act0 = await l.active(); console.log('start (active ' + act0 + '): ' + show(start)); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'probe-start-' + Date.now() + '.json'), JSON.stringify({ mats: start.map((m) => m.toString('base64')), profile: act0 }));
    const exps = [[0, 0, 1500], [1, 1, 1500], [2, 2, 1500], [0, 1, 1500], [1, 2, 1500], [2, 0, 1500], [1, 1, 300], [2, 2, 300]], rows = []; let i = 0;
    for (const [active, header, wait] of exps) {
      const cur = await mats(); await l.setProfile(active, 1000); const act = await l.active(); const mk = P.setEntry(cur[header], 0, [0, 0, F(13 + i++), 0]);
      await l.writeMatrix(header, mk, { noSwitch: true, confirm: false, settle: wait }); const aft = await mats();
      const landed = [0, 1, 2].filter((p) => !eq(aft[p].slice(0, 4), cur[p].slice(0, 4))), by = (t) => aft.map((x, p) => `L${p}=${key(x)}`).join(' ');
      const r = { active: act, header, waitMs: wait, markerLandedIn: landed.length ? landed : 'nowhere', after: by() }; rows.push(r); console.log(`active=${act} header=${header} wait=${wait}ms -> marker ${JSON.stringify(r.markerLandedIn)} | slot0 now: ${r.after}`);
      for (let tries = 0; tries < 3; tries++) { let bad = false; for (let p = 0; p < 3; p++) { const now = await l.readMatrix(p); if (!eq(now.slice(0, 504), cur[p].slice(0, 504))) { bad = true; await l.setProfile(p, 1000); await l.writeMatrix(p, cur[p], { noSwitch: true, settle: 1500 }); } } if (!bad) break; }
    }
    const end = await mats(), same = end.every((m, p) => eq(m.slice(0, 504), start[p].slice(0, 504))); await l.setProfile(act0, 600);
    console.log('\nend: ' + show(end) + '\nlayers identical to start: ' + same); fs.writeFileSync(path.join(OUT, 'probe-result-' + Date.now() + '.json'), JSON.stringify({ rows, same }, null, 1)); console.log('result saved in', OUT); process.exit(same ? 0 : 1);
  }
  if (has('--check')) { ctx.HID = H.loadHID(); const d = ctx.HID.devices().find(H.isCmd); if (!d) { console.log('no B6 found'); process.exit(1); } const l = new H.Link(ctx.HID, d.path); const ex = explain(await readState(l), JSON.parse(fs.readFileSync(snapPath(val('--check'))))); console.log(ex.length ? 'DIFFERENCES from snapshot:\n  ' + ex.join('\n  ') : 'device state identical to snapshot'); process.exit(ex.length ? 1 : 0); }
  if (has('--restore')) { const f = val('--restore'); ctx.HID = H.loadHID(); const d = ctx.HID.devices().find(H.isCmd); if (!d) { console.log('no B6 found'); process.exit(1); } const l = new H.Link(ctx.HID, d.path); const snap = JSON.parse(fs.readFileSync(snapPath(f))); console.log('before:', explain(await readState(l), snap).join('\n        ') || 'already identical'); await restoreState(l, snap); const ex = explain(await readState(l), snap); console.log(ex.length ? 'STILL DIFFERS:\n  ' + ex.join('\n  ') : 'restored OK: device state identical to ' + f); process.exit(ex.length ? 1 : 0); }
  console.log(`Firstblood B6 hardware verification  |  phases ${PHASES.join(',')}  |  writes ${ctx.flags.write ? 'ALLOWED' : 'off'}  |  ${new Date().toISOString()}`);
  ctx.HID = H.loadHID(); const need = T.filter((t) => want(t.ph) && (!ONLY.length || ONLY.includes(t.id)));
  if (need.some((t) => t.ph === 'B' || t.ph === 'C') && !ctx.flags.write) { console.log('Phases B and C write to the keyboard (everything is snapshotted and restored). Re-run with --allow-write.'); process.exit(2); }
  const d0 = ctx.HID.devices().find(H.isCmd); if (!d0) { console.log('FATAL: B6 command interface not found (A1 will explain). Is it plugged in via USB cable?'); }
  ctx.cmd = d0; ctx.link = d0 ? new H.Link(ctx.HID, d0.path) : null; if (need.some((t) => t.ph === 'C')) ctx.obs = O.make(has('--no-evdev') ? 'none' : 'evdev');
  let aborted = false; process.on('SIGINT', async () => { aborted = true; console.log('\nInterrupted: restoring device state...'); try { ctx.snap && await restoreState(ctx.link, ctx.snap); } catch (e) {} process.exit(130); });
  for (const t of need) {
    console.log(`\n[${t.id}] (${t.risk}) ${t.title}`); let r;
    try { if (!ctx.link && t.ph !== 'S') throw Object.assign(new Error('no device'), { skip: false }); r = await t.fn(); }
    catch (e) { r = e.skip ? R('SKIP', e.message) : LOST.test(String(e.message)) ? { ...R('FAIL', 'KEYBOARD DROPPED OFF USB during this test (' + e.message + '); run aborted, nothing further is written until it is back and verified'), lost: true } : R('FAIL', 'exception: ' + (e.message || e)); }
    if (ctx.snap && ctx.link) { try { if ((await ctx.link.active()) !== ctx.snap.profile) await ctx.link.setProfile(ctx.snap.profile, 400); } catch (e) {} }
    results.push({ id: t.id, title: t.title, risk: t.risk, ...r }); console.log(`  => ${r.status}: ${r.detail}`); if (aborted) break;
    if (r.lost) { console.log('\nLast commands sent before the drop (seconds before now):\n' + Q.dump(25) + '\n'); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'lost-commands-' + Date.now() + '.txt'), Q.dump(60)); console.log('\nDevice lost. Waiting up to 90 s for it to re-enumerate, then verifying and restoring state...'); const back = await relink(90000); console.log(back ? '     keyboard is back.' : '     keyboard did NOT return: replug it, then run:  node hwtest.js --restore ' + ctx.snapFile); results.push(...need.slice(need.indexOf(t) + 1).map((x) => ({ id: x.id, title: x.title, risk: x.risk, status: 'SKIP', detail: 'aborted after device loss' }))); break; }
  }
  if (ctx.snap) { try { const d = explain(await readState(ctx.link), ctx.snap); if (d.length) { console.log('\nPost-run state differs:\n  ' + d.join('\n  ') + '\nrestoring...'); await restoreState(ctx.link, ctx.snap); const d2 = explain(await readState(ctx.link), ctx.snap); console.log(d2.length ? 'STILL DIFFERS:\n  ' + d2.join('\n  ') + '\n  -> node hwtest.js --restore ' + ctx.snapFile : 'restored OK'); } else console.log('\nDevice state identical to pre-run snapshot (profile, 3 layers, LED, debounce, rates, macro 49).'); } catch (e) { console.log('post-run check failed:', e.message, ' -> node hwtest.js --restore', ctx.snapFile); } }
  fs.mkdirSync(OUT, { recursive: true }); const stamp = new Date().toISOString().replace(/[:.]/g, '-'), c = {}; results.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
  const md = ['# B6 hardware test report', '', `${new Date().toISOString()} | ${os.release()} | node ${process.version}`, '', JSON.stringify(c), '', '| id | status | detail |', '|---|---|---|', ...results.map((r) => `| ${r.id} | ${r.status} | ${String(r.detail).replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(path.join(OUT, `report-${stamp}.md`), md); fs.writeFileSync(path.join(OUT, `report-${stamp}.json`), JSON.stringify({ results, survey: ctx.survey }, null, 1));
  console.log('\n==== SUMMARY ===='); results.forEach((r) => console.log(`${r.status.padEnd(5)} ${r.id}  ${r.title}`)); console.log(JSON.stringify(c), ' report:', path.join(OUT, `report-${stamp}.md`));
  if (ctx.obs) ctx.obs.stop(); process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
})();
