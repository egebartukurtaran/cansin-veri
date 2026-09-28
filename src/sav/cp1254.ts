// Windows-1254 (Turkish) codec. TextEncoder only supports UTF-8, so we keep our own table.
// 0x00-0x7F: ASCII. 0xA0-0xFF: Latin-1 except six Turkish letters. 0x80-0x9F: table below.

const HIGH_80_9F: (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, null, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, null, 0x0178,
];

const TURKISH: Record<number, number> = {
  0xd0: 0x011e, // Ğ
  0xdd: 0x0130, // İ
  0xde: 0x015e, // Ş
  0xf0: 0x011f, // ğ
  0xfd: 0x0131, // ı
  0xfe: 0x015f, // ş
};

const DECODE: number[] = new Array(256);
const ENCODE = new Map<number, number>();

for (let b = 0; b < 256; b++) {
  let cp: number;
  if (b < 0x80) cp = b;
  else if (b < 0xa0) cp = HIGH_80_9F[b - 0x80] ?? b; // undefined bytes pass through (like WHATWG)
  else cp = TURKISH[b] ?? b;
  DECODE[b] = cp;
  if (!ENCODE.has(cp)) ENCODE.set(cp, b);
}

export function decode1254(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(DECODE[bytes[i]]);
  return s;
}

/** Returns null if some character cannot be represented in windows-1254. */
export function tryEncode1254(text: string): Uint8Array | null {
  const s = text.normalize('NFC');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const b = ENCODE.get(s.charCodeAt(i));
    if (b === undefined) return null;
    out[i] = b;
  }
  return out;
}

export function encode1254(text: string): Uint8Array {
  const out = tryEncode1254(text);
  if (!out) throw new Error(`windows-1254 ile yazılamayan karakter: ${text}`);
  return out;
}
