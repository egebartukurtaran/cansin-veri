import { COLUMN_ALIASES, DEMOGRAPHIC_COLUMNS } from './mapping';
import type { FailedReport, ParsedReport, ReportResult } from './pdf/types';
import { fitsStringVariable, type Cell, type SavFile } from './sav/sav';
import { ageAt, dateKey, formatDate, formatNumber, type ReportDate } from './util';

/** override = a Word value replaces a different value already in the list (user can untick). */
export type Status = 'write' | 'override' | 'same' | 'conflict' | 'skip';

export interface Change {
  /** Column name as it exists in the list (or the requested name if it does not exist). */
  column: string;
  current: Cell;
  proposed: number | string | null;
  source: string;
  fileName: string;
  date: ReportDate | null;
  status: Status;
  /** Only meaningful for 'override': whether the user keeps it ticked (default true). */
  selected: boolean;
  messages: string[];
}

export interface PatientPlan {
  fileNo: string;
  name: string;
  isNew: boolean;
  rowIndex: number | null;
  messages: string[];
  /** Word lines that were not understood (nothing written from them). */
  unrecognized: string[];
  changes: Change[];
}

export interface Plan {
  patients: PatientPlan[];
  failed: FailedReport[];
  summary: Summary;
}

export interface Summary {
  patients: number;
  /** New values plus ticked overrides. */
  toWrite: number;
  overrides: number;
  conflicts: number;
  warnings: number;
  unrecognized: number;
}

interface Candidate {
  column: string;
  value: number | string | null;
  raw: string;
  source: string;
  fileName: string;
  /** null for sources without a date (Word notes). */
  date: ReportDate | null;
  warnings: string[];
  /** From a Word note: checked by hand, so it takes precedence (see resolve). */
  fromWord: boolean;
  /** Inferred value that may only fill an empty cell. */
  onlyIfEmpty?: boolean;
}

const trUpper = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleUpperCase('tr');

export function displayValue(v: Cell | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  return typeof v === 'number' ? formatNumber(v) : v;
}

function isEmpty(c: Cell | undefined) {
  return c === null || c === undefined || (typeof c === 'string' && c.trim() === '');
}

function sameValue(a: Cell, b: number | string): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  // Text: "ht, dm" and "HT, DM" mean the same thing.
  return trUpper(String(a)) === trUpper(String(b));
}

function cellKey(v: number | string): string {
  return typeof v === 'number' ? String(v) : v.trim();
}

function describe(c: Candidate) {
  return c.date ? `${formatDate(c.date)}, ${c.fileName}` : c.fileName;
}

/**
 * Index of a column in the list: exact name, then case-insensitive, then known aliases
 * (columns renamed over time, e.g. AKŞ → glukoz).
 */
export function findColumn(sav: SavFile, name: string): number {
  const names = sav.variables.map((v) => v.name.normalize('NFC'));
  const lookup = (n: string) => {
    const exact = names.indexOf(n.normalize('NFC'));
    if (exact >= 0) return exact;
    const l = n.normalize('NFC').toLocaleLowerCase('tr');
    return names.findIndex((x) => x.toLocaleLowerCase('tr') === l);
  };
  const direct = lookup(name);
  if (direct >= 0) return direct;
  const lname = name.normalize('NFC').toLocaleLowerCase('tr');
  const group = COLUMN_ALIASES.find((g) => g.some((a) => a.normalize('NFC').toLocaleLowerCase('tr') === lname));
  for (const alias of group ?? []) {
    const i = lookup(alias);
    if (i >= 0) return i;
  }
  return -1;
}

function resolve(column: string, cands: Candidate[], sav: SavFile, current: Cell): Change {
  // Word notes are checked by hand: when they give a readable value, they win over PDFs and
  // over the list (shown as an 'override' the user can untick).
  const explicit = cands.filter((c) => c.fromWord && c.value !== null && !c.onlyIfEmpty);
  const inferred = cands.filter((c) => c.fromWord && c.value !== null && c.onlyIfEmpty);
  if (explicit.length === 0 && inferred.length > 0 && !isEmpty(current)) {
    // e.g. "HT not in the comorbidity line" must not turn an existing HT=1 into 0.
    const change = resolveDated(column, inferred, sav, current);
    if (change.status === 'conflict') {
      change.status = 'skip';
      change.messages = [`Word’de geçmediği için 0 çıkarıldı; listedeki ${displayValue(current)} korunuyor`];
    }
    return change;
  }
  const word = explicit.length > 0 ? explicit : inferred;
  if (word.length > 0) {
    const change = resolveDated(column, word, sav, current);
    const others = cands.filter((c) => !c.fromWord && c.value !== null);
    if (others.length > 0 && change.proposed !== null) {
      const pdf = resolveDated(column, others, sav, null);
      if (pdf.proposed !== null && !sameValue(pdf.proposed, change.proposed)) {
        change.messages.push(`PDF'te ${displayValue(pdf.proposed)} (${pdf.fileName}) — Word'deki değer esas alındı`);
      }
    }
    if (change.status === 'conflict' && change.proposed !== null) {
      // Differs from the list only (Word sources agree among themselves).
      change.status = 'override';
      change.messages = change.messages.filter((m) => !m.startsWith('Çakışma:'));
      change.messages.unshift(`Listede ${displayValue(current)} → Word'deki ${displayValue(change.proposed)} yazılacak`);
    }
    return change;
  }
  const nonWord = cands.filter((c) => !c.fromWord);
  return resolveDated(column, nonWord.length > 0 ? nonWord : cands, sav, current);
}

function resolveDated(column: string, cands: Candidate[], sav: SavFile, current: Cell): Change {
  // Dated sources: only the most recent date counts. Undated (Word) values are compared
  // against that; any disagreement is a conflict.
  const dated = cands.filter((c) => c.date !== null);
  const latestKey = dated.length ? Math.max(...dated.map((c) => dateKey(c.date!))) : null;
  const latest = [...dated.filter((c) => dateKey(c.date!) === latestKey), ...cands.filter((c) => c.date === null)];
  const head = latest[0];
  const change: Change = {
    column,
    current,
    proposed: null,
    source: [...new Set(latest.map((c) => c.source))].join(', '),
    fileName: [...new Set(latest.map((c) => c.fileName))].join(', '),
    date: latest.find((c) => c.date)?.date ?? null,
    status: 'skip',
    selected: true,
    messages: [...new Set(latest.flatMap((c) => c.warnings))],
  };

  const varIdx = findColumn(sav, column);
  if (varIdx < 0) {
    change.messages.push(`Listede "${column}" kolonu yok`);
    return change;
  }
  change.column = sav.variables[varIdx].name;

  if (latest.some((c) => c.value === null)) {
    if (latest.length > 1 && latest.some((c) => c.value !== null)) {
      change.messages.push('Kaynaklardan biri okunamadı');
    }
    return change;
  }

  const distinct = new Map<string, Candidate>();
  for (const c of latest) {
    const key = typeof c.value === 'string' ? trUpper(c.value) : cellKey(c.value!);
    distinct.set(key, c);
  }
  if (distinct.size > 1) {
    change.status = 'conflict';
    change.messages.push(
      'Kaynaklar farklı değer veriyor: ' +
        [...distinct.values()].map((c) => `${displayValue(c.value)} (${describe(c)})`).join(' / '),
    );
    return change;
  }

  let value = head.value!;
  const variable = sav.variables[varIdx];
  if (variable.width > 0) {
    value = typeof value === 'number' ? String(value) : value;
    if (!fitsStringVariable(value, variable)) {
      change.messages.push(`Değer "${change.column}" kolonuna sığmıyor`);
      return change;
    }
  } else if (typeof value !== 'number') {
    change.messages.push(`"${change.column}" sayısal bir kolon, "${value}" yazılamaz`);
    return change;
  }
  change.proposed = value;

  if (isEmpty(current)) change.status = 'write';
  else if (sameValue(current, value)) change.status = 'same';
  else {
    change.status = 'conflict';
    change.messages.push(
      `Çakışma: listede ${displayValue(current)}, kaynakta ${displayValue(value)} (${describe(head)})`,
    );
  }
  return change;
}

function findRows(sav: SavFile, column: string, value: string, normalize: (s: string) => string): number[] {
  const idx = findColumn(sav, column);
  if (idx < 0 || !value) return [];
  const want = normalize(value);
  const out: number[] = [];
  sav.rows.forEach((r, i) => {
    const v = r[idx];
    if (v !== null && v !== undefined && normalize(String(v)) === want) out.push(i);
  });
  return out;
}

const byFileNo = (sav: SavFile, fileNo: string) =>
  findRows(sav, DEMOGRAPHIC_COLUMNS.fileNo, fileNo, (s) => s.trim());
const byName = (sav: SavFile, name: string) => findRows(sav, DEMOGRAPHIC_COLUMNS.name, name, trUpper);

function demographicCandidates(reports: ParsedReport[], messages: string[]): Candidate[] {
  const out: Candidate[] = [];
  const base = (r: ParsedReport) => ({ fileName: r.fileName, date: r.date, warnings: [] as string[], fromWord: r.kind === 'word' });

  for (const r of reports) {
    if (r.patient.name) {
      out.push({ ...base(r), column: DEMOGRAPHIC_COLUMNS.name, value: r.patient.name, raw: r.patient.name, source: 'Ad Soyad' });
    }
  }

  // Sex and birth date must agree across all reports of this patient.
  const sexes = new Set(reports.map((r) => r.patient.sex).filter((s) => s !== null));
  if (sexes.size === 1) {
    const r = reports.find((r) => r.patient.sex !== null)!;
    const sex = r.patient.sex!;
    out.push({ ...base(r), column: DEMOGRAPHIC_COLUMNS.sex, value: sex, raw: sex === 1 ? 'K' : 'E', source: 'Cinsiyet' });
  } else if (sexes.size > 1) {
    messages.push('Kaynaklarda cinsiyet farklı görünüyor; cinsiyet yazılmadı');
  }

  const births = new Map<number, ReportDate>();
  for (const r of reports) if (r.patient.birth) births.set(dateKey(r.patient.birth), r.patient.birth);
  const datedReports = reports.filter((r) => r.date !== null);
  if (births.size > 1) {
    messages.push('Raporlarda doğum tarihi farklı görünüyor; yaş hesaplanmadı');
  } else if (births.size === 1 && datedReports.length > 0) {
    const birth = [...births.values()][0];
    // Age at the most recent lab sample; echo date only if there is no lab report.
    const labs = datedReports.filter((r) => r.kind === 'lab');
    const pool = labs.length > 0 ? labs : datedReports;
    const ref = pool.reduce((a, b) => (dateKey(b.date!) > dateKey(a.date!) ? b : a));
    out.push({
      ...base(ref),
      column: DEMOGRAPHIC_COLUMNS.age,
      value: ageAt(birth, ref.date!),
      raw: formatDate(birth, false),
      source: `Doğum tarihi ${formatDate(birth, false)}`,
    });
  }
  return out;
}

interface Group {
  fileNo: string;
  rows: number[];
  reports: ParsedReport[];
  messages: string[];
}

/** Assigns every report to a patient: by file number, or (Word without one) by unique name. */
function groupReports(sav: SavFile, parsed: ParsedReport[]): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, fileNo: string, rows: number[], r: ParsedReport, message?: string) => {
    const g = groups.get(key) ?? { fileNo, rows, reports: [], messages: [] };
    if (!g.fileNo && fileNo) g.fileNo = fileNo;
    g.reports.push(r);
    if (message && !g.messages.includes(message)) g.messages.push(message);
    groups.set(key, g);
  };

  for (const r of parsed) {
    if (r.patient.fileNo) {
      const rows = byFileNo(sav, r.patient.fileNo);
      add(rows.length === 1 ? `row:${rows[0]}` : `no:${r.patient.fileNo}`, r.patient.fileNo, rows, r);
      continue;
    }
    const rows = byName(sav, r.patient.name);
    if (rows.length === 1) {
      add(`row:${rows[0]}`, '', rows, r, `"${r.fileName}" dosyasında Dosya No yok; hasta listedeki isimle eşleştirildi`);
    } else {
      add(
        `name:${trUpper(r.patient.name)}`,
        '',
        rows,
        r,
        rows.length === 0
          ? 'Dosya No yok ve listede bu isimde hasta bulunamadı; yeni hasta eklemek için Word’e "Dosya No: ..." satırı ekleyin. Hiçbir değer yazılmadı'
          : `Dosya No yok ve listede bu isimde ${rows.length} hasta var; Word’e "Dosya No: ..." satırı ekleyin. Hiçbir değer yazılmadı`,
      );
    }
  }
  // A group keyed by name may belong to a row that another report found by file number.
  for (const g of groups.values()) {
    if (g.fileNo && g.rows.length === 0) g.rows = byFileNo(sav, g.fileNo);
  }
  return [...groups.values()];
}

export function buildPlan(sav: SavFile, results: ReportResult[]): Plan {
  const failed = results.filter((r): r is FailedReport => r.kind === 'unknown');
  const parsed = results.filter((r): r is ParsedReport => r.kind !== 'unknown');

  const patients: PatientPlan[] = [];
  for (const { fileNo, rows, reports, messages } of groupReports(sav, parsed)) {
    const rowIndex = rows.length === 1 ? rows[0] : null;
    const isNew = rows.length === 0 && fileNo !== '';
    const blocked = rows.length > 1 || (rows.length === 0 && fileNo === '');
    const dated = reports.filter((r) => r.date !== null);
    const latestReport = dated.length
      ? dated.reduce((a, b) => (dateKey(b.date!) > dateKey(a.date!) ? b : a))
      : reports[0];

    const cands: Candidate[] = demographicCandidates(reports, messages);
    for (const r of reports) {
      for (const o of r.observations) {
        cands.push({
          column: o.column, value: o.value, raw: o.raw, source: o.source, fileName: r.fileName, date: r.date,
          warnings: o.warnings, fromWord: r.kind === 'word', onlyIfEmpty: o.onlyIfEmpty,
        });
      }
    }

    const byColumn = new Map<number | string, { column: string; cands: Candidate[] }>();
    for (const c of cands) {
      const idx = findColumn(sav, c.column);
      const key = idx >= 0 ? idx : c.column;
      const entry = byColumn.get(key) ?? { column: c.column, cands: [] };
      entry.cands.push(c);
      byColumn.set(key, entry);
    }

    const changes: Change[] = [];
    if (isNew) {
      changes.push({
        column: DEMOGRAPHIC_COLUMNS.fileNo,
        current: null,
        proposed: fileNo,
        source: 'Dosya No',
        fileName: latestReport.fileName,
        date: latestReport.date,
        status: 'write',
        selected: true,
        messages: [],
      });
    }
    for (const [key, { column, cands: cs }] of byColumn) {
      const current = rowIndex !== null && typeof key === 'number' ? sav.rows[rowIndex][key] : null;
      changes.push(resolve(column, cs, sav, current));
    }

    if (rows.length > 1 && fileNo) {
      messages.push(`Bu dosya numarası listede ${rows.length} satırda var; hiçbir değer yazılmadı`);
    }
    if (blocked) {
      for (const c of changes) if (c.status === 'write' || c.status === 'override') c.status = 'skip';
    }

    const nameIdx = findColumn(sav, DEMOGRAPHIC_COLUMNS.name);
    const existingName = rowIndex !== null && nameIdx >= 0 ? displayValue(sav.rows[rowIndex][nameIdx]) : '';
    const fileNoIdx = findColumn(sav, DEMOGRAPHIC_COLUMNS.fileNo);
    const existingFileNo = rowIndex !== null && fileNoIdx >= 0 ? displayValue(sav.rows[rowIndex][fileNoIdx]) : '';
    patients.push({
      fileNo: fileNo || existingFileNo,
      name: latestReport.patient.name || existingName,
      isNew,
      rowIndex,
      messages,
      unrecognized: [...new Set(reports.flatMap((r) => r.unrecognized ?? []))],
      changes,
    });
  }

  const plan: Plan = { patients, failed, summary: summarize(patients, failed.length) };
  return plan;
}

/** Recomputes the summary (call again after the user ticks / unticks overrides). */
export function summarize(patients: PatientPlan[], unrecognized: number): Summary {
  const all = patients.flatMap((p) => p.changes);
  return {
    patients: patients.length,
    toWrite: all.filter(willWrite).length,
    overrides: all.filter((c) => c.status === 'override').length,
    conflicts: all.filter((c) => c.status === 'conflict').length,
    warnings: all.filter((c) => c.status === 'skip' || (c.status === 'write' && c.messages.length > 0)).length,
    unrecognized,
  };
}

export function willWrite(c: Change): boolean {
  return c.status === 'write' || (c.status === 'override' && c.selected);
}

/** Returns a new SavFile with all 'write' changes applied. The input is not modified. */
export function applyPlan(sav: SavFile, plan: Plan): SavFile {
  const rows = sav.rows.map((r) => [...r]);
  const emptyRow = (): Cell[] => sav.variables.map((v) => (v.width === 0 ? null : ''));

  for (const p of plan.patients) {
    const writes = p.changes.filter(willWrite);
    if (writes.length === 0) continue;
    let row: Cell[];
    if (p.isNew) {
      row = emptyRow();
      rows.push(row);
    } else if (p.rowIndex !== null) {
      row = rows[p.rowIndex];
    } else continue;
    for (const c of writes) {
      const idx = findColumn(sav, c.column);
      if (idx >= 0 && c.proposed !== null) row[idx] = c.proposed;
    }
  }
  return { ...sav, rows };
}
