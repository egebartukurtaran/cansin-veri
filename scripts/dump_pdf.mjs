import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
const f = process.argv[2];
const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  console.log(`=== page ${p}`);
  const rows = new Map();
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(it);
  }
  for (const y of [...rows.keys()].sort((a,b)=>b-a)) {
    console.log(y, rows.get(y).sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>`[${i.transform[4].toFixed(0)}]${i.str}`).join(' '));
  }
}
