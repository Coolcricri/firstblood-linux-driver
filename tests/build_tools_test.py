#!/usr/bin/env python3
"""Tests for the build helpers in tools/: strip_png.py, unzip.py and (when FB_TEST_DMG points at the vendor image) dmg_extract.py."""
import os, struct, subprocess, sys, tempfile, zipfile, zlib, stat, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); T = os.path.join(HERE, '..', 'tools'); n = 0
def ok(m):
    global n; n += 1; print('  ok  ', m)
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
def png(extra=b''):
    raw = zlib.compress(b'\x00\xff\x00\x00\xff')   # 1x1 RGBA red
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + extra + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
def run(*a): return subprocess.run([sys.executable, *a], capture_output=True, text=True)

with tempfile.TemporaryDirectory() as d:
    # strip_png: drops tEXt/iTXt/zTXt, keeps image chunks byte-for-byte, leaves clean / non-PNG / truncated files alone
    big = chunk(b'iTXt', b'XML:com.adobe.xmp\0\0\0\0\0' + b'x' * 50000) + chunk(b'tEXt', b'a\0b') + chunk(b'zTXt', b'k\0\0' + zlib.compress(b'v'))
    p = os.path.join(d, 'a.png'); open(p, 'wb').write(png(big)); r = run(os.path.join(T, 'strip_png.py'), p); assert r.returncode == 0, r.stderr
    assert open(p, 'rb').read() == png(), 'stripped PNG must equal the same PNG without text chunks'; ok('strip_png removes iTXt/tEXt/zTXt and keeps the image chunks byte for byte')
    before = open(p, 'rb').read(); run(os.path.join(T, 'strip_png.py'), p); assert open(p, 'rb').read() == before; ok('strip_png leaves a clean PNG untouched')
    q = os.path.join(d, 'trunc.png'); open(q, 'wb').write(png(big)[:-30]); t = open(q, 'rb').read(); run(os.path.join(T, 'strip_png.py'), q); assert open(q, 'rb').read() == t; ok('strip_png leaves a truncated PNG untouched')
    q = os.path.join(d, 'x.png'); open(q, 'wb').write(b'not a png'); run(os.path.join(T, 'strip_png.py'), q); assert open(q, 'rb').read() == b'not a png'; ok('strip_png ignores files that are not PNGs')
    # unzip: exec bits, symlinks, patterns, refusal of path traversal
    z = os.path.join(d, 't.zip')
    with zipfile.ZipFile(z, 'w') as f:
        i = zipfile.ZipInfo('bin/run'); i.external_attr = (stat.S_IFREG | 0o755) << 16; f.writestr(i, '#!/bin/sh\n')
        i = zipfile.ZipInfo('doc/readme.txt'); i.external_attr = (stat.S_IFREG | 0o644) << 16; f.writestr(i, 'hi')
        i = zipfile.ZipInfo('lib/link'); i.external_attr = (stat.S_IFLNK | 0o777) << 16; f.writestr(i, 'target.so')
        f.writestr('only/this.dmg', 'dmg')
    o = os.path.join(d, 'out'); r = run(os.path.join(T, 'unzip.py'), z, o); assert r.returncode == 0, r.stderr
    assert os.access(os.path.join(o, 'bin/run'), os.X_OK) and not os.access(os.path.join(o, 'doc/readme.txt'), os.X_OK); assert os.readlink(os.path.join(o, 'lib/link')) == 'target.so'; ok('unzip keeps executable bits and symlinks')
    o2 = os.path.join(d, 'out2'); run(os.path.join(T, 'unzip.py'), z, o2, '*.dmg'); assert os.listdir(o2) == ['only'] and os.path.exists(os.path.join(o2, 'only/this.dmg')); ok('unzip extracts only members matching a glob')
    zz = os.path.join(d, 'evil.zip')
    with zipfile.ZipFile(zz, 'w') as f: f.writestr('../escape.txt', 'x')
    r = run(os.path.join(T, 'unzip.py'), zz, os.path.join(d, 'out3')); assert r.returncode != 0 and not os.path.exists(os.path.join(d, 'escape.txt')); ok('unzip refuses paths that escape the destination')

dmg = os.environ.get('FB_TEST_DMG')
if dmg and os.path.exists(dmg):
    r = run(os.path.join(T, 'dmg_extract.py'), dmg, '--list'); assert r.returncode == 0, r.stderr
    assert 'Contents/Resources/app.asar  (' in r.stdout and 'company_Firstblood/CONFIG.json' in r.stdout; ok('dmg_extract lists the vendor app in the real disk image')
    r = run(os.path.join(T, 'dmg_extract.py'), dmg, '--cat', [l.split('  (')[0] for l in r.stdout.splitlines() if l.endswith('company_Firstblood/CONFIG.json  (64 bytes)') or 'company_Firstblood/CONFIG.json' in l][0])
    assert r.returncode == 0; ok('dmg_extract reads a file out of the real disk image')
else: print('  skip  dmg_extract (set FB_TEST_DMG=<vendor .dmg> to test it against the real image)')
print('build tools: all %d tests passed' % n)
