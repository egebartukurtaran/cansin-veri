import { findLabMapping, normalizeName } from '../mapping';
import { parseDate, parseTrNumber, type ReportDate } from '../util';
import { findExact, findItems, lines, lineText, valueRightOf } from './layout';
import type { Observation, PatientInfo, ReportResult, TextItem } from './types';

const TITLE = 'TIBBİ LABORATUVAR TETKİK SONUÇ RAPORU';
/** Right edge of the patient block (the "Rapor No" box starts at ~x=400). */
const PATIENT_BLOCK_MAX_X = 395;

export function isLabReport(items: TextItem[]): boolean {
  return findItems(items, (s) => s.toLocaleUpperCase('tr').includes(TITLE)).length > 0;
}

const startsWith = (prefix: string) => (s: string) => s.startsWith(prefix);

function readPatient(items: TextItem[], page: number): { patient: PatientInfo; date: ReportDate | null } | string {
  const onPage = items.filter((it) => it.page === page);
  const nameLabel = findItems(onPage, startsWith('Hastanın Adı, Soyadı'))[0];
  const birthLabel = findItems(onPage, startsWith('Doğum Tarihi, Cinsiyeti'))[0];
  const fileLabel = findItems(onPage, startsWith('Protokol / Dosya'))[0];
  if (!nameLabel || !birthLabel || !fileLabel) return 'Hasta bilgileri bulunamadı';

  const fileNo = valueRightOf(onPage, fileLabel, PATIENT_BLOCK_MAX_X);
  if (!/^\d+$/.test(fileNo)) return `Dosya numarası okunamadı ("${fileNo}")`;

  const name = valueRightOf(onPage, nameLabel, PATIENT_BLOCK_MAX_X);
  const birthText = valueRightOf(onPage, birthLabel, PATIENT_BLOCK_MAX_X);
  const bm = /^(\d{2}\/\d{2}\/\d{4})\s*\/\s*([KE])$/.exec(birthText);
  const birth = bm ? parseDate(bm[1]) : null;
  const sex = bm ? (bm[2] === 'K' ? 1 : 2) : null;

  // "Numune Alma Zamanı:" label with the date directly below it in the same column.
  // There are four timestamps in the header; picking by position, not by order.
  let date: ReportDate | null = null;
  const sampleLabel = findItems(onPage, startsWith('Numune Alma Zamanı'))[0];
  if (sampleLabel) {
    const inline = parseDate(normalizeName(sampleLabel.str).replace(/^Numune Alma Zamanı\s*:?/, ''));
    const below = onPage
      .filter(
        (it) =>
          Math.abs(it.x - sampleLabel.x) <= 8 &&
          it.y < sampleLabel.y - 2 &&
          it.y >= sampleLabel.y - 20 &&
          parseDate(it.str) !== null,
      )
      .sort((a, b) => b.y - a.y);
    date = inline ?? (below[0] ? parseDate(below[0].str) : null);
  }

  return { patient: { name, fileNo, birth, sex }, date };
}

interface Row {
  page: number;
  y: number;
  text: string;
  results: TextItem[];
  hemolysis: boolean;
}

export function parseLab(items: TextItem[], fileName: string): ReportResult {
  const fail = (reason: string): ReportResult => ({ kind: 'unknown', fileName, reason });
  const pages = [...new Set(items.map((it) => it.page))].sort((a, b) => a - b);

  const first = readPatient(items, pages[0]);
  if (typeof first === 'string') return fail(first);
  if (!first.date) return fail('Numune alma zamanı okunamadı');
  for (const p of pages.slice(1)) {
    const other = readPatient(items, p);
    if (typeof other !== 'string' && other.patient.fileNo !== first.patient.fileNo) {
      return fail('Sayfalarda farklı dosya numaraları var');
    }
  }

  // Column positions from the table header ("Test Adı | Sonuç | Durum | ...").
  const sonuc = findExact(items, 'Sonuç')[0];
  const durum = sonuc && findExact(items, 'Durum').find((d) => d.page === sonuc.page && Math.abs(d.y - sonuc.y) <= 3);
  if (!sonuc || !durum) return fail('Sonuç tablosu bulunamadı');
  const resultMinX = sonuc.x - 15;
  const resultMaxX = durum.x - 2;

  const rows: Row[] = [];
  for (const page of pages) {
    const onPage = items.filter((it) => it.page === page);
    const header = findExact(onPage, 'Test Adı')[0];
    const fileLabel = findItems(onPage, startsWith('Protokol / Dosya'))[0];
    const top = header ? header.y - 5 : fileLabel ? fileLabel.y - 5 : Infinity;
    const footer = findItems(onPage, startsWith('Tıbbi Laboratuvar Yorumu'))[0];
    const bottom = footer ? footer.y + 3 : -Infinity;
    const body = onPage.filter((it) => it.y < top && it.y > bottom && it.str.trim() !== '');

    const pageRows: Row[] = lines(body.filter((it) => it.x < resultMinX)).map((l) => ({
      page,
      y: l[0].y,
      text: lineText(l),
      results: [],
      hemolysis: false,
    }));

    for (const r of body.filter((it) => it.x >= resultMinX && it.x < resultMaxX)) {
      let best: Row | undefined;
      for (const row of pageRows) {
        const d = Math.abs(row.y - r.y);
        if (d <= 5 && (!best || d < Math.abs(best.y - r.y))) best = row;
      }
      best?.results.push(r);
    }
    rows.push(...pageRows);
  }

  // "Bu test hemolizden etkilenmiştir." belongs to the closest test row above it.
  rows.forEach((row, i) => {
    if (!/hemoliz/i.test(row.text)) return;
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].results.length > 0) {
        rows[j].hemolysis = true;
        break;
      }
    }
  });

  const observations: Observation[] = [];
  for (const row of rows) {
    const mapping = findLabMapping(row.text);
    if (!mapping) continue;
    const obs: Observation = { column: mapping.column, value: null, raw: '', source: row.text, warnings: [] };
    observations.push(obs);

    const ys = row.results.map((r) => r.y);
    if (row.results.length === 0) {
      obs.warnings.push('Sonuç okunamadı');
      continue;
    }
    if (Math.max(...ys) - Math.min(...ys) > 2) {
      obs.warnings.push('Sonuç satırı belirsiz');
      continue;
    }
    obs.raw = normalizeName(row.results.sort((a, b) => a.x - b.x).map((r) => r.str).join(' '));
    if (/^[<>]/.test(obs.raw)) {
      obs.warnings.push(`Sonuç "${obs.raw}" — kesin sayı değil, yazılmadı`);
      continue;
    }
    const value = parseTrNumber(obs.raw, mapping.scale ?? 0);
    if (value === null) {
      obs.warnings.push(`Sonuç sayı değil ("${obs.raw}"), yazılmadı`);
      continue;
    }
    obs.value = value;
    if (row.hemolysis) obs.warnings.push('Bu test hemolizden etkilenmiş');
  }

  return { kind: 'lab', fileName, patient: first.patient, date: first.date, observations };
}
