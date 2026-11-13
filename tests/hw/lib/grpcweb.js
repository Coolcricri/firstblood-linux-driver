'use strict';
// Minimal client for the driver's gRPC-web server (same wire format the UI uses).
const http = require('http');
const { enc, decode, first, str } = require('./src').req('pb');
const frame = (b) => { const h = Buffer.alloc(5); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
function call(port, method, msg = Buffer.alloc(0), { stream = false, onData, timeout = 20000 } = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/driver.DriverGrpc/' + method, method: 'POST', headers: { 'content-type': 'application/grpc-web+proto' } }, (rs) => {
      const ch = []; let buf = Buffer.alloc(0);
      const parse = (b) => { const out = []; let i = 0; while (i + 5 <= b.length) { const l = b.readUInt32BE(i + 1); if (i + 5 + l > b.length) break; out.push([b[i], b.slice(i + 5, i + 5 + l)]); i += 5 + l; } return [out, b.slice(i)]; };
      rs.on('data', (c) => { if (stream) { buf = Buffer.concat([buf, c]); const [fr, rest] = parse(buf); buf = rest; fr.forEach((f) => onData && onData(f[1])); } else ch.push(c); });
      rs.on('end', () => res(parse(Buffer.concat(ch))[0]));
    }); req.on('error', (e) => { if (!stream) rej(e); }); if (!stream) req.setTimeout(timeout, () => req.destroy(new Error('timeout'))); req.end(frame(msg)); if (stream) res({ close: () => req.destroy() });
  });
}
const Q = require('./quiet');
const sendMsg = async (port, p, m, t) => { await Q.before(m[0]); Q.note(m[0], m[1], 'driver'); return sendMsg0(port, p, m, t); };
const sendMsg0 = (port, p, m, t) => call(port, 'sendMsg', Buffer.concat([enc.str(1, p), enc.bytes(2, m), enc.uint(3, t)])).then((o) => (o[0] && o[0][1].length ? str(decode(o[0][1]), 1) : ''));
const readMsg = (port, p) => call(port, 'readMsg', enc.str(1, p)).then((o) => Buffer.from(first(decode(o[0][1]), 2) || Buffer.alloc(0)));
module.exports = { call, sendMsg, readMsg, enc, decode, first, str };
