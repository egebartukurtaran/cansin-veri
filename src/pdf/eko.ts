import { ECHO_COLUMNS, ECHO_FINDINGS, normalizeName } from '../mapping';
import { parseDate, parseTrNumber } from '../util';
import { findExact, findItems, lines, lineText, sameRow, valueRightOf } from './layout';
import type { Observation, PatientInfo, ReportResult, TextItem } from './types';

export function isEkoReport(items: TextItem[]): boolean {
  const has = (t: string) => findItems(items, (s) => s.toLocaleLowerCase('tr').includes(t)).length > 0;
  return has('kardiyoloji sonuç raporu') && has('transtorasik ekokardiyografi');
}

/** Labels in the left half of the header end before the right-hand labels (x≈300). */
const LEFT_BLOCK_MAX_X = 295;

function headerValue(items: TextItem[], label: string): string {
  const l = findExact(items, label).sort((a, b) => a.page - b.page)[0];
  if (!l) return '';
  return valueRightOf(items, l, l.x < LEFT_BLOCK_MAX_X ? LEFT_BLOCK_MAX_X : Infinity);
}

/** Findings table: returns the BULGU cell for each parameter name (both halves of the table). */
function readFindings(items: TextItem[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const bulgu = findExact(items, 'BULGU');
  const normal = findExact(items, 'NORMAL')[0];
  if (bulgu.length === 0 || !normal) return out;
  const split = (Math.min(...bulgu.map((b) => b.x)) + Math.max(...bulgu.map((b) => b.x))) / 2;
  const leftBulgu = median(bulgu.filter((b) => b.x < split).map((b) => b.x));
  const rightBulgu = median(bulgu.filter((b) => b.x >= split).map((b) => b.x));

  // Column ranges derived from header positions.
  const leftNameMaxX = normal.x - 50;
  const leftValue: [number, number] = [leftBulgu - 25, leftBulgu + 40];
  const rightName: [number, number] = [leftBulgu + 40, rightBulgu - 25];
  const rightValue: [number, number] = [rightBulgu - 25, Infinity];
  const inRange = (x: number, [a, b]: [number, number]) => x >= a && x < b;

  const add = (name: string, value: string) => {
    const key = normalizeName(name);
    out.set(key, [...(out.get(key) ?? []), normalizeName(value)]);
  };

  const page = normal.page;
  for (const name of items.filter((it) => it.page === page && it.y < normal.y - 3)) {
    const row = sameRow(items, name);
    const cell = (range: [number, number]) =>
      row
        .filter((it) => inRange(it.x, range))
        .map((it) => it.str)
        .join(' ');
    if (name.x < leftNameMaxX) add(name.str, cell(leftValue));
    else if (inRange(name.x, rightName)) add(name.str, cell(rightValue));
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Free text under the "Sonuç" heading (page 2). */
function readConclusion(items: TextItem[]): string {
  const heading = findExact(items, 'Sonuç')[0];
  if (!heading) return '';
  const below = lines(items.filter((it) => it.page === heading.page && it.y < heading.y - 2));
  const text: string[] = [];
  let lastY = heading.y;
  for (const l of below) {
    if (lastY - l[0].y > 18 || l[0].x > heading.x + 30) break;
    text.push(lineText(l));
    lastY = l[0].y;
  }
  return text.join(' ');
}

/** All distinct numeric captures of `re` in text; one unique value is required. */
function uniqueMatch(text: string, re: RegExp): { value: number | null; raw: string; warning?: string } | null {
  const found = [...text.matchAll(re)];
  if (found.length === 0) return null;
  const values = [...new Set(found.map((m) => m[1].replace('.', ',')))];
  const raw = found.map((m) => m[0]).join(' / ');
  if (values.length > 1) return { value: null, raw, warning: 'Sonuç metninde birden fazla farklı değer var' };
  const value = parseTrNumber(values[0]);
  return value === null ? { value: null, raw, warning: 'Sayı okunamadı' } : { value, raw };
}

export function parseEko(items: TextItem[], fileName: string): ReportResult {
  const fail = (reason: string): ReportResult => ({ kind: 'unknown', fileName, reason });

  const fileNo = headerValue(items, 'Protokol Numarası');
  if (!/^\d+$/.test(fileNo)) return fail(`Protokol numarası okunamadı ("${fileNo}")`);
  const date = parseDate(headerValue(items, 'Çekim Tarihi'));
  if (!date) return fail('Çekim tarihi okunamadı');
  const sexText = headerValue(items, 'Cinsiyet');
  const patient: PatientInfo = {
    name: headerValue(items, 'Hastanın Adı Soyadı'),
    fileNo,
    birth: parseDate(headerValue(items, 'Doğum Tarihi')),
    sex: sexText === 'Kadın' ? 1 : sexText === 'Erkek' ? 2 : null,
  };

  const findings = readFindings(items);
  const conclusion = readConclusion(items);
  const observations: Observation[] = [];

  const finding = (key: keyof typeof ECHO_FINDINGS): string | null | undefined => {
    const vals = findings.get(normalizeName(ECHO_FINDINGS[key]));
    if (!vals) return undefined;
    const nonEmpty = [...new Set(vals.filter((v) => v !== ''))];
    if (nonEmpty.length > 1) return null; // ambiguous
    return nonEmpty[0] ?? '';
  };

  const pushFinding = (
    key: keyof typeof ECHO_FINDINGS,
    column: string,
    convert: (raw: string) => number | null,
  ): boolean => {
    const raw = finding(key);
    if (raw === undefined || raw === '') return false;
    const obs: Observation = { column, value: null, raw: raw ?? '', source: ECHO_FINDINGS[key], warnings: [] };
    if (raw === null) obs.warnings.push('Birden fazla farklı değer bulundu');
    else {
      obs.value = convert(raw);
      if (obs.value === null) obs.warnings.push(`"${raw}" sayı olarak okunamadı, yazılmadı`);
    }
    observations.push(obs);
    return true;
  };

  pushFinding('ef', ECHO_COLUMNS.ef, (r) => parseTrNumber(r.replace(/^%\s*|\s*%$/g, '')));
  pushFinding('leftAtrium', ECHO_COLUMNS.leftAtrium, (r) => parseTrNumber(r.replace(/\s*cm$/i, '')));
  pushFinding('ea', ECHO_COLUMNS.ea, (r) => {
    const s = r.replace(/\s+/g, '');
    if (s === '<1') return 0;
    if (s === '>1') return 1;
    const n = parseTrNumber(s);
    if (n === null || n === 1) return null;
    return n < 1 ? 0 : 1;
  });
  const hasPab = pushFinding('pab', ECHO_COLUMNS.pab, (r) => {
    const m = /^(\d+(?:,\d+)?)\s*(?:mmHg)?$/i.exec(r);
    return m ? parseTrNumber(m[1]) : null;
  });

  const fromText = (column: string, source: string, re: RegExp) => {
    const m = uniqueMatch(conclusion, re);
    if (!m) return;
    observations.push({
      column,
      value: m.value,
      raw: m.raw,
      source: `Sonuç metni (${source})`,
      warnings: m.warning ? [m.warning] : [],
    });
  };

  if (!hasPab) fromText(ECHO_COLUMNS.pab, 'PAB', /\bPAB\s*:?\s*(\d+(?:[.,]\d+)?)/gi);
  fromText(ECHO_COLUMNS.tapse, 'TAPSE', /\bTAPSE\s*:?\s*(\d+(?:[.,]\d+)?)\s*mm\b/gi);
  fromText(ECHO_COLUMNS.ivc, 'IVC', /\b(?:IVC|VCI)\s*:?\s*(\d+(?:[.,]\d+)?)\s*mm\b/gi);

  const collapse = [...conclusion.matchAll(/%\s*50\s*['’`]?\s*d[ae]n\s+(fazla|az)\s+kollabe/gi)];
  if (collapse.length > 0) {
    const kinds = new Set(collapse.map((m) => m[1].toLocaleLowerCase('tr')));
    observations.push({
      column: ECHO_COLUMNS.ivcCollapse,
      value: kinds.size === 1 ? (kinds.has('fazla') ? 1 : 0) : null,
      raw: collapse.map((m) => m[0]).join(' / '),
      source: 'Sonuç metni (kollabe)',
      warnings: kinds.size === 1 ? [] : ['Metinde çelişkili ifade var'],
    });
  }

  return { kind: 'eko', fileName, patient, date, observations };
}
