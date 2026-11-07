// Storage tests: stale-cache protection, damaged-file guard, backups, restore, duplicate configuration removal.
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const kv = require("../src/linux_driver/kv"), tools = require("../src/linux_driver/tools");
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const ud = () => fs.mkdtempSync(path.join(os.tmpdir(), "ud-"));
const tests = [], test = (n, f) => tests.push([n, f]);
const raw = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"));
const kb = (k) => Buffer.from(JSON.stringify(k)).toString("base64");

test("an external change (importer) is not overwritten by the app's stale copy", () => {
  const d = path.join(ud(), "iot_db", "macro"); kv.setJSON(d, "APP_macro", [{ n: 1 }]); kv.store(d);
  const ext = raw(d); ext[kb("APP_macro")] = Buffer.from(JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }])).toString("base64");
  const f = path.join(d, "store.json"); const t = new Date(Date.now() + 5000); fs.writeFileSync(f, JSON.stringify(ext)); fs.utimesSync(f, t, t);
  const s = kv.store(d); s.data[kb("other")] = "MQ=="; kv.save(s);
  assert.strictEqual(kv.getJSON(d, "APP_macro").length, 3); assert.ok(kb("other") in raw(d));
});
test("a damaged store file is preserved, never silently overwritten", () => {
  const d = path.join(ud(), "iot_db", "CONFIG"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "store.json"), "{not json");
  const l = console.error; console.error = () => {}; kv.store(d); console.error = l;
  assert.ok(fs.readdirSync(d).some((f) => f.includes(".corrupt-")));
});
test("duplicate configurations: exact copies removed, different ones kept, backup made", () => {
  const u = ud(), d = path.join(u, "iot_db", "CONFIG");
  const mk = (id, name, v) => ({ localId: id, name, deviceType: { id: 910 }, value: v, reportRate: 1000 });
  kv.setJSON(d, "config", [mk("a", "B6", [{ type: "combo", original: 80, key: 4 }]), mk("b", "B6", [{ type: "combo", original: 80, key: 4 }]), mk("c", "B6", [{ type: "combo", original: 80, key: 5 }]), mk("d", "Other", [{ type: "combo", original: 80, key: 4 }])]);
  assert.strictEqual(quiet(() => tools.dedupeConfigs(u)), 1); assert.deepStrictEqual(kv.getJSON(d, "config").map((c) => c.localId), ["a", "c", "d"]);
  assert.ok(fs.readdirSync(path.join(u, "backups")).some((n) => n.endsWith("before-dedupe")));
  assert.strictEqual(quiet(() => tools.dedupeConfigs(u)), 0);
});
test("backups can be listed and restored (and the restore itself is backed up)", () => {
  const u = ud(), d = path.join(u, "iot_db", "macro"); kv.setJSON(d, "APP_macro", [{ n: 1 }, { n: 2 }]);
  kv.backupAll(u, "startup"); const name = fs.readdirSync(path.join(u, "backups"))[0];
  kv.setJSON(d, "APP_macro", []); kv.store(d);
  assert.strictEqual(quiet(() => tools.restoreBackup(u, name)), 0); assert.strictEqual(kv.getJSON(d, "APP_macro").length, 2);
  assert.ok(fs.readdirSync(path.join(u, "backups")).some((n) => n.endsWith("before-restore")));
  assert.strictEqual(quiet(() => tools.restoreBackup(u, "nope")), 1);
});
let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + (e.message || e)); } }
console.log(failed ? failed + " test(s) failed" : "storage: all " + tests.length + " tests passed"); process.exit(failed ? 1 : 0);
