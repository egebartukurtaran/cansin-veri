// Minimal SPSS system file (.sav) reader/writer.
// Reference: PSPP "System File Format". Supports $FL2, bytecode compression (1) or none (0),
// little-endian files, strings up to 255 bytes. The dictionary is kept as raw bytes and
// written back unchanged; only the case counts are patched.

import { decode1254, encode1254, tryEncode1254 } from './cp1254';

export const SYSMIS = -Number.MAX_VALUE;
const HEADER_SIZE = 176;
const NCASES_OFFSET = 80;

export interface SavVariable {
  /** Long name (from record 7.13), falls back to the short name. */
  name: string;
  shortName: string;
  /** 0 = numeric, otherwise string width in bytes (1..255). */
  width: number;
  /** Number of 8-byte slots this variable occupies in a case. */
  slots: number;
}

/** numeric: number, or null for system-missing. string: text without trailing spaces. */
export type Cell = number | string | null;

export interface SavFile {
  header: Uint8Array;
  /** Raw dictionary bytes from end of header up to and including the 999 record. */
  dictionary: Uint8Array;
  /** Offset (inside `dictionary`) of the int64 case count from record 7.16, or -1. */
  ncases64Offset: number;
  compression: 0 | 1;
  bias: number;
  variables: SavVariable[];
  rows: Cell[][];
}

export function readSav(input: ArrayBuffer | Uint8Array): SavFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === '$FL3') throw new Error('Sıkıştırılmış (zsav) dosyalar desteklenmiyor.');
  if (magic !== '$FL2') throw new Error('Bu dosya bir SPSS .sav dosyası değil.');
  const layout = dv.getInt32(64, true);
  if (layout !== 2 && layout !== 3) throw new Error('Desteklenmeyen .sav bayt düzeni.');
  const compressionCode = dv.getInt32(72, true);
  if (compressionCode !== 0 && compressionCode !== 1) throw new Error('Desteklenmeyen .sav sıkıştırması.');
  const headerCases = dv.getInt32(NCASES_OFFSET, true);
  const bias = dv.getFloat64(84, true);

  const rawVars: { width: number; shortName: string }[] = [];
  let longNames = new Map<string, string>();
  let ncases64Offset = -1;
  let ncases64 = -1;

  let o = HEADER_SIZE;
  for (;;) {
    const type = dv.getInt32(o, true);
    if (type === 2) {
      const width = dv.getInt32(o + 4, true);
      const hasLabel = dv.getInt32(o + 8, true);
      const nMissing = dv.getInt32(o + 12, true);
      const shortName = decode1254(bytes.subarray(o + 24, o + 32)).trimEnd();
      let p = o + 32;
      if (hasLabel) {
        const len = dv.getInt32(p, true);
        p += 4 + Math.ceil(len / 4) * 4;
      }
      p += Math.abs(nMissing) * 8;
      if (width !== -1) rawVars.push({ width, shortName });
      o = p;
    } else if (type === 3) {
      const n = dv.getInt32(o + 4, true);
      let p = o + 8;
      for (let i = 0; i < n; i++) {
        p += 8;
        const len = bytes[p];
        p += Math.ceil((len + 1) / 8) * 8;
      }
      o = p;
    } else if (type === 4) {
      o += 8 + 4 * dv.getInt32(o + 4, true);
    } else if (type === 6) {
      o += 8 + 80 * dv.getInt32(o + 4, true);
    } else if (type === 7) {
      const subtype = dv.getInt32(o + 4, true);
      const size = dv.getInt32(o + 8, true);
      const count = dv.getInt32(o + 12, true);
      const data = o + 16;
      if (subtype === 13) {
        longNames = parseLongNames(decode1254(bytes.subarray(data, data + size * count)));
      } else if (subtype === 14) {
        throw new Error('255 karakterden uzun metin değişkenleri desteklenmiyor.');
      } else if (subtype === 16 && size === 8 && count === 2) {
        ncases64Offset = data + 8 - HEADER_SIZE;
        ncases64 = Number(dv.getBigInt64(data + 8, true));
      }
      o = data + size * count;
    } else if (type === 999) {
      o += 8;
      break;
    } else {
      throw new Error(`Bozuk .sav sözlüğü (kayıt tipi ${type}).`);
    }
  }

  const variables: SavVariable[] = rawVars.map((v) => ({
    shortName: v.shortName,
    name: longNames.get(v.shortName) ?? v.shortName,
    width: v.width,
    slots: v.width === 0 ? 1 : Math.ceil(v.width / 8),
  }));

  const ncases = headerCases >= 0 ? headerCases : ncases64;
  const rows =
    compressionCode === 1
      ? readCompressed(bytes, dv, o, variables, bias, ncases)
      : readUncompressed(bytes, dv, o, variables, ncases);

  return {
    header: bytes.slice(0, HEADER_SIZE),
    dictionary: bytes.slice(HEADER_SIZE, o),
    ncases64Offset,
    compression: compressionCode,
    bias,
    variables,
    rows,
  };
}

function parseLongNames(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of text.split('\t')) {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

/** Splits a stream of 8-byte slots into rows of cells. */
class RowBuilder {
  rows: Cell[][] = [];
  private row: Cell[] = [];
  private varIdx = 0;
  private strBuf: Uint8Array[] = [];
  private readonly variables: SavVariable[];
  constructor(variables: SavVariable[]) {
    this.variables = variables;
  }

  get atRowStart() {
    return this.varIdx === 0 && this.strBuf.length === 0;
  }

  get currentIsNumeric() {
    return this.variables[this.varIdx].width === 0;
  }

  pushNumber(v: number) {
    this.row.push(v === SYSMIS ? null : v);
    this.advance();
  }

  pushString(chunk: Uint8Array) {
    const v = this.variables[this.varIdx];
    this.strBuf.push(chunk);
    if (this.strBuf.length === v.slots) {
      const all = new Uint8Array(v.slots * 8);
      this.strBuf.forEach((c, i) => all.set(c, i * 8));
      this.row.push(decode1254(all.subarray(0, v.width)).trimEnd());
      this.strBuf = [];
      this.advance();
    }
  }

  private advance() {
    this.varIdx++;
    if (this.varIdx === this.variables.length) {
      this.rows.push(this.row);
      this.row = [];
      this.varIdx = 0;
    }
  }
}

const SPACES8 = new Uint8Array(8).fill(0x20);

function readCompressed(
  bytes: Uint8Array,
  dv: DataView,
  start: number,
  variables: SavVariable[],
  bias: number,
  ncases: number,
): Cell[][] {
  const rb = new RowBuilder(variables);
  let o = start;
  outer: while (o + 8 <= bytes.length) {
    if (ncases >= 0 && rb.rows.length >= ncases && rb.atRowStart) break;
    const block = bytes.subarray(o, o + 8);
    o += 8;
    for (const code of block) {
      if (ncases >= 0 && rb.rows.length >= ncases && rb.atRowStart) break outer;
      if (code === 0) continue;
      if (code === 252) break outer;
      if (code === 253) {
        const raw = bytes.subarray(o, o + 8);
        if (rb.currentIsNumeric) rb.pushNumber(dv.getFloat64(o, true));
        else rb.pushString(raw);
        o += 8;
      } else if (code === 254) {
        if (rb.currentIsNumeric) throw new Error('Bozuk .sav verisi (254 sayısal alanda).');
        rb.pushString(SPACES8);
      } else if (code === 255) {
        if (!rb.currentIsNumeric) throw new Error('Bozuk .sav verisi (255 metin alanında).');
        rb.pushNumber(SYSMIS);
      } else {
        if (!rb.currentIsNumeric) throw new Error('Bozuk .sav verisi (sayı kodu metin alanında).');
        rb.pushNumber(code - bias);
      }
    }
  }
  if (!rb.atRowStart) throw new Error('Bozuk .sav verisi (yarım satır).');
  return rb.rows;
}

function readUncompressed(
  bytes: Uint8Array,
  dv: DataView,
  start: number,
  variables: SavVariable[],
  ncases: number,
): Cell[][] {
  const rb = new RowBuilder(variables);
  let o = start;
  while (o + 8 <= bytes.length) {
    if (ncases >= 0 && rb.rows.length >= ncases && rb.atRowStart) break;
    if (rb.currentIsNumeric) rb.pushNumber(dv.getFloat64(o, true));
    else rb.pushString(bytes.subarray(o, o + 8));
    o += 8;
  }
  return rb.rows;
}

/** Encodes a string cell to the variable's full slot width, space padded. */
export function encodeStringCell(value: string, variable: SavVariable): Uint8Array {
  const out = new Uint8Array(variable.slots * 8).fill(0x20);
  const enc = encode1254(value);
  if (enc.length > variable.width) {
    throw new Error(`"${value}" değeri ${variable.name} kolonuna sığmıyor (en fazla ${variable.width}).`);
  }
  out.set(enc);
  return out;
}

/** True if the value can be stored in the given string variable. */
export function fitsStringVariable(value: string, variable: SavVariable): boolean {
  const enc = tryEncode1254(value);
  return enc !== null && enc.length <= variable.width;
}

class ByteSink {
  private chunks: Uint8Array[] = [];
  private cur = new Uint8Array(1 << 16);
  private pos = 0;
  length = 0;

  write(b: Uint8Array) {
    if (this.pos + b.length > this.cur.length) {
      this.chunks.push(this.cur.subarray(0, this.pos));
      this.cur = new Uint8Array(Math.max(1 << 16, b.length));
      this.pos = 0;
    }
    this.cur.set(b, this.pos);
    this.pos += b.length;
    this.length += b.length;
  }

  finish(): Uint8Array {
    this.chunks.push(this.cur.subarray(0, this.pos));
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function float64Bytes(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return b;
}

function isSpaces(b: Uint8Array) {
  for (let i = 0; i < 8; i++) if (b[i] !== 0x20) return false;
  return true;
}

export function writeSav(sav: SavFile): Uint8Array {
  const sink = new ByteSink();
  const ncases = sav.rows.length;

  const header = sav.header.slice();
  new DataView(header.buffer).setInt32(NCASES_OFFSET, ncases, true);
  sink.write(header);

  const dict = sav.dictionary.slice();
  if (sav.ncases64Offset >= 0) {
    new DataView(dict.buffer).setBigInt64(sav.ncases64Offset, BigInt(ncases), true);
  }
  sink.write(dict);

  // Each row becomes a sequence of 8-byte slots: either a number or a string chunk.
  const forEachSlot = (row: Cell[], fn: (num: number | null, str: Uint8Array | null) => void) => {
    sav.variables.forEach((v, i) => {
      const cell = row[i];
      if (v.width === 0) {
        fn(cell === null || cell === undefined ? SYSMIS : (cell as number), null);
      } else {
        const full = encodeStringCell(cell === null || cell === undefined ? '' : String(cell), v);
        for (let s = 0; s < v.slots; s++) fn(null, full.subarray(s * 8, s * 8 + 8));
      }
    });
  };

  if (sav.compression === 0) {
    for (const row of sav.rows) {
      forEachSlot(row, (num, str) => sink.write(str ?? float64Bytes(num!)));
    }
    return sink.finish();
  }

  const bias = sav.bias;
  let codes = new Uint8Array(8);
  let nCodes = 0;
  let pending: Uint8Array[] = [];
  const flush = () => {
    sink.write(codes);
    for (const p of pending) sink.write(p);
    codes = new Uint8Array(8);
    nCodes = 0;
    pending = [];
  };
  const emit = (code: number, raw?: Uint8Array) => {
    codes[nCodes++] = code;
    if (raw) pending.push(raw);
    if (nCodes === 8) flush();
  };

  for (const row of sav.rows) {
    forEachSlot(row, (num, str) => {
      if (str) {
        if (isSpaces(str)) emit(254);
        else emit(253, str);
      } else if (num === SYSMIS) {
        emit(255);
      } else if (Number.isInteger(num) && !Object.is(num, -0) && num! + bias >= 1 && num! + bias <= 251) {
        emit(num! + bias);
      } else {
        emit(253, float64Bytes(num!));
      }
    });
  }
  if (nCodes > 0) flush();
  return sink.finish();
}

export function findVariable(sav: SavFile, name: string): number {
  const n = name.normalize('NFC');
  return sav.variables.findIndex((v) => v.name.normalize('NFC') === n);
}
