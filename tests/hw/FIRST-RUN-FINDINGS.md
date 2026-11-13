# First real-hardware run: findings (Fedora 45 ogc 7.2.15, node 26.7, B6 3151:4015)

## 0. URGENT: your keyboard layout was altered by my harness; how to repair

The first version of the harness assumed a matrix write goes to the layer named in the packet header. The hardware showed
the **device writes to whichever layer is active** (B0 in the new version proves it directly). So B2's "restore" step wrote
layer 0's and layer 2's original content into layer 1 (the active one), and the final auto-restore could not repair it
because it had the same flaw. Result: **layer 1 currently holds layer 2's mapping** (the second snapshot shows this), and
the C-run (which also wrote while layer 1 was active) may have left further changes. Layers 0 and 2 were never hit.

Your original state is `reports/snapshot-1794223205236.json` (taken before the first write). Do NOT use
`snapshot-1794223636641.json`; it was taken after the damage. Using the fixed tool in this package:

    node hwtest.js --check   reports/snapshot-1794223205236.json    # lists every slot that differs
    node hwtest.js --restore reports/snapshot-1794223205236.json    # selects each layer, writes it, verifies
    node hwtest.js --check   reports/snapshot-1794223205236.json    # should say: identical

Expected original mapping (slot order = top-left, top-middle, top-right, bottom-left, bottom-middle, bottom-right):
layer 0: X, Up, Z, Left, Down, Right; layer 1: Esc, Up, Enter, Left, Down, Right; layer 2: LShift, W, Enter, A, S, D.
LED baseline read back: `87 0d 04 00 00 00 c8 c8` (mode 13 = "user picture"). The restore also rewrites LED, debounce (1),
report rate (1000 Hz) and macro slot 49 from the snapshot. Your real macros (e.g. slot 0) were only ever read.

## 1. Results, sorted by what they mean

| Finding | Evidence | Status |
|---|---|---|
| Matrix (0x89) and macro (0x8B) replies carry **no echo**; all 9 other getters echo | A5: 28/28 never echo; every core getter echoes at the vendor 5 ms read | **confirmed; driver patched** (the unpatched driver would stall ~11 s for a 3-layer read) |
| Reading 5 ms after the send is enough; reads are stable; 300-read soak clean | A5, A6, B2 layer-1 readback | confirmed (A8 in the new version measures the exact floor) |
| Device ID 0x8F answers 910 with BIT7, none and BIT8 alike, framing is 65 bytes with leading 0 | A3, A4 | confirmed |
| Macro write via 0x16 / read via 0x8B round-trips identically | B6 | confirmed |
| Debounce and report-rate set/readback | B5 | confirmed |
| Layer switch takes up to ~218 ms to be reported | B1 | measured: the UI must wait ~250-300 ms before relying on the new layer |
| Physical map: top row = slots 0,6,12 and bottom row = 1,7,13, matching the UI picture | terminal echo during C1/C2: X, Up, Z, Left, Down, Right on layer 0; W, Enter, A, S, D on layer 2; first button also matched via evdev | confirmed (my key observer missed most events, see below) |
| Layer switching changes the output | C2 layer 0 vs layer 2 echoes | confirmed |
| **Matrix writes apply to the active layer, ignoring the header layer byte** | B2 pattern + final snapshot (layer 1 = layer 2) fits exactly | confirmed by inference; B0 tests it directly. The vendor UI only writes the active layer, so the app is unaffected |
| LED mode on your board is 13 (user picture); my test wrote mode 1 and register readback worked but no green light | B4 | **inconclusive**: my frame guessed the colour layout. New B4 only changes one colour byte in the current mode; visual LED check moved to manual M5 |
| Typing interface is also user-accessible | A2 | benign on this distro (uaccess for hidraw); not a bug in the rule |

## 2. Results that were invalid (harness/environment, not the driver or keyboard)

* A1, A7, B7, C4, C6, S1 failed with "Cannot find module ../../src/linux_driver/...": the harness was unpacked outside the source
  tree. It now finds the source via `--src DIR`, `FB_SRC` or autodetection, and reports SKIP instead of FAIL.
* B3 (0/N at every gap) and C5 ("not persistent"): consequences of the wrong-layer write. Neither says anything about timing or persistence.
* C1-C3 "saw nothing": the evdev reader (stream-based) delivered events late (a Super+F16 press appeared one step later).
  It is rewritten as a non-blocking poller, and typed keys no longer echo into the terminal.

## 3. Changes shipped

* Driver: `hid.js` skips echo-polling for 0x89/0x8B (extend with `FB_NO_ECHO_CMDS=hex,hex`); `driver.js` also blocks
  0x2C 0xAC 0x40 0x41 0x30 0x31 (`FB_ALLOW_FIRMWARE=1` lifts it). 0x02/0x1C/0x1E stay allowed because other device classes in the
  bundle use those numbers for ordinary commands. Patch: `firstblood-driver-fixes.patch`; regression test `tests/readpath_test.js`
  (fails on the old driver with a 3.3 s stall, passes at ~100 ms).
* Harness: write-to-active-layer handling everywhere, B0 and A8 added, `--check`/`--restore` with a readable diff, safer post-run restore.

## 4. Next run (after the repair in section 0)

    node hwtest.js --phase A                      # now includes A1, A7 (driver path) and A8
    node hwtest.js --phase B --allow-write        # B0 first; B3/B4/B7 are now meaningful
    node hwtest.js --phase C --allow-write        # C1-C6; if evdev is denied: sudo setfacl -m u:$USER:r /dev/input/eventN
    node hwtest.js --phase S                      # simulator-only, now expects PASS with the patched driver
Apply the driver patch first (`patch -p1 < firstblood-driver-fixes.patch` in the source root) so A7 measures the fixed read path.

## 5. Update: the first `--restore` only half worked (what happened, what changed)

After the first restore: layer 0 was repaired, but layer 1 stayed at the factory default and layer 2 received layer 1's data.
So writes made right after a layer switch did not all land where intended. I tried several simple device models (working
copy + flush on switch, delayed commit, etc.); **none reproduces all your observations, so the exact mechanism is still unknown.**

What the vendor code does show: after the 9th packet the UI waits `BIGCMDDELAY` = **1000 ms** (500 ms for ordinary commands). My
restore waited 300 ms before selecting the next layer, which is a plausible cause (a commit still in flight when the layer switches),
but that is a hypothesis, not a result.

Changes in this version:
* every matrix write now selects the layer, waits >= 1000 ms (1500 ms in restore) and is read back;
* `--restore` only rewrites layers that differ, verifies each, retries (3 passes), and tells you plainly if it could not fix it;
* new test **B8**: how long after the last packet a layer switch is safe (writes, auto-repairs);
* new command **`node hwtest.js --probe-writes`**: eight controlled single-slot writes (active layer x header layer x wait) that
  reports which layer each write lands in, then restores the starting state and verifies it. It saves `reports/probe-*.json`.

If `--restore` still reports differences, run `--probe-writes` and send me its output. You can also finish the repair by hand in the
app: layer 1 slot top-left = Esc, top-right = Enter; layer 2 = LShift, W, Enter / A, S, D (top row, then bottom row).

## 6. Second hardware run: phase A all good; B8 made the keyboard drop off USB

* **Phase A on real hardware: all PASS** (A2 WARN only because this distro gives the typing interface a user ACL).
  **A7: a 3-layer read through the driver takes 95 ms worst case** (3.3 s before the no-echo fix). A8: reads are correct immediately after the send.
* B0 passed (writes follow the active layer). **B8 then failed with "Protocol error" and every later command with "No such device":
  the keyboard dropped off the bus.** B8 intentionally switches layers 600 ms and 300 ms after a matrix write, i.e. inside the vendor's
  1000 ms window. That was an unsafe test to include by default. The keyboard then restarted with a default (cycling colour) LED effect.
  The snapshot taken just before the run was identical to your original state, so the key layout and LED registers were correct beforehand.
* Changes: **B8 is now skipped unless `--risky`** (do not use it on your own keyboard unless you want to reproduce the reset);
  any "device lost" error aborts the run, waits up to 90 s for the keyboard, verifies and restores; snapshots are also saved in
  `~/.local/share/firstblood-hwtests/` so `--check/--restore <name>` works from any copy of the harness.
* Still untested on real hardware with the fixed harness: B1-B7 (B4 and B7 write the LED), C1-C6.

## 7. Third hardware run (B1, B2)

* **B1 WARN (informational):** layer switch reported as settled after 16 ms for three switches and ~220 ms for the other two (matches the
  earlier 218 ms). Worst case ~220 ms, the vendor UI waits 500 ms. Nothing to fix in the driver.
* **B2 FAIL, but the final state was identical to the snapshot.** Layers 0 and 1 round-tripped; on layer 2 both the new pattern and
  the restore were *not yet visible* when read 1000 ms after the last packet, yet the device was correct a few seconds later.
  The most likely explanation: **layer 2's commit takes longer than the vendor UI's 1000 ms wait** (not a lost write).
  Consequence if true: a UI that reloads the device right after saving layer 2 could show stale keys.
* Changes: matrix writes now poll until the data is visible (up to 8 s) and report the commit time instead of using a fixed delay;
  B2 reports per-layer commit times (WARN above 1000 ms); **new B9** measures commit latency per layer (4 alternating writes each, never switching layers while waiting).
  Run B9 first, then B2.

## 8. Fourth hardware run (B9, B2, B5, B6, B3, B4, B7)

Confirmed on the real keyboard:
* **B9: a matrix write takes ~1.8 s (layers 0, 1) and ~2.2 s (layer 2) before it is readable**; the vendor UI waits 1.0 s. B2 agrees.
* **B3: packet gaps of 0-20 ms all work** (the driver's 8 ms is fine). **B4: the firmware validates matrix-packet checksums**
  (a wrong checksum is ignored); the LED command is accepted with BIT8 and ignored with a bad or missing checksum; with the BIT7 position
  it corrupted the blue byte (13,4,0,0,0,100,131), so the BIT8 handling in the driver is right.
* **B5, B6 pass** (debounce, report rate, macro write 0x16 / read 0x8B round trip).

**B7 made the keyboard drop off USB and it came back with a factory-default configuration**: all layers default, profile 0, LED mode 3
(the "rainbow"). The harness restored everything from the snapshot ("restored OK"). B7 had sent a guessed LED frame
(mode 1) about 2.4 s after a real matrix commit. Together with B8 (layer switch inside the commit window) that is two config wipes.
**Hypothesis (not proven): a non-matrix command sent within roughly 3 s after a matrix commit can crash the firmware.** In every passing test
only matrix writes or layer switches followed a commit that quickly, and B4 never raced a real commit (its bad-checksum write was ignored).

Changes: `lib/quiet.js` makes the harness wait **3.5 s (FB_QUIET_MS)** after the last matrix packet before sending any non-read command;
B7 is now matrix-only and B7b tests the LED path through the driver using the same safe same-mode tweak as B4; every drop prints and saves
the last 25 commands with timings (`reports/lost-commands-*.txt`). Product note: the vendor UI waits only 1 s after saving keys and then
usually sends nothing LED-related (`startLight` only acts in music-follow mode), but the driver does not enforce any quiet period. If the
hypothesis holds, a UI sequence that sends a layer/LED command 1-3 s after a save could wipe the keyboard. Test it in the app (M2), not in the harness.

## 9. Fifth hardware run: B7 dropped the keyboard again (hypothesis in section 8 refuted)

`lost-commands-*.txt` shows what preceded the drop: SET_PROFILE 2, then **nine matrix packets sent by the driver with gaps of 70 ms and 110 ms
(then 10 ms)**, then two read-backs about 0.2-0.3 s later, then the drop. **No LED command was involved**, so the "LED too soon after a commit"
theory from section 8 is wrong. B7 has now dropped the keyboard 2 of 2 times, while the same layout written through the harness's own
direct path succeeded 40+ times in B2/B3/B9 (uniform gaps of 0-20 ms, B3). Differences of the failing path: (a) uneven packet gaps (the first
HTTP requests of the test client are slow), (b) packets written through the driver's own device handle, (c) the driver's 1 Hz polling running.
The cause is **not yet known**. Pacing is my best guess, nothing more.

Experiments (each changes one thing; all need `--risky`; a drop auto-restores and stops the run). Run in this order and STOP at the first drop:
1. `X1` the failing B7's exact 9 packets with its 10/70/110 ms gaps written directly. A drop here means the firmware cannot tolerate pauses inside a layout write.
2. `X2` the driver's own `Dev.send` write path without HTTP or polling, uniform pacing.
3. `X3` the driver running (polling) while the layout is written directly.
`B7`/`B7b` are now skipped unless `--risky`. New: `FB_DEBUG=2` makes the driver prefix log lines with a millisecond timestamp and
`node analyze-log.js fb.log` reports the packet gaps of every matrix write the real app performs, so the app's own pacing can be checked
without risking the keyboard.
