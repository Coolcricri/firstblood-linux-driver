// Driver tests: gRPC-web framing, device list, feature-report framing + checksums, database, microphone, safeguards.
const assert = require("assert"), http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
process.env.FB_HID_MODULE = path.join(__dirname, "mock/node-hid/index.js");
process.env.FB_DRIVER_PORT = process.env.FB_DRIVER_PORT || "38141";
const src = path.join(__dirname, "../src/linux_driver");
const { enc, decode, first, str } = require(src + "/pb");
const drv = require(src + "/driver"); drv.start();
const frame = (b) => { const h = Buffer.alloc(5); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
function call(method, msg = Buffer.alloc(0), text = false, stream = false) {
  return new Promise((res) => {
    const body = text ? Buffer.from(frame(msg).toString("base64")) : frame(msg);
    const req = http.request({ host: "127.0.0.1", port: +process.env.FB_DRIVER_PORT, path: "/driver.DriverGrpc/" + method, method: "POST",
      headers: { "content-type": text ? "application/grpc-web-text" : "application/grpc-web+proto" } }, (rs) => {
      const ch = []; let done = false;
      const fin = () => { if (done) return; done = true; let b = Buffer.concat(ch); if (text) b = Buffer.from(b.toString("latin1"), "base64"); const out = []; let i = 0; while (i + 5 <= b.length) { const l = b.readUInt32BE(i + 1); out.push([b[i], b.slice(i + 5, i + 5 + l)]); i += 5 + l; } res(out); };
      rs.on("data", (c) => { ch.push(c); if (stream) { req.destroy(); fin(); } }); rs.on("end", fin);
    }); req.on("error", () => {}); req.end(body);
  });
}
const send = (m, t, p = "/dev/hidraw7") => call("sendMsg", Buffer.concat([enc.str(1, p), enc.bytes(2, m), enc.uint(3, t)]));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("device list: only the B6 command interface, id 910 (binary and text transports)", async () => {
  await new Promise((r) => setTimeout(r, 1800));
  for (const text of [true, false]) {
    const o = await call("watchDevList", Buffer.alloc(0), text, true);
    const dl = decode(o[0][1]); const devs = dl[1] || [];
    assert.strictEqual(devs.length, 1, "exactly one device");
    const dev = decode(first(decode(devs[0]), 1));
    assert.strictEqual(str(dev, 3), "/dev/hidraw7"); assert.strictEqual(first(dev, 4), 910);
    assert.strictEqual(first(dev, 7), 0x3151); assert.strictEqual(first(dev, 8), 0x4015);
  }
});
test("BIT7 checksum: byte7 = ~sum(bytes 0..6)", async () => {
  const o = await send(Buffer.from([0x07, 1, 2]), 0); assert.strictEqual(o[0][1].length, 0, "no error");
  const w = global.__log.pop(); assert.strictEqual(w.length, 64); assert.strictEqual(w[7], (~(7 + 1 + 2)) & 0xff);
});
test("BIT8 checksum: byte8 = ~sum(bytes 0..7)", async () => {
  await send(Buffer.from([0x07, 1, 2]), 1); const w = global.__log.pop(); assert.strictEqual(w[8], (~(7 + 1 + 2)) & 0xff); assert.strictEqual(w[7], 0);
});
test("no checksum: payload untouched", async () => { await send(Buffer.from([0x05, 9]), 2); const w = global.__log.pop(); assert.deepStrictEqual([...w.slice(0, 9)], [5, 9, 0, 0, 0, 0, 0, 0, 0]); });
test("read returns a 64-byte report", async () => { const o = await call("readMsg", enc.str(1, "/dev/hidraw7")); assert.strictEqual(first(decode(o[0][1]), 2).length, 64); });
test("unknown device path is reported as an error", async () => { const o = await send(Buffer.from([1]), 2, "/dev/nope"); assert.ok(str(decode(o[0][1]), 1).includes("not found")); });
test("bootloader command 0x7F is refused", async () => { global.__log.length = 0; const o = await send(Buffer.from([0x7f, 1, 2]), 0); assert.ok(str(decode(o[0][1]), 1).startsWith("blocked")); assert.strictEqual(global.__log.length, 0); });
test("key/value store: insert, get, list, miss, delete", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "fbdb-")), k = Buffer.from("\"k1\""), v = Buffer.from("{\"a\":1}");
  await call("insertDb", Buffer.concat([enc.str(1, d), enc.bytes(2, k), enc.bytes(3, v)]));
  assert.strictEqual(first(decode((await call("getItemFromDb", Buffer.concat([enc.str(1, d), enc.bytes(2, k)])))[0][1]), 1).toString(), "{\"a\":1}");
  assert.strictEqual(first(decode((await call("getAllKeysFromDb", enc.str(1, d)))[0][1]), 1).toString(), "\"k1\"");
  assert.strictEqual(str(decode((await call("getItemFromDb", Buffer.concat([enc.str(1, d), enc.bytes(2, Buffer.from("\"zz\""))])))[0][1]), 2), "not found");
  await call("deleteItemFromDb", Buffer.concat([enc.str(1, d), enc.bytes(2, k)]));
  assert.strictEqual(str(decode((await call("getItemFromDb", Buffer.concat([enc.str(1, d), enc.bytes(2, k)])))[0][1]), 2), "not found");
});
test("microphone mute via pactl (stand-in) and a clear error without audio tools", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fakebin-")), st = path.join(bin, "state");
  fs.writeFileSync(path.join(bin, "pactl"), "#!/bin/sh\nS=" + st + "\n[ -f $S ] || echo no > $S\ncase \"$1\" in get-source-mute) echo \"Mute: $(cat $S)\";; set-source-mute) if [ \"$3\" = toggle ]; then [ \"$(cat $S)\" = yes ] && echo no > $S || echo yes > $S; elif [ \"$3\" = 1 ]; then echo yes > $S; else echo no > $S; fi;; esac\n", { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin + ":" + oldPath;
  const muted = async () => !!first(decode((await call("getMicrophoneMute"))[0][1]), 1, 0);
  assert.strictEqual(await muted(), false); await call("toggleMicrophoneMute"); assert.strictEqual(await muted(), true);
  await call("toggleMicrophoneMute"); assert.strictEqual(await muted(), false);
  await call("muteMicrophone", enc.bool(1, true)); assert.strictEqual(await muted(), true);
  process.env.PATH = "/nonexistent";
  assert.ok(str(decode((await call("getMicrophoneMute"))[0][1]), 2).includes("no microphone"));
  process.env.PATH = oldPath;
});
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) { try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.message || e)); } }
  console.log(failed ? failed + " test(s) failed" : "driver: all " + tests.length + " tests passed"); process.exit(failed ? 1 : 0);
})();
