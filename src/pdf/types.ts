import type { ReportDate } from '../util';

export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  /** 1-based page number. */
  page: number;
}

export interface PatientInfo {
  name: string;
  fileNo: string;
  birth: ReportDate | null;
  /** 1 = kadın, 2 = erkek (CinsiyetK1E2 coding). */
  sex: 1 | 2 | null;
}

export interface Observation {
  column: string;
  /** null = found in the source but must not be written (see warnings). */
  value: number | string | null;
  /** Text as it appears in the PDF. */
  raw: string;
  /** Where it came from, e.g. the test name. */
  source: string;
  warnings: string[];
  /** Inferred value (e.g. "not in the comorbidity list" → 0): only fills an empty cell. */
  onlyIfEmpty?: boolean;
}

export interface ParsedReport {
  kind: 'lab' | 'eko' | 'word';
  fileName: string;
  patient: PatientInfo;
  /** Lab: Numune Alma Zamanı. Eko: Çekim Tarihi. Word: none (null). */
  date: ReportDate | null;
  observations: Observation[];
  /** Lines of the source that were not understood (shown in the preview, nothing written). */
  unrecognized?: string[];
}

export interface FailedReport {
  kind: 'unknown';
  fileName: string;
  reason: string;
}

export type ReportResult = ParsedReport | FailedReport;
