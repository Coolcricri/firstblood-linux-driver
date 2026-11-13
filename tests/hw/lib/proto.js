'use strict';
// Independent statement of the B6 protocol, taken from the vendor UI bundle (2.0.18; class chain
// iM > Hz > rw > Hx > Kx > Wx > Ux > Ox > Rx). Deliberately NOT built on src/linux_driver/*, so tests can disagree with the driver.
const OP = {
  GET_REV: 0x80, GET_INFO: 0x8f,
  SET_REPORT: 0x04, GET_REPORT: 0x84,        // [op, profile, code]  1=1000Hz 2=500 4=250 8=125
  SET_PROFILE: 0x05, GET_PROFILE: 0x85,      // [op, profile]; reply[1] = active layer
  GET_KBOPTION: 0x86,                        // [op, profile]; reply[2..4] option bytes
  SET_LED: 0x07, GET_LED: 0x87,              // [op, mode, 4-speed, value, n, r, g, b]; SET uses BIT8
  SET_KEYMATRIX: 0x09, GET_KEYMATRIX: 0x89,  // set: 9 packets [09,prof,F8,01,idx,0,0,chk]+56; get: [89,prof,idx] x8
  SET_DEBOUNCE: 0x11, GET_DEBOUNCE: 0x91,    // [op, 0, value]; reply[2]
  GET_SLEEP: 0x92, GET_AUTOOS: 0x97,
  SET_MACRO: 0x16, GET_MACRO: 0x8b,          // set [16,slot,pkt,56,last,0,0,chk]+56 (<=5); get [8b,slot,r] x4
};
// Firmware-class opcodes named in the vendor bundle. The harness refuses to send ANY of these.
const FIRMWARE_CLASS = new Map([[0x7f, 'enter bootloader'], [0x2c, 'flash chip erase'], [0xac, 'flash chip erase'],
  [0x40, 'LED-MCU bootloader'], [0x41, 'LED-MCU boot start'], [0x30, 'OLED bootloader'], [0x31, 'OLED boot start'],
  [0x1c, 'magnetism calibration'], [0x1e, 'magnetism max calibration']]);
const FACTORY_RESET = 0x02;                  // never sent by this harness
const MATRIX_BYTES = 512, MATRIX_PKTS = 8, WRITE_PKTS = 9, WRITE_PAYLOAD = 56, MACRO_SLOT = 49;
const DEVICE_ID = 910, VID = 0x3151, PID = 0x4015;
const DEFAULT_SLOTS = { 0: [0, 0, 224, 6], 1: [0, 0, 80, 0], 5: [14, 1, 0, 0], 6: [0, 0, 82, 0], 7: [0, 0, 81, 0],
  12: [0, 0, 224, 25], 13: [0, 0, 79, 0], 17: [0, 0, 224, 25], 18: [13, 1, 0, 0] };
// Layout as drawn by the UI (patch_ui.py): top row copy/up/paste, bottom row left/down/right.
const PHYS = [{ name: 'top-left', label: 'copy', slot: 0 }, { name: 'top-middle', label: 'up', slot: 6 }, { name: 'top-right', label: 'paste', slot: 12 },
  { name: 'bottom-left', label: 'left', slot: 1 }, { name: 'bottom-middle', label: 'down', slot: 7 }, { name: 'bottom-right', label: 'right', slot: 13 }];
const KEY_SLOTS = PHYS.map((p) => p.slot);
const defaultMatrix = () => { const m = Buffer.alloc(MATRIX_BYTES); for (const [s, e] of Object.entries(DEFAULT_SLOTS)) Buffer.from(e).copy(m, s * 4); return m; };
const entryAt = (m, slot) => [...m.slice(slot * 4, slot * 4 + 4)];
const setEntry = (m, slot, e) => { const c = Buffer.from(m); Buffer.from(e).copy(c, slot * 4); return c; };

// 'bit7' byte7=~sum(0..6) | 'bit8' byte8=~sum(0..7) | 'none' | 'bad7'/'bad8' (deliberately wrong)
function frame(bytes, chk = 'none') {
  const b = Buffer.alloc(64); Buffer.from(bytes).copy(b, 0, 0, 64);
  const n = /7$/.test(chk) ? 7 : /8$/.test(chk) ? 8 : 0;
  if (n) { let s = 0; for (let i = 0; i < n; i++) s += b[i]; b[n] = (~s) & 0xff; if (chk.startsWith('bad')) b[n] ^= 0x5a; }
  return b;
}
// vendor rw._setKeyConfig: 9 packets, header checksum computed by the UI itself, sent with "no checksum"
function matrixPackets(profile, matrix, chk = 'ok') {
  const out = [];
  for (let r = 0; r < WRITE_PKTS; r++) {
    const head = [OP.SET_KEYMATRIX, profile, 248, 1, r, 0, 0, 0]; let s = 0; for (let i = 0; i < 7; i++) s += head[i];
    head[7] = (255 - (s & 255)) & 255; if (chk === 'bad') head[7] ^= 0x5a;
    const data = Array.from(matrix.slice(r * WRITE_PAYLOAD, (r + 1) * WRITE_PAYLOAD)); while (data.length < WRITE_PAYLOAD) data.push(0);
    out.push(Buffer.from(head.concat(data)));
  }
  return out;
}
// vendor Hz._setMacro: one packet per non-empty 56-byte slice (>=1 here so a clear is possible)
function macroPackets(slot, bytes256, minPkts = 1) {
  const sl = []; for (let l = 0; l < 5; l++) { const d = Array.from(bytes256.slice(l * 56, l * 56 + 56)); while (d.length < 56) d.push(0); sl.push(d); }
  const used = Math.max(minPkts, sl.filter((s) => s.some((x) => x)).length);
  return sl.slice(0, used).map((d, n) => frame([OP.SET_MACRO, slot, n, 56, n === used - 1 ? 1 : 0, 0, 0, 0].concat(d), 'bit7'));
}
const hex = (b, n = 16) => Buffer.from(b).slice(0, n).toString('hex').replace(/(..)/g, '$1 ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { OP, FIRMWARE_CLASS, FACTORY_RESET, MATRIX_BYTES, MATRIX_PKTS, WRITE_PKTS, WRITE_PAYLOAD, MACRO_SLOT, DEVICE_ID, VID, PID,
  DEFAULT_SLOTS, PHYS, KEY_SLOTS, defaultMatrix, entryAt, setEntry, frame, matrixPackets, macroPackets, hex, sleep };
