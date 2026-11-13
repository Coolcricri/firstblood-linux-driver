'use strict';
// Matrix entry [type,b1,b2,b3] -> Linux evdev key codes expected while the key is held.
const LETTER = { A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44 };
const FIXED = { 79: 106, 80: 105, 81: 108, 82: 103, 40: 28, 41: 1, 42: 14, 43: 15, 44: 57, 68: 87, 69: 88,
  224: 29, 225: 42, 226: 56, 227: 125, 228: 97, 229: 54, 230: 100, 231: 126 };
function hidToLinux(u) {
  if (u >= 4 && u <= 29) return LETTER[String.fromCharCode(61 + u)];
  if (u >= 30 && u <= 38) return u - 28;
  if (u === 39) return 11;
  if (u >= 58 && u <= 67) return u + 1;
  if (u >= 104 && u <= 115) return 183 + (u - 104);   // F13..F24
  return FIXED[u];
}
const CONSUMER = { 0xe9: 115, 0xea: 114, 0xe2: 113, 0xcd: 164, 0xb5: 163, 0xb6: 165, 0xb7: 166, 0x192: 140, 0x6f: 225, 0x70: 224 };
const NAMES = { 29: 'LCtrl', 42: 'LShift', 56: 'LAlt', 125: 'LMeta', 46: 'C', 47: 'V', 103: 'Up', 108: 'Down', 105: 'Left', 106: 'Right', 115: 'VolUp', 114: 'VolDown' };
for (let i = 0; i < 12; i++) NAMES[183 + i] = 'F' + (13 + i);
const name = (c) => NAMES[c] || 'KEY_' + c;
function entryToKeys(e) {
  const [t, b1, b2, b3] = e;
  if (t === 0) { const l = [b1, b2, b3].filter((x) => x).map(hidToLinux); return l.length && l.every((x) => x !== undefined) ? [...new Set(l)].sort((a, b) => a - b) : null; }
  if (t === 3) { const c = CONSUMER[b2 | (b3 << 8)]; return c ? [c] : null; }
  return null;
}
module.exports = { hidToLinux, entryToKeys, name, names: (a) => (a || []).map(name).join('+') };
