#!/usr/bin/env python3
"""Read a macOS .dmg (UDIF, single HFS+/HFSX partition) with the Python standard library only; no 7z / hdiutil / root needed.

  dmg_extract.py IMAGE.dmg --list [PREFIX]                     list files (optionally under PREFIX)
  dmg_extract.py IMAGE.dmg --extract OUTDIR PATTERN [PATTERN]  extract files whose path matches a glob (fnmatch) pattern
  dmg_extract.py IMAGE.dmg --cat PATH                          write one file to stdout

Supports zlib / bzip2 / raw / zero chunks, HFS+ extents-overflow, symlinks and HFS+ "decmpfs" compressed files
(zlib; LZVN/LZFSE-compressed files are reported as an error rather than silently skipped).
Paths are relative to the volume root, e.g.  'Firstblood Driver.app/Contents/Resources/app.asar'."""
import bz2, fnmatch, os, plistlib, struct, sys, zlib

class Dmg:
    """Random access to the (single) HFS partition of a UDIF image; chunks are decompressed on demand."""
    def __init__(self, path):
        self.f = open(path, 'rb'); self.f.seek(-512, 2); k = self.f.read(512)
        if k[:4] != b'koly': raise SystemExit('not a UDIF .dmg (no koly trailer): ' + path)
        xo, xl = struct.unpack('>QQ', k[0xD8:0xE8]); self.f.seek(xo); pl = plistlib.loads(self.f.read(xl))
        best = None
        for e in pl['resource-fork']['blkx']:
            d = e['Data']; first, count = struct.unpack('>QQ', d[8:24])
            if 'HFS' in e.get('CFName', '') + e.get('Name', '') and (best is None or count > best[1]): best = (first, count, d)
        if not best: raise SystemExit('no Apple_HFS partition found (APFS images are not supported)')
        first, count, d = best; dataoff = struct.unpack('>Q', d[24:32])[0]; n = struct.unpack('>I', d[200:204])[0]; self.runs = []
        for i in range(n):
            typ, _, sec, secs, off, ln = struct.unpack('>IIQQQQ', d[204 + i * 40:244 + i * 40])
            if typ == 0xffffffff: break
            if typ == 0x7ffffffe: continue
            self.runs.append((sec * 512, secs * 512, typ, dataoff + off, ln))
        self.size = count * 512; self.cache = {}
    def _chunk(self, i):
        if i in self.cache: return self.cache[i]
        o, l, typ, off, ln = self.runs[i]
        if typ in (0, 2): b = bytes(l)
        elif typ == 1: self.f.seek(off); b = self.f.read(ln)
        elif typ == 0x80000005: self.f.seek(off); b = zlib.decompress(self.f.read(ln))
        elif typ == 0x80000006: self.f.seek(off); b = bz2.decompress(self.f.read(ln))
        else: raise SystemExit('unsupported DMG chunk type 0x%x (LZFSE/ADC/LZMA images are not supported; re-create the image as UDZO/UDRO)' % typ)
        if len(self.cache) > 6: self.cache.pop(next(iter(self.cache)))
        self.cache[i] = b; return b
    def read(self, off, n):
        out = []; lo, hi = 0, len(self.runs)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.runs[mid][0] + self.runs[mid][1] <= off: lo = mid + 1
            else: hi = mid
        i = lo
        while n > 0 and i < len(self.runs):
            o, l = self.runs[i][0], self.runs[i][1]; s = off - o; take = min(n, l - s)
            out.append(self._chunk(i)[s:s + take]); off += take; n -= take; i += 1
        return b''.join(out)

class Fork:
    def __init__(self, raw): self.size, _, self.blocks = struct.unpack('>QII', raw[:16]); self.ext = [struct.unpack('>II', raw[16 + i * 8:24 + i * 8]) for i in range(8)]

class BTree:
    def __init__(self, hfs, data):   # data: callable(off, n) reading the tree's fork
        self.rd = data; h = self.rd(0, 512)
        self.nsize = struct.unpack('>H', h[32:34])[0]; self.first = struct.unpack('>I', h[24:28])[0]
    def node(self, n): return self.rd(n * self.nsize, self.nsize)
    def leaves(self):
        n = self.first
        while n:
            b = self.node(n); fl, bl, kind, height, nrec = struct.unpack('>IIbBH', b[:12])
            offs = [struct.unpack('>H', b[self.nsize - 2 * (j + 1):self.nsize - 2 * j])[0] for j in range(nrec + 1)]
            for i in range(nrec): yield b[offs[i]:offs[i + 1]]
            n = fl

class HFS:
    def __init__(self, dmg):
        self.d = dmg; vh = dmg.read(1024, 512)
        if vh[:2] not in (b'H+', b'HX'): raise SystemExit('unsupported volume (not HFS+/HFSX): %r' % vh[:2])
        self.bs = struct.unpack('>I', vh[40:44])[0]
        self.ext_fork, self.cat_fork, self.attr_fork = Fork(vh[192:272]), Fork(vh[272:352]), Fork(vh[352:432])
        self.overflow = {}   # (fileID, forkType) -> [(startBlock, [extents])]
        for r in BTree(self, lambda o, n: self._fork_read(self.ext_fork, 3, 0, o, n, False)).leaves():
            kl, ft, _, fid, start = struct.unpack('>HBBII', r[:12])
            self.overflow.setdefault((fid, ft), []).append((start, [struct.unpack('>II', r[12 + i * 8:20 + i * 8]) for i in range(8)]))
        self.cat = BTree(self, lambda o, n: self._fork_read(self.cat_fork, 4, 0, o, n))
        self.attr = BTree(self, lambda o, n: self._fork_read(self.attr_fork, 8, 0, o, n)) if self.attr_fork.size else None
        self._index = None
    def _extents(self, fork, fid, ftype, use_overflow=True):
        ext = [(s, c) for s, c in fork.ext if c]; have = sum(c for _, c in ext)
        if use_overflow and have < fork.blocks:
            for start, lst in sorted(self.overflow.get((fid, ftype), [])): ext += [(s, c) for s, c in lst if c]
        return ext
    def _fork_read(self, fork, fid, ftype, off, n, use_overflow=True):
        n = max(0, min(n, fork.size - off)); out = []; pos = 0
        for s, c in self._extents(fork, fid, ftype, use_overflow):
            ln = c * self.bs
            if off < pos + ln and n > 0:
                so = off - pos; take = min(n, ln - so); out.append(self.d.read(s * self.bs + so, take)); off += take; n -= take
            pos += ln
            if n <= 0: break
        return b''.join(out)
    @staticmethod
    def _name(r, o): ln = struct.unpack('>H', r[o:o + 2])[0]; return r[o + 2:o + 2 + ln * 2].decode('utf-16-be'), o + 2 + ln * 2
    def index(self):
        if self._index is not None: return self._index
        kids, rec = {}, {}
        for r in self.cat.leaves():
            kl, parent = struct.unpack('>HI', r[:6]); name, _ = self._name(r, 6)
            o = 2 + kl
            if o % 2: o += 1
            t = struct.unpack('>H', r[o:o + 2])[0]
            if t == 1: fid = struct.unpack('>I', r[o + 8:o + 12])[0]; kids.setdefault(parent, []).append((name, fid)); rec[(parent, name)] = ('d', fid, None)
            elif t == 2: fid = struct.unpack('>I', r[o + 8:o + 12])[0]; kids.setdefault(parent, []).append((name, fid)); rec[(parent, name)] = ('f', fid, r[o:o + 248])
        self._index = (kids, rec); return self._index
    def walk(self, parent=2, prefix=''):
        kids, rec = self.index()
        for name, fid in sorted(kids.get(parent, [])):
            kind, _, raw = rec[(parent, name)]; p = prefix + name
            if kind == 'd': yield p + '/', None; yield from self.walk(fid, p + '/')
            else: yield p, raw
    def _decmpfs(self, fid):
        if not self.attr: return None
        for r in self.attr.leaves():
            kl, pad, f, start, nl = struct.unpack('>HHIIH', r[:14])
            if f == fid and r[14:14 + nl * 2].decode('utf-16-be') == 'com.apple.decmpfs':
                o = 2 + kl; o += o % 2; sz = struct.unpack('>I', r[o + 12:o + 16])[0]; return r[o + 16:o + 16 + sz]
        return None
    def read_file(self, raw):
        fid = struct.unpack('>I', raw[8:12])[0]; mode = struct.unpack('>H', raw[42:44])[0]; oflags = raw[41]
        dfork, rfork = Fork(raw[88:168]), Fork(raw[168:248])
        if oflags & 0x20:   # UF_COMPRESSED
            h = self._decmpfs(fid)
            if not h or h[:4] != b'fpmc': raise SystemExit('compressed file without decmpfs header')
            ctype, usize = struct.unpack('<IQ', h[4:16])
            if ctype == 3: return zlib.decompress(h[16:]) if h[16:17] != b'\xff' else h[17:]
            if ctype == 4:
                rs = self._fork_read(rfork, fid, 0xff, 0, rfork.size); dstart = struct.unpack('>I', rs[:4])[0]; tbl = dstart + 4
                n = struct.unpack('<I', rs[tbl:tbl + 4])[0]; out = []
                for i in range(n):
                    o, l = struct.unpack('<II', rs[tbl + 4 + i * 8:tbl + 12 + i * 8]); c = rs[dstart + 4 + o:dstart + 4 + o + l]
                    out.append(zlib.decompress(c) if c[:1] != b'\xff' else c[1:])
                return b''.join(out)[:usize]
            raise SystemExit('file is HFS+-compressed with an unsupported method (decmpfs type %d: LZVN/LZFSE); create the DMG without compression' % ctype)
        data = self._fork_read(dfork, fid, 0, 0, dfork.size)
        return data
    def is_symlink(self, raw): return (struct.unpack('>H', raw[42:44])[0] & 0xF000) == 0xA000
    def is_exec(self, raw): return bool(struct.unpack('>H', raw[42:44])[0] & 0o111)

def main(a):
    if len(a) < 2: print(__doc__); return 2
    hfs = HFS(Dmg(a[0])); cmd = a[1]
    if cmd == '--list':
        pre = a[2] if len(a) > 2 else ''
        for p, raw in hfs.walk():
            if p.startswith(pre): print(p if raw is None else '%s  (%d bytes%s)' % (p, struct.unpack('>Q', raw[88:96])[0], ', symlink' if hfs.is_symlink(raw) else ''))
    elif cmd == '--cat':
        for p, raw in hfs.walk():
            if p == a[2] and raw is not None: sys.stdout.buffer.write(hfs.read_file(raw)); return 0
        print('not found: ' + a[2], file=sys.stderr); return 1
    elif cmd == '--extract':
        out, pats, n = a[2], a[3:], 0
        for p, raw in hfs.walk():
            if raw is None or not any(fnmatch.fnmatchcase(p, q) for q in pats): continue
            dest = os.path.join(out, p); os.makedirs(os.path.dirname(dest), exist_ok=True); data = hfs.read_file(raw)
            if hfs.is_symlink(raw):
                if os.path.lexists(dest): os.remove(dest)
                os.symlink(data.decode('utf-8'), dest)
            else:
                with open(dest, 'wb') as f: f.write(data)
                os.chmod(dest, 0o755 if hfs.is_exec(raw) else 0o644)
            n += 1
        print('extracted %d file(s)' % n, file=sys.stderr)
        if not n: return 1
    else: print(__doc__); return 2
    return 0
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
