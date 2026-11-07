# Firstblood Driver, Linux edition (B6, wired)

A Linux AppImage of the Firstblood configuration app for the **B6 6-button programmable pad** (wired, USB `3151:4015`):
key remapping on 3 layers, macros, saved configurations, basic lighting, key sensitivity. Built from the vendor's macOS UI (2.0.18)
plus a Linux replacement for the vendor's native helper (`iot_driver`), which only exists for Windows and macOS.

## Build

```
./build.sh --mac-zip /path/to/Firstblood_Driver_0_0_0.zip
```
Result: `out/Firstblood-Driver-linux-x86_64.AppImage`. About a minute on a normal connection.

* **Needs:** bash, curl, unzip, python3, node >= 16 + npm, sha256sum; gcc + make + static zlib (`libz.a`) for the bundled
  `mksquashfs` (or `--no-absorb-tool`). Network access to github.com and registry.npmjs.org.
* **You must supply** the vendor's macOS zip (https://orders.epomaker.com/software/Firstblood_Driver_2.0.18_mac.zip). `versions.env` pins its
  SHA-256 and that of the files inside; the build stops if they differ (`--force` overrides).
* Options: `--out DIR`, `--work DIR`, `--cache DIR` (downloads), `--skip-tests`, `--no-absorb-tool`, `--force`.
* Everything downloaded is pinned in `versions.env` (Electron 22.3.27, node-hid 3.4.0, sql.js 1.10.3, @electron/asar 4.3.1,
  squashfs-tools 4.6.1). appimagetool is a rolling upstream release: a changed hash only warns.
* The AppImage is not bit-for-bit reproducible (timestamps) but its contents are: extracting two builds and running `diff -r` shows no differences.

## What the build does

1. verifies the vendor zip, extracts `app.asar` (+ the parts the vendor kept outside it) with `tools/extract-asar.mjs`
2. adds Electron, `node-hid` (hidraw prebuild only) and `sql.js`
3. replaces the vendor's `company/` folder with `assets/company_Firstblood/` (logos, icon, B6 picture; supplied by the user)
4. copies `src/linux_main.js`, `src/ui-fixes.css`, `src/linux_driver/*`
5. runs `src/patch_ui.py` on the pristine UI bundle. Every patch must match exactly once or the build fails. Patches: no tray; closing always
   exits; no Share / My Account / login / update / firmware features; no analytics; basic Light page only; no wireless settings; no Appearance;
   no start-at-login; Windows-only helpers neutralised; B6 key boxes aligned to the picture; duplicate-configuration fix
6. builds a static `mksquashfs`, runs `tests/`, runs appimagetool

## Source layout

| path | purpose |
|---|---|
| `src/linux_driver/driver.js` | gRPC-web server on 127.0.0.1:3814 implementing the vendor helper's API (device list, send/read, vendor events, key/value store, microphone) |
| `src/linux_driver/hid.js` | device discovery and hidraw feature reports (via node-hid); B6 only |
| `src/linux_driver/checksum.js` | the keyboard's checksum rules |
| `src/linux_driver/kv.js` | key/value store, backups, protection against stale writes |
| `src/linux_driver/tools.js` | CLI tools: Windows import, backups, de-duplication, purge, absorb, udev install |
| `src/linux_driver/mic.js` | microphone mute via pactl / wpctl |
| `src/linux_driver/pb.js` | minimal protobuf encoder/decoder |
| `src/linux_main.js` | entry point: flags, startup safety net, resource overlay, privacy switches, driver start |
| `src/patch_ui.py` | the UI patches (see above) |
| `src/ui-fixes.css` | injected CSS (makes the whole Configuration selector clickable) |
| `src/AppRun`, `src/*.desktop`, `src/70-firstblood.rules` | AppImage launcher, desktop entry, udev rule |
| `assets/company_Firstblood/` | graphics from the Windows install (1.6 MB) + `CONFIG.json` |
| `tests/` | `run-tests.sh`: 13 tests, no hardware needed (simulated B6) |

## Protocol facts the driver relies on (reverse-engineered, hardware-verified only by the simulator)

* Command interface: vendor usage page `0xFFFF`, usage 2, interface 2 of `3151:4015`. Vendor events: interface 1.
* Each message is a 64-byte HID **feature report**, report ID 0 (hidraw: 65 bytes with a leading 0).
* Checksum "BIT7": `byte7 = ~sum(bytes 0..6)`; "BIT8": `byte8 = ~sum(bytes 0..7)`; both on the zero-padded 64-byte buffer.
* Device identity: send `0x8F`; the reply echoes `0x8F` in byte 0 and bytes 1..4 are the little-endian device id (910 for the B6).
* Replies echo the command byte: the driver polls until the echo arrives, so a slow reply is never taken for an empty one.
* `0x7F` (enter bootloader) is refused unless `FB_ALLOW_FIRMWARE=1`.

## Runtime behaviour worth knowing

* **Privacy:** no analytics; the app blocks every request except to its own local driver, and Chromium's background networking is off.
* **Data:** `~/.config/firstblood-driver/` (`iot_db/CONFIG`, `iot_db/macro`, `config/`, `backups/`). A snapshot is taken at every start
  (newest 25 kept); lists that shrink are backed up first; exact duplicate configurations are removed at start.
* **Permissions:** the app offers to install `/etc/udev/rules.d/70-firstblood.rules` the first time it cannot open the keyboard (from personal testing this happens with hidraw connections, such as usbc to usbc cables).
* Flags: run the AppImage with `--help`.
* Debugging: `FB_DEBUG=1` logs every byte sent and received; `FB_SEND_DELAY_MS`, `FB_READ_POLL_MS` tune timing.

## Not verified (by claude code directly)

No test has been run against a physical keyboard. The checksum position and timing come from disassembling the vendor helper and are
exercised only against the simulator in `tests/`. Wireless modes (2.4G dongle, Bluetooth), music/screen lighting, OLED screens and
other keyboard models are out of scope.
