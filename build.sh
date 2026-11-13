#!/usr/bin/env bash
# Builds Firstblood-Driver-linux-x86_64.AppImage from this source tree plus the vendor's macOS app (which you supply).
#
#   ./build.sh --mac-image /path/to/Firstblood_Driver_2_0_18_mac.zip [--out DIR] [--work DIR] [--cache DIR]
#              [--skip-tests] [--force]
#
# --mac-image takes the vendor's zip (it contains Firstblood_Driver_2.0.18_mac.dmg) or the .dmg itself. The disk image is read
# with tools/dmg_extract.py (Python standard library): no 7z, hdiutil, mount or root needed.
# Needs: bash, curl, python3, node (>=16) + npm, sha256sum; network access to github.com and registry.npmjs.org.
# No compiler is needed. The logos / device pictures come from src/company (the Windows pictures the UI patches were measured on),
# completed from the vendor image (default_background.png etc.); nothing has to be added by hand.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"

MAC_IMAGE=""; WORK="$HERE/work"; OUT="$HERE/out"; CACHE=""; SKIP_TESTS=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mac-image|--mac-zip) MAC_IMAGE="$2"; shift 2;;  --out) OUT="$2"; shift 2;;  --work) WORK="$2"; shift 2;;  --cache) CACHE="$2"; shift 2;;
    --skip-tests) SKIP_TESTS=1; shift;;  --force) FORCE=1; shift;;
    -h|--help) sed -n '2,11p' "$0"; exit 0;;  *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
[ -n "$MAC_IMAGE" ] && [ -f "$MAC_IMAGE" ] || { echo "Give the vendor's macOS image with --mac-image (Firstblood_Driver_2_0_18_mac.zip or the .dmg inside it)." >&2; exit 2; }
CACHE="${CACHE:-$WORK/dl}"; mkdir -p "$WORK" "$OUT" "$CACHE"
WORK="$(cd "$WORK" && pwd)"; OUT="$(cd "$OUT" && pwd)"; CACHE="$(cd "$CACHE" && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
for t in curl python3 node npm sha256sum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
sha() { sha256sum "$1" | cut -d' ' -f1; }
verify() { # file expected label [warn]
  local got; got="$(sha "$1")"
  if [ "$got" != "$2" ]; then
    if [ "${4:-}" = warn ] || [ "$FORCE" = 1 ]; then echo "WARNING: $3 differs from the pinned version (expected ${2:0:12}…, got ${got:0:12}…)"
    else die "$3 does not match the pinned version (expected $2, got $got). Use --force to build anyway."; fi
  else echo "ok  $3"; fi
}
fetch() { # url dest
  [ -f "$2" ] || { echo "downloading $(basename "$2")"; curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
}

say "1/9  Checking the vendor input"
rm -rf "$WORK/mac" "$WORK/appsrc"; mkdir -p "$WORK/mac"
case "$MAC_IMAGE" in
  *.dmg|*.DMG) DMG="$MAC_IMAGE";;
  *) [ "$(sha "$MAC_IMAGE")" = "$MAC_ZIP_SHA256" ] && echo "ok  zip is the pinned Firstblood_Driver_2_0_18_mac.zip" || echo "note: zip differs from the pinned one (only the disk image inside is checked)"
     python3 "$HERE/tools/unzip.py" "$MAC_IMAGE" "$WORK/mac" '*.dmg' || die "no .dmg found inside $MAC_IMAGE"
     DMG="$(find "$WORK/mac" -name '*.dmg' -type f | head -1)"; [ -n "$DMG" ] || die "no .dmg found inside $MAC_IMAGE";;
esac
verify "$DMG" "$MAC_DMG_SHA256" "disk image ($(basename "$DMG"))"

say "2/9  Node modules (node-hid $NODE_HID_VERSION, sql.js $SQLJS_VERSION, @electron/asar $ASAR_VERSION)"
mkdir -p "$WORK/npm"
( cd "$WORK/npm" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --no-audit --no-fund --save-exact "node-hid@$NODE_HID_VERSION" "sql.js@$SQLJS_VERSION" "@electron/asar@$ASAR_VERSION" >/dev/null )
cp "$HERE/tools/extract-asar.mjs" "$WORK/npm/extract-asar.mjs"

say "3/9  Extracting the vendor UI from the disk image"
python3 "$HERE/tools/dmg_extract.py" "$DMG" --extract "$WORK/mac" '*.app/Contents/Resources/app.asar' '*.app/Contents/Resources/app.asar.unpacked/*' \
  || die "could not read the app out of the disk image"
ASAR="$(find "$WORK/mac" -name app.asar -type f | head -1)"; [ -n "$ASAR" ] || die "app.asar not found in the disk image"
verify "$ASAR" "$MAC_ASAR_SHA256" "app.asar"
( cd "$WORK/npm" && node extract-asar.mjs "$ASAR" "$WORK/appsrc" )
cp -a "$ASAR.unpacked/." "$WORK/appsrc/"                       # the part of the app that the vendor kept outside the archive
find "$WORK/appsrc" \( -name '*:com.apple*' -o -name '._*' -o -name '.DS_Store' \) -delete
rm -f "$WORK/appsrc/iot_driver"                                # the macOS helper binary: replaced by src/linux_driver
verify "$WORK/appsrc/dist/index.js" "$PRISTINE_INDEX_JS_SHA256" "dist/index.js (pristine)"
verify "$WORK/appsrc/main_dist/main.js" "$PRISTINE_MAIN_JS_SHA256" "main_dist/main.js (pristine)"
mkdir -p "$WORK/pristine"; cp "$WORK/appsrc/dist/index.js" "$WORK/appsrc/main_dist/main.js" "$WORK/pristine/"

say "4/9  Electron $ELECTRON_VERSION"
fetch "$ELECTRON_URL" "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip"
verify "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip" "$ELECTRON_SHA256" "Electron $ELECTRON_VERSION"
APPDIR="$WORK/AppDir"; FB="$APPDIR/usr/lib/firstblood"; APP="$FB/resources/app"
rm -rf "$APPDIR"; mkdir -p "$FB"
python3 "$HERE/tools/unzip.py" "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip" "$FB" >/dev/null
mv "$FB/electron" "$FB/firstblood-driver"                      # a binary not named "electron" makes the app run in packaged mode
rm -f "$FB/resources/default_app.asar"
mv "$WORK/appsrc" "$APP"; ln -s app "$FB/resources/app.asar.unpacked"

say "5/9  Node modules into the app"
for m in node-hid pkg-prebuilds sql.js; do rm -rf "$APP/node_modules/$m"; mkdir -p "$APP/node_modules"; cp -a "$WORK/npm/node_modules/$m" "$APP/node_modules/$m"; done
( cd "$APP/node_modules/node-hid/prebuilds" && ls | grep -vx 'HID_hidraw-linux-x64' | xargs -r rm -rf )
ls "$APP/node_modules/node-hid/prebuilds/HID_hidraw-linux-x64/"*.node >/dev/null || die "node-hid hidraw prebuild missing"
( cd "$APP/node_modules/sql.js/dist" && rm -f ./*.zip ./*-debug.* ./sql-asm* ./worker.* )

say "6/9  Pictures (src/company over the vendor's), application sources, UI patches"
# The vendor image already carries company/company_Firstblood. src/company holds the pictures the UI patches were measured on and our
# CONFIG.json (blockCloud / singleDriver): they replace the vendor's files; whatever only the vendor has (default_background.png,
# dev/yc500_b18_soc.png) is kept. Other company folders are dropped.
CO="$APP/company/company_Firstblood"; [ -d "$CO" ] || die "the vendor image has no company/company_Firstblood folder"
find "$APP/company" -mindepth 1 -maxdepth 1 ! -name company_Firstblood -exec rm -rf {} +
cp -a "$HERE/src/company/." "$APP/company/"
python3 "$HERE/tools/strip_png.py" "$APP/company"              # the vendor background carries 87 MB of editing-history metadata
for f in CONFIG.json icon.png default_background.png dev/yc500_b6_soc.png; do [ -f "$CO/$f" ] || die "missing picture: company_Firstblood/$f"; done
grep -q blockCloud "$CO/CONFIG.json" || die "company_Firstblood/CONFIG.json is not the Linux one"
cp "$HERE/src/linux_main.js" "$HERE/src/ui-fixes.css" "$APP/"
mkdir -p "$APP/linux_driver"; cp "$HERE"/src/linux_driver/*.js "$APP/linux_driver/"
cp "$HERE/src/70-firstblood.rules" "$FB/"
cp "$HERE/src/AppRun" "$APPDIR/AppRun"; chmod +x "$APPDIR/AppRun"
cp "$HERE/src/firstblood-driver.desktop" "$APPDIR/"
cp "$CO/icon.png" "$APPDIR/firstblood-driver.png"
node -e '
const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p,"utf8"));
j.name="firstblood-driver"; j.main="linux_main.js"; fs.writeFileSync(p,JSON.stringify(j,null,2));' "$APP/package.json"
python3 "$HERE/src/patch_ui.py" "$WORK/pristine" "$APP"

cat > "$FB/BUILD-INFO.txt" <<EOT
Firstblood Driver, Linux edition
Electron $ELECTRON_VERSION | node-hid $NODE_HID_VERSION | sql.js $SQLJS_VERSION | @electron/asar $ASAR_VERSION
vendor disk image sha256: $(sha "$DMG")
pristine dist/index.js sha256: $PRISTINE_INDEX_JS_SHA256
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOT

if [ "$SKIP_TESTS" = 0 ]; then say "7/9  Tests"; FB_TEST_DMG="$DMG" "$HERE/tests/run-tests.sh" 2>&1 | grep -v 'listening on' ; else say "7/9  Tests skipped"; fi

say "8/9  appimagetool"
AIT="$CACHE/appimagetool-x86_64.AppImage"; fetch "$APPIMAGETOOL_URL" "$AIT"; chmod +x "$AIT"
verify "$AIT" "$APPIMAGETOOL_SHA256" "appimagetool" warn

say "9/9  Building the AppImage"
RESULT="$OUT/Firstblood-Driver-linux-x86_64.AppImage"; rm -f "$RESULT"
if ! ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$AIT" --no-appstream "$APPDIR" "$RESULT" > "$WORK/appimagetool.log" 2>&1; then
  tail -n 25 "$WORK/appimagetool.log" >&2; die "appimagetool failed (full log: $WORK/appimagetool.log)"
fi
chmod +x "$RESULT"
echo; echo "Built: $RESULT ($(du -h "$RESULT" | cut -f1))"; echo "sha256: $(sha "$RESULT")"
echo "(The AppImage differs bit-for-bit between builds because of file timestamps; its contents are identical.)"
