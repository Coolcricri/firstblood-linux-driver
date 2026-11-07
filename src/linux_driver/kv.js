'use strict';
// Key/value store (replacement for the vendor's sled DB). One directory per "dbpath" under <userData>/iot_db/;
// store.json maps base64(key bytes) -> base64(value bytes). The UI uses JSON.stringify(key/value) as the bytes.
const fs = require('fs');
const path = require('path');
const stores = new Map();
const b64 = (b) => Buffer.from(b).toString('base64');
const ts = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-');

function load(s) {
  try {
    const st = fs.statSync(s.file);
    const text = fs.readFileSync(s.file, 'utf8');
    try { s.data = JSON.parse(text); }
    catch (e) { // never silently overwrite a damaged file
      fs.copyFileSync(s.file, s.file + '.corrupt-' + Date.now());
      console.error('[fb-driver] ' + s.file + ' is damaged; a copy was kept as .corrupt-*');
      s.data = {};
    }
    s.mtime = st.mtimeMs;
  } catch (e) { s.data = {}; s.mtime = 0; }
}
// another process (e.g. --import-windows-data) may have changed the file: never write from a stale copy
function fresh(s) { try { if (fs.statSync(s.file).mtimeMs !== s.mtime) load(s); } catch (e) {} }
function store(dir) {
  let s = stores.get(dir);
  if (!s) { s = { file: path.join(dir, 'store.json'), data: {}, dir, mtime: 0, lastBackup: 0 }; load(s); stores.set(dir, s); } else fresh(s);
  return s;
}
function save(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const tmp = s.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s.data));
  fs.renameSync(tmp, s.file);
  try { s.mtime = fs.statSync(s.file).mtimeMs; } catch (e) {}
}

// ---- backups: <userData>/backups/<timestamp>-<reason>/<store>.json (newest 25 kept)
const backupsRoot = (iotDbDir) => path.join(iotDbDir, '..', 'backups');
function prune(root, keep = 25) {
  try { const all = fs.readdirSync(root).sort(); all.slice(0, Math.max(0, all.length - keep)).forEach((d) => fs.rmSync(path.join(root, d), { recursive: true, force: true })); } catch (e) {}
}
function backupStore(s, reason) {
  try {
    if (!fs.existsSync(s.file) || Date.now() - s.lastBackup < 5000) return;
    s.lastBackup = Date.now();
    const root = backupsRoot(path.join(s.dir, '..'));
    const d = path.join(root, ts() + '-' + reason); fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(s.file, path.join(d, path.basename(s.dir) + '.json')); prune(root);
  } catch (e) {}
}
function backupAll(userData, reason) {
  const iot = path.join(userData, 'iot_db'); let n = 0;
  try {
    const d = path.join(backupsRoot(iot), ts() + '-' + reason);
    for (const name of fs.readdirSync(iot)) {
      const f = path.join(iot, name, 'store.json');
      if (fs.existsSync(f)) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(f, path.join(d, name + '.json')); n++; }
    }
    prune(backupsRoot(iot));
  } catch (e) {}
  return n;
}

const keyOf = (k) => b64(Buffer.from(JSON.stringify(k)));
function getJSON(dir, k) { const v = store(dir).data[keyOf(k)]; return v === undefined ? undefined : JSON.parse(Buffer.from(v, 'base64').toString('utf8')); }
function setJSON(dir, k, val) { const s = store(dir); s.data[keyOf(k)] = b64(Buffer.from(JSON.stringify(val))); save(s); }
function keysJSON(dir) { return Object.keys(store(dir).data).map((k) => { try { return JSON.parse(Buffer.from(k, 'base64').toString('utf8')); } catch (e) { return null; } }); }
function delJSON(dir, k) { const s = store(dir); const had = keyOf(k) in s.data; delete s.data[keyOf(k)]; if (had) save(s); return had; }
module.exports = { store, save, b64, getJSON, setJSON, keysJSON, delJSON, backupStore, backupAll, backupsRoot, ts };
