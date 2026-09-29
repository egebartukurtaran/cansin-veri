// Minimal .docx text extraction: a tiny zip reader (stored / deflate via DecompressionStream)
// plus regex-based reading of word/document.xml. No external libraries.

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns the uncompressed bytes of one entry of a zip archive, or null if missing. */
export async function readZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | null> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Dosya bir Word (.docx) dosyası değil.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Bozuk .docx dosyası.');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const entryName = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data.slice();
      if (method === 8) return inflateRaw(data);
      throw new Error('Desteklenmeyen .docx sıkıştırması.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += '\n';
  }
  return out;
}

/**
 * Text lines of the document body in reading order. A table row becomes one line with the
 * cells joined by " - " (so "Glukoz | 103" reads like "Glukoz - 103").
 */
export function documentLines(xml: string): string[] {
  const body = xml.replace(/^[\s\S]*?<w:body>/, '').replace(/<\/w:body>[\s\S]*$/, '');
  const lines: string[] = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  for (const m of body.matchAll(re)) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl>')) {
      for (const row of chunk.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) =>
          [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]).trim()).join(' '),
        );
        lines.push(cells.filter((c) => c !== '').join(' - '));
      }
    } else {
      lines.push(...paragraphText(chunk).split('\n'));
    }
  }
  return lines;
}

export async function readDocxLines(bytes: Uint8Array): Promise<string[]> {
  const doc = await readZipEntry(bytes, 'word/document.xml');
  if (!doc) throw new Error('Word belgesinin içeriği bulunamadı.');
  return documentLines(new TextDecoder().decode(doc));
}
