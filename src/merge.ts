import { DEMOGRAPHIC_COLUMNS } from './mapping';
import type { FailedReport, ParsedReport, ReportResult } from './pdf/types';
import { findVariable, fitsStringVariable, type Cell, type SavFile } from './sav/sav';
import { ageAt, dateKey, formatDate, formatNumber, type ReportDate } from './util';

export type Status = 'write' | 'same' | 'conflict' | 'skip';

export interface Change {
  column: string;
  current: Cell;
  proposed: number | string | null;
  source: string;
  fileName: string;
  date: ReportDate | null;
  status: Status;
  messages: string[];
}

export interface PatientPlan {
  fileNo: string;
  name: string;
  isNew: boolean;
  rowIndex: number | null;
  messages: string[];
  changes: Change[];
}

export interface Plan {
  patients: PatientPlan[];
  failed: FailedReport[];
  summary: { patients: number; toWrite: number; conflicts: number; warnings: number; unrecognized: number };
}

interface Candidate {
  column: string;
  value: number | string | null;
  raw: string;
  source: string;
  fileName: string;
  date: ReportDate;
  warnings: string[];
}

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
  return String(a).trim() === String(b).trim();
}

function cellKey(v: number | string): string {
  return typeof v === 'number' ? String(v) : v.trim();
}

function describe(c: Candidate) {
  return `${c.date ? formatDate(c.date) : '?'}, ${c.fileName}`;
}

function resolve(column: string, cands: Candidate[], sav: SavFile, current: Cell): Change {
  const latestKey = Math.max(...cands.map((c) => dateKey(c.date)));
  const latest = cands.filter((c) => dateKey(c.date) === latestKey);
  const head = latest[0];
  const change: Change = {
    column,
    current,
    proposed: null,
    source: [...new Set(latest.map((c) => c.source))].join(', '),
    fileName: [...new Set(latest.map((c) => c.fileName))].join(', '),
    date: head.date,
    status: 'skip',
    messages: [...new Set(latest.flatMap((c) => c.warnings))],
  };

  const varIdx = findVariable(sav, column);
  if (varIdx < 0) {
    change.messages.push(`Listede "${column}" kolonu yok`);
    return change;
  }

  if (latest.some((c) => c.value === null)) {
    if (latest.length > 1 && latest.some((c) => c.value !== null)) {
      change.messages.push('Aynı tarihli raporlardan biri okunamadı');
    }
    return change;
  }

  const distinct = new Map<string, Candidate>();
  for (const c of latest) distinct.set(cellKey(c.value!), c);
  if (distinct.size > 1) {
    change.status = 'conflict';
    change.messages.push(
      'Aynı tarihli raporlarda farklı değerler: ' +
        [...distinct.values()].map((c) => `${displayValue(c.value)} (${c.fileName})`).join(' / '),
    );
    return change;
  }

  let value = head.value!;
  const variable = sav.variables[varIdx];
  if (variable.width > 0) {
    value = typeof value === 'number' ? String(value) : value;
    if (!fitsStringVariable(value, variable)) {
      change.messages.push(`Değer "${column}" kolonuna sığmıyor`);
      return change;
    }
  } else if (typeof value !== 'number') {
    change.messages.push(`"${column}" sayısal bir kolon, "${value}" yazılamaz`);
    return change;
  }
  change.proposed = value;

  if (isEmpty(current)) change.status = 'write';
  else if (sameValue(current, value)) change.status = 'same';
  else {
    change.status = 'conflict';
    change.messages.push(
      `Çakışma: listede ${displayValue(current)}, PDF'te ${displayValue(value)} (${describe(head)})`,
    );
  }
  return change;
}

function findRows(sav: SavFile, fileNo: string): number[] {
  const idx = findVariable(sav, DEMOGRAPHIC_COLUMNS.fileNo);
  if (idx < 0) return [];
  const out: number[] = [];
  sav.rows.forEach((r, i) => {
    const v = r[idx];
    if (v !== null && v !== undefined && String(v).trim() === fileNo) out.push(i);
  });
  return out;
}

function demographicCandidates(reports: ParsedReport[], messages: string[]): Candidate[] {
  const out: Candidate[] = [];
  const base = (r: ParsedReport) => ({ fileName: r.fileName, date: r.date, warnings: [] as string[] });

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
    messages.push('Raporlarda cinsiyet farklı görünüyor; cinsiyet yazılmadı');
  }

  const births = new Map<number, ReportDate>();
  for (const r of reports) if (r.patient.birth) births.set(dateKey(r.patient.birth), r.patient.birth);
  if (births.size > 1) {
    messages.push('Raporlarda doğum tarihi farklı görünüyor; yaş yazılmadı');
  } else if (births.size === 1) {
    const birth = [...births.values()][0];
    // Age at the most recent lab sample; echo date only if there is no lab report.
    const labs = reports.filter((r) => r.kind === 'lab');
    const pool = labs.length > 0 ? labs : reports;
    const ref = pool.reduce((a, b) => (dateKey(b.date) > dateKey(a.date) ? b : a));
    out.push({
      ...base(ref),
      column: DEMOGRAPHIC_COLUMNS.age,
      value: ageAt(birth, ref.date),
      raw: formatDate(birth, false),
      source: `Doğum tarihi ${formatDate(birth, false)}`,
    });
  }
  return out;
}

export function buildPlan(sav: SavFile, results: ReportResult[]): Plan {
  const failed = results.filter((r): r is FailedReport => r.kind === 'unknown');
  const parsed = results.filter((r): r is ParsedReport => r.kind !== 'unknown');

  const byPatient = new Map<string, ParsedReport[]>();
  for (const r of parsed) byPatient.set(r.patient.fileNo, [...(byPatient.get(r.patient.fileNo) ?? []), r]);

  const patients: PatientPlan[] = [];
  for (const [fileNo, reports] of byPatient) {
    const messages: string[] = [];
    const rows = findRows(sav, fileNo);
    const rowIndex = rows.length === 1 ? rows[0] : null;
    const isNew = rows.length === 0;
    const latestReport = reports.reduce((a, b) => (dateKey(b.date) > dateKey(a.date) ? b : a));

    const cands: Candidate[] = demographicCandidates(reports, messages);
    for (const r of reports) {
      for (const o of r.observations) {
        cands.push({
          column: o.column,
          value: o.value,
          raw: o.raw,
          source: o.source,
          fileName: r.fileName,
          date: r.date,
          warnings: o.warnings,
        });
      }
    }

    const byColumn = new Map<string, Candidate[]>();
    for (const c of cands) byColumn.set(c.column, [...(byColumn.get(c.column) ?? []), c]);

    const changes: Change[] = [];
    if (isNew) {
      changes.push({
        column: DEMOGRAPHIC_COLUMNS.fileNo,
        current: null,
        proposed: fileNo,
        source: 'Protokol / Dosya No',
        fileName: latestReport.fileName,
        date: latestReport.date,
        status: 'write',
        messages: [],
      });
    }
    for (const [column, cs] of byColumn) {
      const idx = findVariable(sav, column);
      const current = rowIndex !== null && idx >= 0 ? sav.rows[rowIndex][idx] : null;
      changes.push(resolve(column, cs, sav, current));
    }

    if (rows.length > 1) {
      messages.push(`Bu dosya numarası listede ${rows.length} satırda var; hiçbir değer yazılmadı`);
      for (const c of changes) {
        if (c.status === 'write') c.status = 'skip';
      }
    }

    const existingName =
      rowIndex !== null ? displayValue(sav.rows[rowIndex][findVariable(sav, DEMOGRAPHIC_COLUMNS.name)]) : '';
    patients.push({
      fileNo,
      name: latestReport.patient.name || existingName,
      isNew,
      rowIndex,
      messages,
      changes,
    });
  }

  const all = patients.flatMap((p) => p.changes);
  return {
    patients,
    failed,
    summary: {
      patients: patients.length,
      toWrite: all.filter((c) => c.status === 'write').length,
      conflicts: all.filter((c) => c.status === 'conflict').length,
      warnings: all.filter((c) => c.status === 'skip' || (c.status === 'write' && c.messages.length > 0)).length,
      unrecognized: failed.length,
    },
  };
}

/** Returns a new SavFile with all 'write' changes applied. The input is not modified. */
export function applyPlan(sav: SavFile, plan: Plan): SavFile {
  const rows = sav.rows.map((r) => [...r]);
  const emptyRow = (): Cell[] => sav.variables.map((v) => (v.width === 0 ? null : ''));

  for (const p of plan.patients) {
    const writes = p.changes.filter((c) => c.status === 'write');
    if (writes.length === 0) continue;
    let row: Cell[];
    if (p.isNew) {
      row = emptyRow();
      rows.push(row);
    } else if (p.rowIndex !== null) {
      row = rows[p.rowIndex];
    } else continue;
    for (const c of writes) {
      const idx = findVariable(sav, c.column);
      if (idx >= 0 && c.proposed !== null) row[idx] = c.proposed;
    }
  }
  return { ...sav, rows };
}
