'use strict';
// Command-line tools: Windows data import, device cache reset, root-folder resource overlay, purge of Windows files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const kv = require('./kv');

const say = (...a) => console.log(...a);
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;

// ------------------------------------------------------------------ root folder / resources
const COMPANY_CANDIDATES = ['resources/app/company', 'company'];
function findCompanyDir(root) {
  for (const c of COMPANY_CANDIDATES) { const p = path.join(root, c); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; }
  return null;
}
function resolveRoot(argvRoot) {
  const r = argvRoot || process.env.FB_ROOT || (process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : null);
  return r ? path.resolve(r) : null;
}
function listTree(dir, base = dir, out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listTree(p, base, out); else out.set(path.relative(base, p), p);
  }
  return out;
}
// Build a folder that looks like the app folder but whose company/ resources (pictures etc.) come from the
// Windows root folder, falling back to the bundled ones for anything missing there.
function buildOverlay(realApp, extCompany, userData) {
  const base = path.join(os.tmpdir(), `fb-overlay-${process.getuid ? process.getuid() : 0}`);
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  for (const e of fs.readdirSync(realApp)) if (e !== 'company') fs.symlinkSync(path.join(realApp, e), path.join(base, e));
  const files = new Map();
  for (const src of [path.join(realApp, 'company'), extCompany]) {
    // from the Windows folder only pictures are taken (its CONFIG.json etc. must not change this build's behaviour)
    if (src && fs.existsSync(src)) for (const [rel, abs] of listTree(src)) if (src !== extCompany || IMG_RE.test(rel)) files.set(rel, abs);
  }
  // CONFIG.json is rewritten by the app (language choice), so a writable copy lives in the user-data folder.
  if (userData) {
    for (const [rel, abs] of [...files]) {
      if (path.basename(rel) !== 'CONFIG.json') continue;
      try {
        const dir = path.join(userData, 'config'); fs.mkdirSync(dir, { recursive: true });
        const keep = path.join(dir, rel.split(path.sep).join('__'));
        const bundled = JSON.parse(fs.readFileSync(abs, 'utf8'));
        let cur = {}; try { cur = JSON.parse(fs.readFileSync(keep, 'utf8')); } catch (e) {}
        const merged = Object.assign({}, cur, { company: bundled.company, displayName: bundled.displayName, singleDriver: bundled.singleDriver, blockCloud: bundled.blockCloud });
        fs.writeFileSync(keep, JSON.stringify(merged, null, 4));
        files.set(rel, keep);
      } catch (e) { /* fall back to the read-only bundled copy */ }
    }
  }
  for (const [rel, abs] of files) {
    const dest = path.join(base, 'company', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(abs, dest);
  }
  return { base, count: files.size };
}

function companyIcon(companyDir) {
  try {
    for (const d of fs.readdirSync(companyDir)) {
      const p = path.join(companyDir, d, 'icon.png');
      if (d.startsWith('company_') && fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return null;
}

// ------------------------------------------------------------------ absorb: bake the Windows graphics into a new AppImage
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => (e ? rej(new Error((se || e.message).trim())) : res(so))));
async function absorb(root, output) {
  const appimage = process.env.APPIMAGE, appdir = process.env.APPDIR;
  if (!appimage || !appdir) { say('--absorb-windows-files only works when running the AppImage itself.'); return 1; }
  const ext = root && findCompanyDir(root);
  if (!ext) { say(`'${root}' does not look like the Windows root folder (no resources/app/company). Put the AppImage there or use --root <folder>.`); return 1; }
  const mk = [path.join(appdir, 'usr/lib/firstblood/bin/mksquashfs'), '/usr/bin/mksquashfs'].find((p) => fs.existsSync(p));
  if (!mk) { say('mksquashfs is missing.'); return 1; }
  const out = output || path.join(path.dirname(appimage), path.basename(appimage).replace(/\.AppImage$/i, '') + '-portable.AppImage');
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'firstblood-driver');
  fs.mkdirSync(cache, { recursive: true });
  const stage = fs.mkdtempSync(path.join(cache, 'absorb-'));
  try {
    say('Copying the application to a work folder...');
    await run('cp', ['-a', appdir + '/.', stage]);
    const destCompany = path.join(stage, 'usr/lib/firstblood/resources/app/company');
    fs.rmSync(destCompany, { recursive: true, force: true });   // bundled placeholders are replaced by the Windows graphics
    let n = 0;
    for (const [rel, abs] of listTree(ext)) {
      if (!IMG_RE.test(rel)) continue;
      const d = path.join(destCompany, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(abs, d); n++;
    }
    const cfg = path.join(appdir, 'usr/lib/firstblood/resources/app/company');
    for (const [rel, abs] of listTree(cfg)) if (!IMG_RE.test(rel)) { const d = path.join(destCompany, rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(abs, d); }
    const icon = companyIcon(destCompany);
    if (icon) { fs.copyFileSync(icon, path.join(stage, 'firstblood-driver.png')); say('Main icon taken from ' + path.relative(destCompany, icon)); }
    else say('Note: no company_*/icon.png found; keeping the placeholder icon.');
    say(`Absorbed ${n} picture file(s). Building the new AppImage (this takes a minute)...`);
    const sq = path.join(cache, 'new.squashfs'); fs.rmSync(sq, { force: true });
    await run(mk, [stage, sq, '-noappend', '-comp', 'gzip', '-no-progress', '-quiet', '-all-root']);
    const offset = Number((await run(appimage, ['--appimage-offset'])).trim());
    if (!offset) throw new Error('could not determine the AppImage runtime size');
    const fd = fs.openSync(appimage, 'r'); const head = Buffer.alloc(offset); fs.readSync(fd, head, 0, offset, 0); fs.closeSync(fd);
    fs.writeFileSync(out, head); fs.appendFileSync(out, fs.readFileSync(sq)); fs.chmodSync(out, 0o755); fs.rmSync(sq, { force: true });
    say('Created: ' + out);
    say('This copy contains the graphics and icon, so it no longer needs the Windows folder.');
    return 0;
  } catch (e) { say('Failed: ' + e.message); return 1; }
  finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ purge
// Files of the Windows install that the Linux build does not need. Matched by exact relative path (case-insensitive).
const KNOWN_WINDOWS_FILES = [
  'Firstblood Driver.exe', 'Uninstall Firstblood Driver.exe', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat', 'natives_blob.bin',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'libEGL.dll', 'libGLESv2.dll', 'vcruntime140.dll', 'ffmpeg.dll',
  'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'dxcompiler.dll', 'dxil.dll',
  'resources/electron.asar', 'resources/elevate.exe', 'resources/app/iot_driver.exe', 'resources/app/index.html',
  'resources/app/package.json', 'resources/app/dist/index.js', 'resources/app/dist/main.js',
];
const KNOWN_PATTERNS = [/^locales\/[^/]+\.pak$/i];
const KNOWN_DIRS = ['locales', 'resources/app/dist']; // removed afterwards only if they end up empty
// Resources the Linux build still uses: never deleted even if a name above would match.
const REQUIRED = [/^resources\/app\/company(\/|$)/i, /^company(\/|$)/i, /^resources\/app\/CurrentCompany\.json$/i];

async function confirm(q) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }));
}
async function purge(root, opts) {
  if (!root) { say('No root folder known. Put the AppImage in the Windows install folder or use --root <folder>.'); return 1; }
  if (root === '/' || root === os.homedir()) { say('Refusing to purge ' + root); return 1; }
  if (!findCompanyDir(root)) { say(`'${root}' does not look like the Windows root folder (no resources/app/company). Nothing done.`); return 1; }
  const self = process.env.APPIMAGE ? path.resolve(process.env.APPIMAGE) : null;
  const known = new Set(KNOWN_WINDOWS_FILES.map((f) => f.toLowerCase()));
  const hits = [];
  for (const [rel, abs] of listTree(root)) {
    const norm = rel.split(path.sep).join('/');
    if (self && path.resolve(abs) === self) continue;
    if (REQUIRED.some((re) => re.test(norm))) continue;
    if (fs.lstatSync(abs).isSymbolicLink()) continue;
    if (known.has(norm.toLowerCase()) || KNOWN_PATTERNS.some((re) => re.test(norm))) hits.push({ rel: norm, abs, size: fs.statSync(abs).size });
  }
  if (!hits.length) { say('No unrequired Windows files found in ' + root); return 0; }
  const total = hits.reduce((a, h) => a + h.size, 0);
  say(`Unrequired Windows files in ${root}:`);
  for (const h of hits) say(`  ${h.rel}  (${(h.size / 1048576).toFixed(2)} MB)`);
  say(`${hits.length} files, ${(total / 1048576).toFixed(1)} MB. Kept: company/ resources, CurrentCompany.json, the AppImage and everything else not listed.`);
  if (opts.dryRun) { say('Dry run: nothing deleted.'); return 0; }
  if (!opts.yes && !(await confirm('Delete these files? Type "yes": '))) { say('Cancelled. (Use --yes to skip this question.)'); return 1; }
  for (const h of hits) { try { fs.unlinkSync(h.abs); } catch (e) { say('  could not delete ' + h.rel + ': ' + e.message); } }
  for (const d of KNOWN_DIRS) { const p = path.join(root, d); try { if (fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmdirSync(p); } catch (e) {} }
  say('Done.');
  return 0;
}

// ------------------------------------------------------------------ device cache reset
function resetDeviceCache(userData) {
  const dir = path.join(userData, 'iot_db', 'CONFIG');
  const keys = kv.keysJSON(dir).filter((k) => typeof k === 'string' && k.startsWith('devConfig_'));
  keys.forEach((k) => kv.delJSON(dir, k));
  say(`Cleared ${keys.length} cached keyboard layout(s). The app will read the keys from the keyboard on the next connect.`);
  return 0;
}

// ------------------------------------------------------------------ duplicate configurations + backups
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
// Removes entries that are exact copies (same name, device, key values, settings) of an earlier entry. Entries that differ in any way stay.
function dedupeConfigs(userData, quiet) {
  const dir = path.join(userData, 'iot_db', 'CONFIG');
  const list = kv.getJSON(dir, 'config');
  if (!Array.isArray(list)) return 0;
  const seen = new Set(); const keep = [];
  for (const c of list) {
    const sig = stable(JSON.parse(JSON.stringify({ n: c.name, d: c.deviceType && c.deviceType.id, v: c.value, r: c.reportRate, f: c.fn, p: c.dpi, x: !!c.needDelete })));
    if (seen.has(sig)) continue; seen.add(sig); keep.push(c);
  }
  const removed = list.length - keep.length;
  if (removed > 0) {
    kv.backupAll(userData, 'before-dedupe');
    kv.setJSON(dir, 'config', keep);
    if (!quiet) say(`Removed ${removed} duplicate configuration entr${removed === 1 ? 'y' : 'ies'}.`);
  }
  return removed;
}
const countOf = (f, key) => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); const k = Buffer.from(JSON.stringify(key)).toString('base64'); return d[k] ? JSON.parse(Buffer.from(d[k], 'base64')).length : 0; } catch (e) { return '?'; } };
function listBackups(userData) {
  const root = kv.backupsRoot(path.join(userData, 'iot_db'));
  let names = []; try { names = fs.readdirSync(root).sort().reverse(); } catch (e) {}
  if (!names.length) { say('No backups yet (' + root + ').'); return []; }
  say('Backups in ' + root + ' (newest first):');
  for (const n of names) say(`  ${n}   configurations: ${countOf(path.join(root, n, 'CONFIG.json'), 'config')}   macros: ${countOf(path.join(root, n, 'macro.json'), 'APP_macro')}`);
  return names;
}
function restoreBackup(userData, name) {
  const root = kv.backupsRoot(path.join(userData, 'iot_db'));
  const src = path.join(root, name);
  if (!name || !fs.existsSync(src)) { say(name ? `No such backup: ${name}` : 'Give the name of a backup to restore (see --list-backups).'); return 1; }
  kv.backupAll(userData, 'before-restore');
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.json')) continue;
    const dir = path.join(userData, 'iot_db', f.replace(/\.json$/, '')); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(dir, 'store.json')); n++;
  }
  say(`Restored ${n} store(s) from ${name}. (The previous state was saved as a "before-restore" backup.)`);
  return 0;
}

// ------------------------------------------------------------------ Windows data import
async function importWindows(src, userData, opts) {
  let dbFile = src;
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
    dbFile = ['db', 'Firstblood Driver/db'].map((r) => path.join(src, r)).find((p) => fs.existsSync(p));
  }
  if (!dbFile || !fs.existsSync(dbFile)) { say(`Could not find the Windows 'db' file in: ${src}`); return 1; }
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => require.resolve('sql.js/dist/' + f) });
  const db = new SQL.Database(fs.readFileSync(dbFile));
  const rows = (q) => { const st = db.prepare(q); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };
  const parse = (v, d) => { try { return JSON.parse(v); } catch (e) { return d; } };
  const types = new Map(rows('select * from l').map((r) => [r.id, r]));
  const devType = (id) => {
    const r = types.get(id) || { id };
    return { group: r.group || 'rongyuan', company: r.company || 'rongyuan', devAddr: -1, is24: false, isblue: false, layer: 0, fnLayer: 0,
      id: r.id, vid: r.vid, pid: r.pid, name: r.name, displayName: r.displayName, type: r.type || 'keyboard',
      support_onboard: r.support_onboard, usage: r.usage, usagePage: r.usagePage, featureReportByteLength: r.featureReportByteLength,
      needLock: !!r.needLock, layout: parse(r.layout, undefined), logoLayout: parse(r.logoLayout, undefined), otherSetting: parse(r.otherSetting, undefined) };
  };
  const cfgDir = path.join(userData, 'iot_db', 'CONFIG');
  const macDir = path.join(userData, 'iot_db', 'macro');
  for (const d of [cfgDir, macDir]) { // back up before touching anything
    const f = path.join(d, 'store.json');
    if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + Date.now());
  }
  const current = rows('select currentConfigLocalId as c from i')[0];
  // profiles ("u" table) -> saved configurations
  const configs = kv.getJSON(cfgDir, 'config') || [];
  let nc = 0;
  for (const r of rows('select * from u order by localId')) {
    if (r.needDelete && !opts.includeDeleted) continue;
    const id = 'windows-u-' + r.localId;
    const cfg = { localId: id, serverId: r.serverId || undefined, name: `${r.name} (Windows ${r.localId})`, category: '', reportRate: r.reportRate,
      value: parse(r.value, []), light: { type: 'LightOff' }, deviceType: devType(r.deviceTypeId), fn: false, dpi: [],
      isShared: false, hasUpload: false, needDelete: !!r.needDelete };
    const i = configs.findIndex((c) => c.localId === id);
    if (i < 0) configs.push(cfg); else configs[i] = cfg;
    nc++;
  }
  kv.setJSON(cfgDir, 'config', configs);
  // macros ("c" table) -> macro library
  const macros = kv.getJSON(macDir, 'APP_macro') || [];
  let nm = 0;
  for (const r of rows('select * from c order by localId')) {
    if (r.needDelete && !opts.includeDeleted) continue;
    const id = 'windows-c-' + r.localId;
    const m = { localId: id, name: r.name, category: r.category || '/', value: parse(r.value, { macro: [], macroType: 'touch_repeat', repeatCount: 1 }),
      createAt: r.createAt, updatedAt: r.updatedAt, isShared: false, hasUpload: false, needDelete: !!r.needDelete, deviceTypeId: r.deviceTypeId };
    const i = macros.findIndex((c) => c.localId === id);
    if (i < 0) macros.push(m); else macros[i] = m;
    nm++;
  }
  kv.setJSON(macDir, 'APP_macro', macros);
  say(`Imported ${nc} saved configuration(s) and ${nm} macro(s) from ${dbFile}`);
  if (current) say(`(Windows "current configuration" was #${current.c}.)`);
  say('Previous data was backed up next to the store files (store.json.bak-*).');
  say('Open the app: the configurations are in the "Configuration" drop-down and the macros in the Macro tab. Selecting a configuration applies it to the keyboard.');
  return 0;
}

// ------------------------------------------------------------------ udev rules (one-time, needs admin rights)
const RULES_NAME = '70-firstblood.rules';
const RULES_DEST = '/etc/udev/rules.d/' + RULES_NAME;
const rulesSource = () => path.join(__dirname, '..', '..', '..', RULES_NAME);
function rulesInstalledAndCurrent() {
  try { return fs.readFileSync(RULES_DEST, 'utf8') === fs.readFileSync(rulesSource(), 'utf8'); } catch (e) { return false; }
}
// Copies the rules via a normal temp file (root cannot read the user's AppImage mount) and asks polkit for rights.
function installUdevRules() {
  return new Promise((resolve) => {
    let tmp;
    try { tmp = path.join(os.tmpdir(), `${RULES_NAME}.${process.pid}`); fs.copyFileSync(rulesSource(), tmp); fs.chmodSync(tmp, 0o644); }
    catch (e) { return resolve({ ok: false, error: 'cannot read bundled rules: ' + e.message }); }
    const script = `install -m 644 '${tmp}' ${RULES_DEST} && rm -f /etc/udev/rules.d/99-firstblood.rules; ` +
      `command -v restorecon >/dev/null 2>&1 && restorecon ${RULES_DEST}; ` +
      'udevadm control --reload-rules; udevadm trigger --subsystem-match=hidraw --action=change; udevadm settle --timeout=5; true';
    const isRoot = process.getuid && process.getuid() === 0;
    const cmd = isRoot ? ['sh', ['-c', script]] : ['pkexec', ['sh', '-c', script]];
    execFile(cmd[0], cmd[1], { timeout: 120000 }, (err, so, se) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (err) return resolve({ ok: false, error: err.code === 'ENOENT' ? 'pkexec (polkit) is not installed' : (se || err.message).trim(), cancelled: err.code === 126 || err.code === 127 });
      resolve({ ok: rulesInstalledAndCurrent() });
    });
  });
}

module.exports = { dedupeConfigs, listBackups, restoreBackup, absorb, companyIcon, installUdevRules, rulesInstalledAndCurrent, RULES_DEST, resolveRoot, findCompanyDir, buildOverlay, purge, resetDeviceCache, importWindows, KNOWN_WINDOWS_FILES };
