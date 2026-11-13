// Extracts the vendor's app.asar. The archive lists some "unpacked" files (device pictures, default background) that the
// vendor's zip does not contain; they are created as empty placeholders so that extraction completes cleanly.
// (The Linux build replaces the whole company/ folder with assets/company_Firstblood, so the placeholders never ship.)
// usage: node extract-asar.mjs <app.asar> <destination>
import * as asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
const [arc, dest] = process.argv.slice(2);
const missing = [];
for (const f of asar.listPackage(arc, { isPack: false })) {
  const rel = f.replace(/^[\\/]/, '');
  let st; try { st = asar.statFile(arc, rel, true); } catch (e) { continue; }
  if (st.unpacked && !st.files) {
    const p = path.join(arc + '.unpacked', rel);
    if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); missing.push(rel); }
  }
}
if (missing.length) console.log(`note: ${missing.length} unpacked file(s) are not in the vendor zip (placeholders created): ${missing.map((m) => path.basename(m)).join(', ')}`);
asar.extractAll(arc, dest);
