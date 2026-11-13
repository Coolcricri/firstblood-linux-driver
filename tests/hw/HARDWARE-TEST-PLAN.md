# Firstblood B6 (wired, 3151:4015) – hardware test plan

Goal: confirm on the real keyboard the behaviours that the README lists as "not verified" (it says the checksum position,
timing and echo rules are only exercised against the simulator). Tests were derived by reading the vendor UI bundle
(2.0.18, device class chain `iM>Hz>rw>Hx>Kx>Wx>Ux>Ox>Rx`) next to `src/linux_driver/*`.

> First real run results and corrections: see FIRST-RUN-FINDINGS.md (hypothesis H1 confirmed; harness bugs fixed).

Caveat: the harness was validated only against a simulator written from the same reading. A pass there proves the
harness logic, not the protocol. The real keyboard is the oracle.

## 1. What the code reading turned up (hypotheses the tests settle)

| # | Observation (evidence) | Risk if true | Test |
|---|---|---|---|
| H1 | Key matrix is read with `0x89 [layer, n]` x8 and the **whole 64-byte replies are concatenated into 512 bytes** (= length of the B6 default matrix). So replies cannot carry a 1-byte echo header. `hid.js read()` waits up to `READ_POLL` (400 ms) for `reply[0] == command` | every matrix read stalls 8 x 400 ms = ~3.3 s per layer (the simulator reproduces exactly this), UI feels hung on "read device" | A5, A7 |
| H2 | `FORBIDDEN_CMD` blocks only `0x7F`. The same bundle names `0x2C/0xAC` flash-chip-erase, `0x40/0x41` LED-MCU boot, `0x30/0x31` OLED boot, `0x02` reset. Confirmed on the simulator: 18 of 20 such sends (sendMsg + sendRawFeature) reach the device | a bug/malformed UI call could erase or soft-brick; the app's firmware pages are patched out, the RPC is not guarded | S1 (simulator only) |
| H3 | UI decodes vendor events from `msg.slice(1,4)` (mic = `[128,0,0]`, profile switch `a[0]==1`). Driver forwards node-hid `data` untouched | if node-hid on hidraw omits the report-ID byte, every event is off by one: mic key and layer-sync silently dead | C4 |
| H4 | B6 always uses the **full-matrix write**: 9 packets `[09,layer,F8,01,idx,0,0,chk]+56`, checksum computed by the UI, sent "no checksum". The single-key `0x13` path is dead for this device (`e2=[]`) | timing/atomicity of a 9-packet burst is the real write path | B2, B3, B4, B7 |
| H5 | Driver sleeps 8 ms **after** each send; vendor sleeps 10 ms **before** each write | marginal at high speed | B3 |
| H6 | Macros are written with `0x16` (<=5 packets) but read with `0x8B` (4 packets) | read/write asymmetry could corrupt macros | B6 |
| H7 | LED set uses **BIT8** (rgb in bytes 5-7); debounce/profile/rate/matrix-read use **BIT7**; `0x8F` driver tries BIT7 then none | wrong checksum position = command silently ignored | A3, B4, B5 |
| H8 | `interface` / `usagePage` / `usage` fields from node-hid on hidraw decide which node is "command" and "vendor"; `interface` of -1 would hide the vendor node | no vendor events, or wrong node | A1 |
| H9 | udev rule matches `KERNELS=="*:1.[12]"` and `uaccess` | no access without root, or typing interface exposed | A2, M1 |
| H10 | Settle time after layer switch, persistence over unplug, hot-plug retry loop (1 s poll) were never timed | UI reads stale layer / shows empty device after replug | B1, C5, C6 |

## 2. Safety model

* Everything is read-only until you pass `--allow-write`. Before the first write the harness reads the full state twice
  (must match), saves a **snapshot** (active layer, 3 matrices, LED, debounce, report rates, macro slot 49) and restores it
  at the end, on Ctrl-C, and on request (`--restore <snapshot>`). It then re-reads the device and tells you if anything differs.
* The harness **refuses to send** firmware-class opcodes and factory reset (hard guard in `lib/hidio.js`), whatever the test.
* Writes go to a scratch layer (default 2, `--scratch-layer`) except B2/C2 which touch all layers and restore them.
  B3 performs roughly 7 x reps matrix writes (default 28): trivial for flash, but know it.
* Macro test uses slot 49 (last slot). It writes a pattern then writes the original content back.
* C-tests type real keys (Ctrl+C, arrows, F13-F24, Vol+/-). Click an empty window first.

## 3. Automated / guided tests (run with `node hwtest.js --phase A|B|C|S|all`)

Risk: R0 read-only, R1 reversible write (auto-restored).

| ID | Ph | Risk | Confirms | Procedure | Pass criterion | If it fails |
|---|---|---|---|---|---|---|
| A1 | A | R0 | H8 | List all 3151 nodes; apply driver predicates; start the real `Manager`, compare its pick | exactly 1 command (0xFFFF/2) and 1 vendor (0xFFFF/1, iface 1) node; Manager agrees, id 910 | adjust `isWired/isVender` (drop `interface===1` or use usage only) |
| A2 | A | R0 | H9 | access(2) on every node as normal user; compare rule with bundled | iface 1,2 rw; typing iface not; rule current; not root | fix rule match (`KERNELS`/`ATTRS`), uaccess ordering |
| A3 | A | R0 | H7 | 10x `0x8F` with BIT7, none, BIT8 | BIT7 10/10 and id 910 | WARN if only "none" works: reorder `queryId` |
| A4 | A | R0 | framing | one raw `getFeatureReport(0,65)` | length 65, byte0 = 0, byte1 = 0x8F | change slice logic in `_get()` |
| A5 | A | R0 | H1 | 37 getters (core settings, 3x8 matrix packets, macro): echo at the vendor's 5 ms read, late echo time, repeat-read stability | core getters echo; WARN lists no-echo reads and estimated stall | per-opcode "no echo" list in `read()`: read once after ~5 ms like the vendor |
| A6 | A | R0 | stability | 300 mixed getters | 0 misses/wrong | raise `FB_READ_POLL_MS`, investigate hidraw timing |
| A7 | A | R0 | H1 | UI-style 3-layer read through gRPC, compare bytes to direct read, time | identical; < 1.5 s/layer | as A5 |
| A8 | A | R0 | H1/H5 | matrix read at 0,1,2,3,5,8,12 ms after send vs a reference read | 100 % at <= 8 ms | raise `FB_SEND_DELAY_MS` |
| B0 | B | R1 | H4 | header layer = scratch, active layer = another; see which layer changed (then repair) | lands in header OR active layer (reports which; real B6: ACTIVE) | all write tests must select the layer first |
| B8 | B | R1 | commit window | write a layer, switch layers N = 1500/1000/600/300 ms later, check where data ended up (auto-repairs) | safe at 1000 ms (vendor value) | lengthen waits in UI/driver paths that switch layers after a write |
| B1 | B | R1 | H10 | `0x05` to layers 1,2,0,2,0; poll `0x85` until correct | <= 100 ms PASS, <= 500 ms WARN | add post-switch wait in driver or UI path |
| B2 | B | R1 | H4 | write a unique F13-F24 matrix to each layer, read back, restore, read back | identical (504 bytes), active layer unchanged | wrong chunking / checksum / delay |
| B3 | B | R1 | H5 | write+readback with inter-packet gap 0,1,2,4,8,10,20 ms x `--reps` | 8 ms and 10 ms 100 % | raise `FB_SEND_DELAY_MS` to the reported minimum + margin |
| B4 | B | R1 | H7 | (a) matrix packets with wrong checksum; (b) LED frame with bad8/BIT7/none/BIT8, read back via `0x87`, ask you to confirm green | BIT8 applied; shows which checksums the firmware enforces | checksum position/type table wrong |
| B5 | B | R1 | H7 | debounce 4/7/10 and report-rate codes 2/4/8, read back | all read back | opcodes/offset wrong |
| B6 | B | R1 | H6 | pattern via `0x16`, read via `0x8B`, restore | identical 256 bytes | macro save/load asymmetric: capture real UI frames (M4) |
| B7 | B | R1 | H4 | same as B2/B4 but through the driver's `sendMsg` (types NONE/BIT8) | identical readback, LED applied | driver framing/checksum bug |
| C1 | C | R0 | slot map | press 6 buttons; compare evdev keys with matrix slot 0,6,12 / 1,7,13 | exact match | UI picture/slot map wrong (`patch_ui.py` key boxes) |
| C2 | C | R1 | slot map x layers | unique codes per layer, press 18 times | 18/18 match | per-layer addressing or layer switch wrong |
| C3 | C | R1 | encodings | Ctrl/Shift/Alt/Super+F13..16, Vol+/- | exact key sets (Super = KEY_LEFTMETA) | modifier byte table (`Bx`) or consumer encoding differs |
| C4 | C | R1 | H3 | map mic `[6,128,0,0]`, program1 `[6,128,0,1]`, profile+ `[8,0,1,0]`; press; read via driver `watchVender` | bytes 1..3 equal `[128,0,0] [128,0,1]`, `a[0]=1` | prepend report-ID byte in `syncVender` data handler |
| C5 | C | R1 | H10 | marker in layer 2, unplug/replug, wait for 0x8F, read back | persists; time-to-ready reported | firmware volatile, or retry timing |
| C6 | C | R0 | H10 | driver `watchDevList`: unplug/replug | events remove(2) then add(1); 0x8F works via driver on new path | Manager poll/queryId retry logic |
| S1 | S | R0 | H2 | **simulator only**: send every firmware-class opcode (0x02/0x1C/0x1E deliberately allowed) via sendMsg and sendRawFeature | all blocked | extend `FORBIDDEN_CMD` (fixed after the first run) |

## 4. Manual tests in the real AppImage (cannot be automated)

Start with `FB_DEBUG=1 ./Firstblood-Driver-linux-x86_64.AppImage 2> fb.log`, then run `node analyze-log.js fb.log`
(validates header checksums, 9-packet matrix sequences, macro sequences, firmware-class opcodes, echo-miss count).
Use `sudo evtest` (or `libinput debug-events --show-keycodes`) to watch the keys.

| ID | Test | Steps | Pass |
|---|---|---|---|
| M1 | Clean first run | fresh user, rule not installed, run AppImage | prompt appears, pkexec works, after replug keyboard shows; no root needed afterwards; also try Wayland and X11 |
| M2 | UI remap per layer | remap each of the 6 keys on layers 1-3 to F13-F18 / combos, press each | evtest matches UI; log: complete 9-packet writes, no bad checksums, **zero echo misses** (else H1) |
| M3 | Save/load configuration | save config, change keys, load it; restart app; reload from device | identical keys; no duplicate entries; time of "read device" < 2 s |
| M4 | Macro | record macro with delays, assign, press key, restart app | evtest sequence/timing as recorded; log shows `0x16` packets with `last` flag; macro survives restart (B6 shows the opcode pair works) |
| M5 | Lighting | every basic effect, speed 0-4, brightness 0-4, colour | LED matches; settings survive replug |
| M6 | Other settings | debounce slider, auto-OS toggle | value persists after restart (UI re-reads with 0x91/0x97) |
| M7 | Mic key | assign "microphone switch", press with app running; `pactl get-source-mute @DEFAULT_SOURCE@` (or `wpctl get-volume @DEFAULT_AUDIO_SOURCE@`) | toggles exactly once per press (UI debounces 500 ms), PulseAudio and PipeWire |
| M8 | Lifecycle | suspend/resume with app open; unplug during a write; start a 2nd instance; close window | recovers; device state not half-written (re-read shows complete old or new matrix); 2nd instance refuses; closing exits the driver |
| M9 | Privacy claim | while using the app: `ss -tpn | grep -i firstblood`; optionally `strace -f -e trace=connect` | only 127.0.0.1 connections |

## 5. Recommended order

1. `node hwtest.js --phase A` (read-only). Read A1-A5 before anything else: they decide whether H1/H3 are real.
2. `--phase B --allow-write` with the keyboard on its own USB port, nothing else typing.
3. `--phase C --allow-write` (needs evdev read access; C4-C6 work without it).
4. M1-M9, then `S1` on any machine: `node hwtest.js --phase S`.
5. Attach `reports/report-*.md` and `reports/report-*.json` (contains the raw A5 table); I can turn failures into driver patches.
