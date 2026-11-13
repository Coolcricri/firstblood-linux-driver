'use strict';
// Linux replacement for the vendor "iot_driver" helper: gRPC-web server on 127.0.0.1:3814
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { enc, decode, first, str } = require('./pb');
const { Manager } = require('./hid');

const PORT = Number(process.env.FB_DRIVER_PORT || 3814);
const mgr = new Manager();

// ---------- key/value store ----------
const kvm = require('./kv');
const { store, save: saveStore, b64 } = kvm;
const mic = require('./mic');

// ---------- message builders ----------
const deviceMsg = (d) => Buffer.concat([
  enc.uint(1, 0), enc.bool(2, false), enc.str(3, d.path), enc.uint(4, d.id >>> 0), 
  enc.bool(6, true), enc.uint(7, d.info.vendorId), enc.uint(8, d.info.productId)]);
const deviceList = (list, type) => Buffer.concat([
  ...list.map((d) => enc.msg(1, enc.msg(1, deviceMsg(d)))), enc.uint(2, type)]);

// ---------- RPC handlers ----------
// Firmware updating is not part of this build: refuse the command that makes the keyboard enter its bootloader (0x7F).
// Firmware-class opcodes named in the vendor bundle: bootloader entry (0x7F), flash chip erase (0x2C/0xAC), LED-MCU and OLED
// bootloaders (0x40/0x41/0x30/0x31). The B6 UI never needs them. FB_ALLOW_FIRMWARE=1 lifts the block.
const FORBIDDEN_CMD = new Set([0x7f, 0x2c, 0xac, 0x40, 0x41, 0x30, 0x31]);
const forbidden = (b, raw) => !process.env.FB_ALLOW_FIRMWARE && b && b.length > (raw ? 1 : 0) && FORBIDDEN_CMD.has(b[raw ? 1 : 0]);
const unary = {
  async sendMsg(req) {
    const m = decode(req);
    if (forbidden(first(m, 2), false)) return enc.str(1, 'blocked: firmware/bootloader commands are disabled in this build');
    try { await mgr.get(str(m, 1)).send(first(m, 2, Buffer.alloc(0)), first(m, 3, 0)); return Buffer.alloc(0); }
    catch (e) { return enc.str(1, String(e.message || e)); }
  },
  async readMsg(req) {
    const m = decode(req);
    try { return enc.bytes(2, await mgr.get(str(m, 1)).read()); }
    catch (e) { return enc.str(1, String(e.message || e)); }
  },
  async sendRawFeature(req) {
    const m = decode(req);
    if (forbidden(first(m, 2), true)) return enc.str(1, 'blocked: firmware/bootloader commands are disabled in this build');
    try { await mgr.get(str(m, 1)).sendRaw(first(m, 2, Buffer.alloc(0))); return Buffer.alloc(0); }
    catch (e) { return enc.str(1, String(e.message || e)); }
  },
  async readRawFeature(req) { return unary.readMsg(req); },
  async cleanDev() { return Buffer.alloc(0); },
  async setLightType() { return Buffer.alloc(0); },
  async changeWirelessLoopStatus() { return Buffer.alloc(0); },
  async muteMicrophone(req) {
    try { await mic.setMute(!!first(decode(req), 1, 0)); return Buffer.alloc(0); } catch (e) { return enc.str(1, String(e.message)); }
  },
  async toggleMicrophoneMute() {
    try { await mic.setMute('toggle'); return Buffer.alloc(0); } catch (e) { return enc.str(1, String(e.message)); }
  },
  async getMicrophoneMute() {
    try { return enc.bool(1, await mic.getMute()); } catch (e) { return enc.str(2, String(e.message)); }
  },
  async insertDb(req) {
    const m = decode(req);
    try {
      const s = store(str(m, 1)); const key = b64(first(m, 2, Buffer.alloc(0))); const val = first(m, 3, Buffer.alloc(0));
      try { // a list that gets shorter (e.g. an accidental empty overwrite) is backed up first so it can be restored
        const old = s.data[key];
        if (old !== undefined) {
          const o = JSON.parse(Buffer.from(old, 'base64').toString('utf8')), n = JSON.parse(Buffer.from(val).toString('utf8'));
          if (Array.isArray(o) && Array.isArray(n) && n.length < o.length) kvm.backupStore(s, 'shrink-' + require('path').basename(s.dir));
        }
      } catch (e) {}
      s.data[key] = b64(val); saveStore(s); return Buffer.alloc(0);
    } catch (e) { return enc.str(1, String(e.message)); }
  },
  async deleteItemFromDb(req) {
    const m = decode(req);
    try { const s = store(str(m, 1)); kvm.backupStore(s, 'delete-' + require('path').basename(s.dir)); delete s.data[b64(first(m, 2, Buffer.alloc(0)))]; saveStore(s); return Buffer.alloc(0); }
    catch (e) { return enc.str(1, String(e.message)); }
  },
  async getItemFromDb(req) {
    const m = decode(req);
    const v = store(str(m, 1)).data[b64(first(m, 2, Buffer.alloc(0)))];
    return v === undefined ? enc.str(2, 'not found') : enc.bytes(1, Buffer.from(v, 'base64'));
  },
  async getAllKeysFromDb(req) {
    const s = store(str(decode(req), 1));
    return Buffer.concat(Object.keys(s.data).map((k) => enc.msg(1, Buffer.from(k, 'base64'))));
  },
  async getAllValuesFromDb(req) {
    const s = store(str(decode(req), 1));
    return Buffer.concat(Object.values(s.data).map((v) => enc.msg(1, Buffer.from(v, 'base64'))));
  },
};

// streaming handlers: (req, push) -> cleanup()
const streaming = {
  watchDevList(req, push) {
    const cb = (list, type) => push(deviceList(list, type));
    mgr.listeners.add(cb);
    if (!mgr.first) cb(mgr.list(), 0);
    return () => mgr.listeners.delete(cb);
  },
  watchVender(req, push) {
    const cb = (b) => push(enc.msg(1, b));
    mgr.vender.add(cb);
    return () => mgr.vender.delete(cb);
  },
  watchSystemInfo(req, push) {
    let last = os.cpus();
    const tick = () => {
      const cur = os.cpus(); let idle = 0, tot = 0;
      cur.forEach((c, i) => { const p = last[i]; for (const k in c.times) tot += c.times[k] - p.times[k]; idle += c.times.idle - p.times.idle; });
      last = cur;
      push(Buffer.concat([enc.uint(6, os.totalmem()), enc.uint(7, os.totalmem() - os.freemem()), enc.float(8, tot ? 100 * (1 - idle / tot) : 0)]));
    };
    tick(); const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  },
  upgradeOTAGATT(req, push) { push(enc.str(2, 'OTA over Bluetooth is not supported in the Linux build')); return () => {}; },
};

// ---------- gRPC-web transport ----------
function frames(buf) {
  const out = []; let i = 0;
  while (i + 5 <= buf.length) { const len = buf.readUInt32BE(i + 1); out.push({ flag: buf[i], data: buf.slice(i + 5, i + 5 + len) }); i += 5 + len; }
  return out;
}
const frame = (flag, data) => { const h = Buffer.alloc(5); h[0] = flag; h.writeUInt32BE(data.length, 1); return Buffer.concat([h, data]); };

function start(opts = {}) {
  mgr.onDenied = opts.onPermissionDenied || null;
  mgr.start();
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type,x-grpc-web,x-user-agent,grpc-timeout,x-accept-content-transfer-encoding,x-accept-response-streaming,custom-header-1',
      'Access-Control-Expose-Headers': 'grpc-status,grpc-message', 'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const method = req.url.split('/').pop();
    const text = /text/.test(req.headers['content-type'] || '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (text) body = Buffer.from(body.toString('latin1'), 'base64');
      const fr = frames(body)[0];
      const msg = fr ? fr.data : Buffer.alloc(0);
      const ctype = text ? 'application/grpc-web-text+proto' : 'application/grpc-web+proto';
      const write = (b) => res.write(text ? Buffer.from(b.toString('base64')) : b);
      const trailer = (status, message) => write(frame(0x80, Buffer.from(`grpc-status: ${status}\r\n${message ? `grpc-message: ${message}\r\n` : ''}`)));
      res.writeHead(200, { ...cors, 'Content-Type': ctype, 'Cache-Control': 'no-cache' });
      if (unary[method]) {
        unary[method](msg).then((out) => { write(frame(0, out)); trailer(0); res.end(); })
          .catch((e) => { trailer(2, String(e.message)); res.end(); });
      } else if (streaming[method]) {
        const cleanup = streaming[method](msg, (b) => { if (!res.writableEnded) write(frame(0, b)); });
        res.on('close', () => cleanup && cleanup());
      } else { trailer(12, 'unimplemented'); res.end(); }
    });
  });
  server.on('error', (e) => console.error('[fb-driver] server error:', e.message));
  server.listen(PORT, '127.0.0.1', () => console.error('[fb-driver] listening on 127.0.0.1:' + PORT));
  return server;
}
module.exports = { start, manager: mgr };
