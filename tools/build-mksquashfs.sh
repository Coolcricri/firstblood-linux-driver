#!/usr/bin/env bash
# Builds a static mksquashfs (gzip only). It is bundled so that --absorb-windows-files works on any machine.
# usage: build-mksquashfs.sh <workdir> <output-binary>
set -euo pipefail
source "$(dirname "$0")/../versions.env"
W="$1"; OUT="$2"; mkdir -p "$W"
[ -f "$W/sq.tgz" ] || curl -fsSL -o "$W/sq.tgz" "$SQUASHFS_TOOLS_URL"
rm -rf "$W/src"; mkdir "$W/src"; tar xzf "$W/sq.tgz" -C "$W/src" --strip-components=1
make -C "$W/src/squashfs-tools" -j"$(nproc)" mksquashfs GZIP_SUPPORT=1 XZ_SUPPORT=0 LZO_SUPPORT=0 LZ4_SUPPORT=0 ZSTD_SUPPORT=0 XATTR_SUPPORT=0 COMP_DEFAULT=gzip LDFLAGS=-static >/dev/null 2>&1
cp "$W/src/squashfs-tools/mksquashfs" "$OUT"; strip "$OUT"; chmod +x "$OUT"
