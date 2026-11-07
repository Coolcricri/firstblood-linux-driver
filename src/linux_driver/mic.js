'use strict';
// Microphone mute for the keyboard's "microphone" key, via PulseAudio/PipeWire (pactl) or WirePlumber (wpctl).
const { execFile } = require('child_process');
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
  (e, so) => res({ ok: !e, out: String(so || ''), missing: !!(e && e.code === 'ENOENT') })));

async function getMute() {
  let r = await run('pactl', ['get-source-mute', '@DEFAULT_SOURCE@']);
  if (r.ok) return /:\s*yes/i.test(r.out);
  r = await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@']);
  if (r.ok) return /\[MUTED\]/i.test(r.out);
  throw new Error('no microphone found (pactl/wpctl not available or no default input device)');
}
// mode: 'toggle' | true | false
async function setMute(mode) {
  const v = mode === 'toggle' ? 'toggle' : mode ? '1' : '0';
  let r = await run('pactl', ['set-source-mute', '@DEFAULT_SOURCE@', v]);
  if (r.ok) return;
  r = await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', v]);
  if (!r.ok) throw new Error('could not change the microphone (pactl/wpctl failed or no default input device)');
}
module.exports = { getMute, setMute };
