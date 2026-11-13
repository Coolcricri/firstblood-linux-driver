#!/usr/bin/env python3
"""Minimal unzip using only the Python standard library (so the build does not need the 'unzip' program).
  unzip.py ZIPFILE DESTDIR [GLOB ...]     extract everything, or only members matching a glob (fnmatch; '*' also matches '/')
Keeps executable bits and symlinks, refuses paths that would escape DESTDIR."""
import fnmatch, os, stat, sys, zipfile

def main(a):
    if len(a) < 2: print(__doc__); return 2
    zf, dest, pats = a[0], os.path.abspath(a[1]), a[2:]; n = 0
    with zipfile.ZipFile(zf) as z:
        for i in z.infolist():
            if pats and not any(fnmatch.fnmatchcase(i.filename, p) for p in pats): continue
            target = os.path.abspath(os.path.join(dest, i.filename))
            if target != dest and not target.startswith(dest + os.sep): raise SystemExit('unsafe path in zip: ' + i.filename)
            if i.is_dir(): os.makedirs(target, exist_ok=True); continue
            os.makedirs(os.path.dirname(target), exist_ok=True); mode = i.external_attr >> 16
            if stat.S_ISLNK(mode):
                if os.path.lexists(target): os.remove(target)
                os.symlink(z.read(i).decode(), target)
            else:
                with z.open(i) as src, open(target, 'wb') as out:
                    while True:
                        c = src.read(1 << 20)
                        if not c: break
                        out.write(c)
                os.chmod(target, 0o755 if mode & 0o111 else 0o644)
            n += 1
    print('extracted %d file(s) from %s' % (n, os.path.basename(zf)), file=sys.stderr)
    return 0 if n else 1
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
