#!/usr/bin/env python3
"""Losslessly drop text/metadata chunks (tEXt, zTXt, iTXt) from PNG files. Image data chunks are copied byte for byte.
The vendor's default_background.png is 87.7 MB, of which 87.5 MB is one iTXt chunk (the picture itself is 284 KB).
  strip_png.py DIR_OR_FILE [...]"""
import os, struct, sys
DROP = {b'tEXt', b'zTXt', b'iTXt'}

def strip(path):
    b = open(path, 'rb').read()
    if b[:8] != b'\x89PNG\r\n\x1a\n': return 0
    out, i = [b[:8]], 8; saw_end = False
    while i + 12 <= len(b):
        ln = struct.unpack('>I', b[i:i + 4])[0]; typ = b[i + 4:i + 8]; end = i + 12 + ln
        if end > len(b): return 0          # truncated: leave the file alone
        if typ not in DROP: out.append(b[i:end])
        if typ == b'IEND': saw_end = True; break
        i = end
    new = b''.join(out)
    if not saw_end or len(new) >= len(b): return 0
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f: f.write(new)
    os.replace(tmp, path); return len(b) - len(new)

def main(a):
    saved = 0
    for p in a:
        files = [p] if os.path.isfile(p) else [os.path.join(r, f) for r, _, fs in os.walk(p) for f in fs if f.lower().endswith('.png')]
        for f in files:
            s = strip(f); saved += s
            if s >= 100000: print('  %s: %.1f MB of metadata removed' % (os.path.relpath(f, p if os.path.isdir(p) else os.path.dirname(p)), s / 1e6))
    print('PNG metadata removed: %.1f MB' % (saved / 1e6)); return 0
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
