#!/usr/bin/env bash
# Builds Firstblood-Driver-linux-x86_64.AppImage from this source tree plus the vendor's macOS app (which you supply).
#
#   ./build.sh --mac-zip /path/to/Firstblood_Driver_0_0_0.zip [--out DIR] [--work DIR] [--cache DIR]
#              [--skip-tests] [--no-absorb-tool] [--force]
#
# Needs: bash, curl, unzip, python3, node (>=16) + npm, sha256sum; gcc + make + zlib static (libz.a) for the bundled mksquashfs
# (or pass --no-absorb-tool to leave out the --absorb-windows-files feature). Network access to github.com and registry.npmjs.org.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$HERE/versions.env"

MAC_ZIP=""; WORK="$HERE/work"; OUT="$HERE/out"; CACHE=""; SKIP_TESTS=0; FORCE=0; NO_SQ=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mac-zip) MAC_ZIP="$2"; shift 2;;  --out) OUT="$2"; shift 2;;  --work) WORK="$2"; shift 2;;  --cache) CACHE="$2"; shift 2;;
    --skip-tests) SKIP_TESTS=1; shift;;  --no-absorb-tool) NO_SQ=1; shift;;  --force) FORCE=1; shift;;
    -h|--help) sed -n '2,10p' "$0"; exit 0;;  *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
[ -n "$MAC_ZIP" ] && [ -f "$MAC_ZIP" ] || { echo "Give the vendor's macOS zip with --mac-zip (Firstblood_Driver_0_0_0.zip)." >&2; exit 2; }
CACHE="${CACHE:-$WORK/dl}"; mkdir -p "$WORK" "$OUT" "$CACHE"
WORK="$(cd "$WORK" && pwd)"; OUT="$(cd "$OUT" && pwd)"; CACHE="$(cd "$CACHE" && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
for t in curl unzip python3 node npm sha256sum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
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

say "1/10  Checking the vendor input"
verify "$MAC_ZIP" "$MAC_ZIP_SHA256" "macOS zip (Firstblood_Driver_0_0_0.zip)"

say "2/10  Node modules (node-hid $NODE_HID_VERSION, sql.js $SQLJS_VERSION, @electron/asar $ASAR_VERSION)"
mkdir -p "$WORK/npm"
( cd "$WORK/npm" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --no-audit --no-fund --save-exact "node-hid@$NODE_HID_VERSION" "sql.js@$SQLJS_VERSION" "@electron/asar@$ASAR_VERSION" >/dev/null )
cp "$HERE/tools/extract-asar.mjs" "$WORK/npm/extract-asar.mjs"

say "3/10  Extracting the vendor UI"
rm -rf "$WORK/mac" "$WORK/appsrc"; mkdir -p "$WORK/mac"
unzip -q -o "$MAC_ZIP" '*/Contents/Resources/app.asar' '*/Contents/Resources/app.asar.unpacked/*' -x '*:com.apple*' '*/._*' '*__MACOSX*' -d "$WORK/mac"
ASAR="$(find "$WORK/mac" -name app.asar -type f | head -1)"; [ -n "$ASAR" ] || die "app.asar not found in the zip"
verify "$ASAR" "$MAC_ASAR_SHA256" "app.asar"
( cd "$WORK/npm" && node extract-asar.mjs "$ASAR" "$WORK/appsrc" )
cp -a "$ASAR.unpacked/." "$WORK/appsrc/"                       # the part of the app that the vendor kept outside the archive
find "$WORK/appsrc" \( -name '*:com.apple*' -o -name '._*' -o -name '.DS_Store' \) -delete
rm -f "$WORK/appsrc/iot_driver"                                # the macOS helper binary: replaced by src/linux_driver
verify "$WORK/appsrc/dist/index.js" "$PRISTINE_INDEX_JS_SHA256" "dist/index.js (pristine)"
verify "$WORK/appsrc/main_dist/main.js" "$PRISTINE_MAIN_JS_SHA256" "main_dist/main.js (pristine)"
mkdir -p "$WORK/pristine"; cp "$WORK/appsrc/dist/index.js" "$WORK/appsrc/main_dist/main.js" "$WORK/pristine/"

say "4/10  Electron $ELECTRON_VERSION"
fetch "$ELECTRON_URL" "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip"
verify "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip" "$ELECTRON_SHA256" "Electron $ELECTRON_VERSION"
APPDIR="$WORK/AppDir"; FB="$APPDIR/usr/lib/firstblood"; APP="$FB/resources/app"
rm -rf "$APPDIR"; mkdir -p "$FB"
unzip -q "$CACHE/electron-v$ELECTRON_VERSION-linux-x64.zip" -d "$FB"
mv "$FB/electron" "$FB/firstblood-driver"                      # a binary not named "electron" makes the app run in packaged mode
rm -f "$FB/resources/default_app.asar"
mv "$WORK/appsrc" "$APP"; ln -s app "$FB/resources/app.asar.unpacked"

say "5/10  Node modules into the app"
for m in node-hid pkg-prebuilds sql.js; do cp -a "$WORK/npm/node_modules/$m" "$APP/node_modules/$m"; done
( cd "$APP/node_modules/node-hid/prebuilds" && ls | grep -vx 'HID_hidraw-linux-x64' | xargs -r rm -rf )
ls "$APP/node_modules/node-hid/prebuilds/HID_hidraw-linux-x64/"*.node >/dev/null || die "node-hid hidraw prebuild missing"
( cd "$APP/node_modules/sql.js/dist" && rm -f ./*.zip ./*-debug.* ./sql-asm* ./worker.* )

say "6/10  Graphics (from assets/company_Firstblood) and application sources"
rm -rf "$APP/company"; mkdir -p "$APP/company"; cp -a "$HERE/assets/company_Firstblood" "$APP/company/"
cp "$HERE/src/linux_main.js" "$HERE/src/ui-fixes.css" "$APP/"
mkdir -p "$APP/linux_driver"; cp "$HERE"/src/linux_driver/*.js "$APP/linux_driver/"
cp "$HERE/src/70-firstblood.rules" "$FB/"
cp "$HERE/src/AppRun" "$APPDIR/AppRun"; chmod +x "$APPDIR/AppRun"
cp "$HERE/src/firstblood-driver.desktop" "$APPDIR/"
cp "$HERE/assets/company_Firstblood/icon.png" "$APPDIR/firstblood-driver.png"
node -e '
const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p,"utf8"));
j.name="firstblood-driver"; j.main="linux_main.js"; fs.writeFileSync(p,JSON.stringify(j,null,2));' "$APP/package.json"

say "7/10  Applying the UI patches"
python3 "$HERE/src/patch_ui.py" "$WORK/pristine" "$APP"

say "8/10  mksquashfs for --absorb-windows-files"
if [ "$NO_SQ" = 1 ]; then echo "skipped (--no-absorb-tool): the --absorb-windows-files flag will not work"
else mkdir -p "$FB/bin"; "$HERE/tools/build-mksquashfs.sh" "$WORK/squashfs" "$FB/bin/mksquashfs"; echo "built $(du -h "$FB/bin/mksquashfs" | cut -f1)"; fi

cat > "$FB/BUILD-INFO.txt" <<EOF
Firstblood Driver, Linux edition
Electron $ELECTRON_VERSION | node-hid $NODE_HID_VERSION | sql.js $SQLJS_VERSION | @electron/asar $ASAR_VERSION
vendor input zip sha256: $MAC_ZIP_SHA256
pristine dist/index.js sha256: $PRISTINE_INDEX_JS_SHA256
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

if [ "$SKIP_TESTS" = 0 ]; then say "9/10  Tests"; "$HERE/tests/run-tests.sh" 2>&1 | grep -v 'listening on' ; else say "9/10  Tests skipped"; fi

say "10/10  Building the AppImage"
AIT="$CACHE/appimagetool-x86_64.AppImage"; fetch "$APPIMAGETOOL_URL" "$AIT"; chmod +x "$AIT"
verify "$AIT" "$APPIMAGETOOL_SHA256" "appimagetool" warn
RESULT="$OUT/Firstblood-Driver-linux-x86_64.AppImage"; rm -f "$RESULT"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$AIT" --no-appstream "$APPDIR" "$RESULT" >/dev/null 2>&1 || die "appimagetool failed"
chmod +x "$RESULT"
echo; echo "Built: $RESULT ($(du -h "$RESULT" | cut -f1))"; echo "sha256: $(sha "$RESULT")"
echo "(The AppImage differs bit-for-bit between builds because of file timestamps; its contents are identical.)"
