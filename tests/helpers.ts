import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractItems, parseItems, type PdfDocument } from '../src/pdf/parse';
import type { ParsedReport, ReportResult } from '../src/pdf/types';
import { parseDate, type ReportDate } from '../src/util';

// Real patient files live in fixtures/ (gitignored). Identifying details (name, file number,
// birth date, report dates) are kept in fixtures/patients.json so they never reach the repo.
export const FIXTURES = path.resolve(__dirname, '../fixtures');
export const fixture = (name: string) => path.join(FIXTURES, name);
export const hasFixtures = (...names: string[]) =>
  ['patients.json', ...names].every((n) => fs.existsSync(fixture(n)));

export const A_LABS = ['a_hemogram.pdf', 'a_biyokimya.pdf', 'a_idrar.pdf', 'a_kardiyak.pdf', 'a_hormon.pdf'];
export const B_LABS = ['b_biyokimya.pdf', 'b_kardiyak.pdf', 'b_idrar.pdf', 'b_hormon.pdf', 'b_hemogram.pdf'];
export const A_EKO = 'a_eko.pdf';
export const B_EKO = 'b_eko.pdf';
export const LIST = 'liste.sav';

interface PatientFixture {
  name: string;
  fileNo: string;
  birth: ReportDate;
  dates: Record<string, ReportDate>;
}

/** Reads fixtures/patients.json lazily (only inside tests that are not skipped). */
export function patient(key: 'A' | 'B'): PatientFixture {
  const all = JSON.parse(fs.readFileSync(fixture('patients.json'), 'utf8'));
  const { name, fileNo, birth, ...dates } = all[key];
  return {
    name,
    fileNo,
    birth: parseDate(birth)!,
    dates: Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, parseDate(v as string)!])),
  };
}

export async function parseFixture(name: string): Promise<ReportResult> {
  const data = new Uint8Array(fs.readFileSync(fixture(name)));
  const doc = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  return parseItems(await extractItems(doc as unknown as PdfDocument), name);
}

export async function parsed(name: string): Promise<ParsedReport> {
  const r = await parseFixture(name);
  if (r.kind === 'unknown') throw new Error(`${name}: ${r.reason}`);
  return r;
}

/** column → value, only writable observations. */
export function values(r: ParsedReport): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const o of r.observations) out[o.column] = o.value;
  return out;
}
