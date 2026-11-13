# Firstblood Driver, Linux edition (B6, wired)

> [!WARNING]
> ## AI usage disclaimer and general project stability
>
> Virtually all of the code was generate over a few weeks by Claude, then running hardware tests on my own device to make sure it does not low it up.
>
> This is a niche enough project that I do not care for its quality (it keeps eating my macros), but it lets me change keys without opening up a Windows VM.

A Linux AppImage of the Firstblood configuration app for the **B6 6-button programmable pad** (wired, USB `3151:4015`):
key remapping on 3 layers, macros, saved configurations, basic lighting, key sensitivity. Built from the vendor's macOS UI (2.0.18)
plus a Linux replacement for the vendor's native helper (`iot_driver`), which only exists for Windows and macOS.

## Build

```
./build.sh --mac-image /path/to/Firstblood_Driver_2_0_18_mac.zip
```
Result: `out/Firstblood-Driver-linux-x86_64.AppImage`. A few minutes (the Electron download is ~90 MB; packing is CPU-bound).

* **Needs:** bash, curl, python3, node >= 16 + npm, sha256sum, and network access to github.com and registry.npmjs.org.
  **No compiler, no `unzip`, no 7z, no root.**
* **You must supply** the vendor's macOS image:(https://orders.epomaker.com/software/Firstblood_Driver_2.0.18_mac.zip) the zip that contains `Firstblood_Driver_2.0.18_mac.dmg`, or the `.dmg` itself. It is
  proprietary and therefore **not** in this tree. `versions.env` pins the SHA-256 of the disk image and of the files inside it; the build
  stops if they differ (`--force` overrides). The `.dmg` is read directly by `tools/dmg_extract.py` (Python standard library; HFS+).
* Convention: keep the vendor file in `inputs/` (its checksums are in `inputs/SHA256SUMS`; check with `sha256sum -c`).
* Options: `--out DIR`, `--work DIR`, `--cache DIR` (downloads), `--skip-tests`, `--force`. (`--mac-zip` still works as an alias of `--mac-image`.)
* Everything downloaded is pinned in `versions.env` (Electron 22.3.27, node-hid 3.4.0, sql.js 1.10.3, @electron/asar 4.3.1).
  appimagetool is a rolling upstream release: a changed hash only warns.
* If appimagetool fails, its output is in `work/appimagetool.log` (the last lines are printed).
* The AppImage is not bit-for-bit reproducible (timestamps) but its contents are: extracting two builds and running `diff -r` shows no differences.

## What the build does

1. takes the `.dmg` (out of the zip if needed) and verifies it
2. installs `node-hid` (hidraw prebuild only), `sql.js` and `@electron/asar` from npm
3. reads `app.asar` and the unpacked part of the app out of the disk image (`tools/dmg_extract.py`) and unpacks it (`tools/extract-asar.mjs`)
4. adds Electron 22.3.27 (`tools/unzip.py`)
5. **pictures:** keeps the vendor's `company/company_Firstblood`, then lays `src/company/company_Firstblood/` over it (see "Pictures")
6. copies `src/linux_main.js`, `src/ui-fixes.css`, `src/linux_driver/*`
7. runs `src/patch_ui.py` on the pristine UI bundle. Every patch must match exactly once or the build fails. Patches: no tray; closing always
   exits; no Share / My Account / login / update / firmware features; no analytics; basic Light page only; no wireless settings; no Appearance;
   no start-at-login; Windows-only helpers neutralised; B6 key boxes aligned to the picture; duplicate-configuration fix
8. runs `tests/`, then appimagetool

## Source layout

| path | purpose |
|---|---|
| `src/linux_driver/driver.js` | gRPC-web server on 127.0.0.1:3814 implementing the vendor helper's API (device list, send/read, vendor events, key/value store, microphone) |
| `src/linux_driver/hid.js` | device discovery and hidraw feature reports (via node-hid); B6 only |
| `src/linux_driver/checksum.js` | the keyboard's checksum rules |
| `src/linux_driver/kv.js` | key/value store, backups, protection against stale writes |
| `src/linux_driver/tools.js` | CLI tools: Windows data import, backups, de-duplication, device-cache reset, udev install; writable `CONFIG.json` overlay |
| `src/linux_driver/mic.js` | microphone mute via pactl / wpctl |
| `src/linux_driver/pb.js` | minimal protobuf encoder/decoder |
| `src/linux_main.js` | entry point: flags, startup safety net, writable-config overlay, privacy switches, driver start |
| `src/patch_ui.py` | the UI patches (see above) |
| `src/ui-fixes.css` | injected CSS (makes the whole Configuration selector clickable) |
| `src/AppRun`, `src/*.desktop`, `src/70-firstblood.rules` | AppImage launcher, desktop entry, udev rule |
| `src/company/company_Firstblood/` | logos, icon, device pictures (1.6 MB) + our `CONFIG.json`; mirrors `resources/app/company/` in the app |
| `tools/` | build helpers: `dmg_extract.py` (read the vendor .dmg), `unzip.py`, `strip_png.py`, `extract-asar.mjs` |
| `tests/` | `run-tests.sh`: automated tests, no hardware needed (simulated B6) |
| `tests/hw/` | hardware verification harness for a real B6 (read `tests/hw/README.md` and `FIRST-RUN-FINDINGS.md` first: some tests write to the keyboard) |

## Protocol facts the driver relies on (reverse-engineered; the ones marked "measured" were confirmed on a real B6, see `tests/hw/FIRST-RUN-FINDINGS.md`)

* Command interface: vendor usage page `0xFFFF`, usage 2, interface 2 of `3151:4015`. Vendor events: interface 1.
* Each message is a 64-byte HID **feature report**, report ID 0 (hidraw: 65 bytes with a leading 0). (measured)
* Checksum "BIT7": `byte7 = ~sum(bytes 0..6)`; "BIT8": `byte8 = ~sum(bytes 0..7)`; both on the zero-padded 64-byte buffer. The firmware ignores
  key-matrix packets and LED commands with a wrong checksum. (measured)
* Device identity: send `0x8F`; the reply echoes `0x8F` in byte 0 and bytes 1..4 are the little-endian device id (910 for the B6). (measured)
* **Most getters echo the command byte** and the driver waits for that echo. **Key-matrix (`0x89`) and macro (`0x8B`) reads do not echo**: their
  replies are raw data, so the driver reads them once (`NO_ECHO` in `hid.js`, `FB_NO_ECHO_CMDS` adds opcodes). (measured)
* A key-matrix write is 9 packets; the keyboard applies it to the **active layer** and needs about 2 s before the new data can be read back
  (the vendor UI waits 1 s). Keep other commands away for several seconds after a write. (measured; sending commands too early is the
  prime suspect in two cases where the keyboard dropped off USB and reset to factory defaults)
* Firmware-class commands (`0x7F 0x2C 0xAC 0x40 0x41 0x30 0x31`) are refused unless `FB_ALLOW_FIRMWARE=1`.

## Runtime behaviour worth knowing

* **Privacy:** no analytics; the app blocks every request except to its own local driver, and Chromium's background networking is off.
* **Data:** `~/.config/firstblood-driver/` (`iot_db/CONFIG`, `iot_db/macro`, `config/`, `backups/`). A snapshot is taken at every start
  (newest 25 kept); lists that shrink are backed up first; exact duplicate configurations are removed at start.
* **Permissions:** the app offers to install `/etc/udev/rules.d/70-firstblood.rules` the first time it cannot open the keyboard.
* Flags: run the AppImage with `--help`.
* Debugging: `FB_DEBUG=1` logs every byte sent and received; `FB_SEND_DELAY_MS`, `FB_READ_POLL_MS` tune timing.

## Pictures

The vendor image already carries the whole `company/company_Firstblood` folder (logos, device pictures, `default_background.png`).
`src/company/company_Firstblood/` holds the Windows-install pictures the UI patches were measured on (the B6 key boxes are aligned to
that picture; the Mac app's own B6 render differs by a few pixels) and this build's `CONFIG.json` (`blockCloud`, `singleDriver`).
At build time these **replace** the vendor's files of the same name; files only the vendor has (`default_background.png`,
`dev/yc500_b18_soc.png`) are kept. `default_background.png` ships with 87.5 MB of Adobe XMP metadata, which the build strips losslessly
(87.7 MB -> 284 KB, identical pixels). There is nothing to add by hand and no option to import Windows files.
`--import-windows-data` (saved configurations and macros from the Windows `db` file) is unchanged.

## Hardware status

Tested on a real B6: enumeration, identity, framing, getters, key-matrix and macro round trips, checksums, timing, layer switching.
Not understood yet: why the keyboard dropped off USB and reset to factory defaults twice during test runs (once on purpose, once through
the driver's write path); see `tests/hw/FIRST-RUN-FINDINGS.md` sections 8-9 before running write tests, and use `tests/hw` snapshots/`--restore`.
Wireless modes (2.4G dongle, Bluetooth), music/screen lighting, OLED screens and other keyboard models are out of scope.
