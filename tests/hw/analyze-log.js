#!/usr/bin/env node
'use strict';
// Usage: FB_DEBUG=1 ./Firstblood-Driver-*.AppImage 2> fb.log   (do the manual app tests)   then:   node analyze-log.js fb.log
// Checks what the REAL UI sent through the driver: opcodes, header checksums, packet sequences, echo misses, firmware-class opcodes.
const fs = require('fs'), P = require('./lib/proto');
const lines = fs.readFileSync(process.argv[2] || '/dev/stdin', 'utf8').split('\n');
const tx = [], txt = [], miss = [], hist = {}; let rx = 0;
for (const l of lines) {
  let m = /\[fb-driver\] (?:@(\d+) )?TX(raw)? ((?:[0-9a-f]{2} ?)+)/.exec(l); if (m) { const b = Buffer.from(m[3].replace(/ /g, ''), 'hex'); tx.push(m[2] ? b.slice(1) : b); txt.push(m[1] === undefined ? null : Number(m[1])); continue; }
  if (/\[fb-driver\] RX/.test(l)) rx++; if (/no echo of cmd/.test(l)) miss.push(l.replace('[fb-driver] ', ''));
}
const bad = [], seq = {}; let fw = 0;
for (const b of tx) {
  const op = b[0]; hist['0x' + op.toString(16)] = (hist['0x' + op.toString(16)] || 0) + 1;
  if (P.FIRMWARE_CLASS.has(op) || op === 2) { fw++; bad.push(`FIRMWARE-CLASS/RESET opcode 0x${op.toString(16)} was sent: ${P.hex(b, 12)}`); }
  if ([0x04, 0x05, 0x09, 0x11, 0x16].includes(op) || (op >= 0x80 && b.length >= 8)) { let s = 0; for (let i = 0; i < 7; i++) s += b[i]; if (b[7] !== ((~s) & 255) && op !== 0x07) bad.push(`bad BIT7 checksum on 0x${op.toString(16)}: ${P.hex(b, 10)}`); }
  if (op === 0x07) { let s = 0; for (let i = 0; i < 8; i++) s += b[i]; if (b[8] !== ((~s) & 255)) bad.push(`bad BIT8 checksum on LED frame: ${P.hex(b, 10)}`); }
  if (op === 0x09) (seq.matrix = seq.matrix || []).push(b[4] + '@L' + b[1]); if (op === 0x16) (seq.macro = seq.macro || []).push(`slot${b[1]}#${b[2]}${b[4] ? 'last' : ''}`);
}
console.log('frames sent:', tx.length, ' replies read:', rx, '\nopcode histogram:', JSON.stringify(hist));
for (const [k, v] of Object.entries(seq)) console.log(k, 'packet sequence:', v.join(' '));
if (seq.matrix) { const runs = seq.matrix.join(' ').split(/(?<=8@L\d) /); runs.forEach((r) => { const idx = r.split(' ').map((x) => parseInt(x)); if (idx.join() !== [0, 1, 2, 3, 4, 5, 6, 7, 8].join()) bad.push('incomplete/out-of-order matrix write: ' + r); }); }
if (txt.some((x) => x !== null)) { // packet pacing inside each 9-packet matrix write
  let prev = null, i0 = -1; const gaps = []; tx.forEach((b, i) => { if (b[0] === 0x09 && txt[i] !== null) { if (prev !== null && i === i0 + 1) gaps.push(txt[i] - prev); prev = txt[i]; i0 = i; } });
  if (gaps.length) console.log(`matrix packet gaps: min ${Math.min(...gaps)} ms, max ${Math.max(...gaps)} ms, >40 ms: ${gaps.filter((g) => g > 40).length} of ${gaps.length}  (B3 verified 0-20 ms; 70/110 ms gaps preceded a keyboard drop in B7)`);
}
console.log('echo misses (driver waited READ_POLL):', miss.length); miss.slice(0, 5).forEach((m) => console.log('   ', m));
console.log(bad.length ? 'PROBLEMS:\n  ' + bad.join('\n  ') : 'no checksum / sequence / firmware-class problems found'); process.exit(bad.length || fw ? 1 : 0);
