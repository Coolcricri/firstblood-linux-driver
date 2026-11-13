# Hardware test harness (Firstblood B6)

Run from `tests/hw/` inside the source tree (it imports `../../src/linux_driver/*`). See HARDWARE-TEST-PLAN.md for the design.

    npm install node-hid@3.4.0        # once (or point FB_HID_MODULE at an existing node-hid)
    node hwtest.js --phase A          # read-only
    node hwtest.js --phase B --allow-write
    node hwtest.js --phase C --allow-write
    node hwtest.js --phase S          # simulator-only safety check, never touches hardware
    node hwtest.js --restore reports/snapshot-<n>.json

Options: `--only A5,B3`  `--reps N` (B3, default 4)  `--scratch-layer 0|1|2` (default 2)  `--port` (driver port, default 38142)
`--no-evdev`  `--no-visual` (skip LED y/n question)  `--out DIR`.

The harness finds the driver source automatically when it sits in `tests/hw/`; elsewhere pass `--src <firstblood-linux>/src` (or `FB_SRC`). Without it, driver-based tests (A1 cross-check, A7, B7, C4, C6, S1) SKIP.
`node hwtest.js --probe-writes` measures which layer a write lands in (single-slot markers, then restores and verifies). Matrix writes wait the vendor's 1000 ms (BIGCMDDELAY) and are verified.
`node hwtest.js --check <snapshot>` lists differences between the keyboard and a snapshot; `--restore <snapshot>` repairs it. NOTE: the device writes the matrix to the ACTIVE layer; the harness selects the layer first.

Safety rule: non-read commands wait `FB_QUIET_MS` (default 3500 ms) after the last matrix write (see FIRST-RUN-FINDINGS.md section 8). On a device drop the last commands are printed and saved to `reports/lost-commands-*.txt`.
Phase X (`--phase X --allow-write --risky`) holds isolating experiments for the B7 crash (see FIRST-RUN-FINDINGS.md section 9). `FB_DEBUG=2` adds timestamps to the driver log.
`--risky` enables B8 (switches layers inside the commit window; it made a real B6 drop off USB). Snapshots are also kept in `~/.local/share/firstblood-hwtests/`.

Requirements: Linux, node >= 16, run as your normal user, keyboard connected by USB cable, close the AppImage first
(it is not required, but avoids two programs talking to the keyboard). C1-C3 need read access to the keyboard's
`/dev/input/event*` nodes (the harness prints them if denied), for example `sudo setfacl -m u:$USER:r /dev/input/event12`.

Self-test without hardware: `FB_HID_MODULE=$PWD/sim/node-hid.js node hwtest.js --phase all --allow-write --reps 3`
(SIM_QUIRKS=comma list injects faults: nochk dropfast nonatomic slowprofile slowreply volatile echomatrix ifaceminus1 novendorid swapwire noledbit8).

Manual app tests: `FB_DEBUG=1 <AppImage> 2> fb.log` then `node analyze-log.js fb.log`.
