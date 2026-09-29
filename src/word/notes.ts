// Parses the hand-written patient notes in a Word file. Each patient block looks like:
//
//   AD SOYAD
//   Dosya No: 1234567        (optional; without it the patient is matched by name)
//   Yaş: 60
//   kadın
//   Glukoz - 103 mg/dL       (lab lines: exact test names, same as the PDFs)
//   Eko:
//   Ef: 60
//   Kapak patolojisi yok
//   ...
//   Boy: 162                 (any line "<list column>: <value>" is accepted too)
//
// Lines that are not understood are reported, never guessed.

import { DEMOGRAPHIC_COLUMNS, ECHO_COLUMNS, findLabMapping, normalizeName } from '../mapping';
import type { Observation, ParsedReport, PatientInfo } from '../pdf/types';
import { parseTrNumber } from '../util';

const lower = (s: string) => s.toLocaleLowerCase('tr');
const L = '[a-zçğıöşü0-9]';
/** Whole-word test that works with Turkish letters (\b does not). */
const word = (alternatives: string) => new RegExp(`(?<!${L})(?:${alternatives})(?!${L})`, 'i');

/** Hand-typed number: "3,3", "22.1" (dot only as a decimal point with 1–2 digits), "60". */
export function parseTypedNumber(text: string): number | null {
  const t = text.trim();
  const dot = /^(\d+)\.(\d{1,2})$/.exec(t);
  if (dot) return Number(`${dot[1]}.${dot[2]}`);
  return parseTrNumber(t);
}

const NUM = '(\\d+(?:[.,]\\d+)?)';

/** 0 = yok, 1 = var, null = unclear. */
export function parseYesNo(text: string): 0 | 1 | null {
  const t = lower(text).trim();
  const no = word('yok|negatif|hayır|izlenmedi|saptanmadı') .test(t) || /^[-–—]$/.test(t) || t === '0';
  const yes =
    word('var|mevcut|pozitif|evet|izlendi|saptandı').test(t) || /^\+/.test(t) || t === '1';
  if (no === yes) return null;
  return no ? 0 : 1;
}

type Emit = (column: string, value: number | string | null, source: string, raw: string, warning?: string) => void;

interface Rule {
  test: RegExp;
  apply: (m: RegExpExecArray, emit: Emit, line: string) => void;
}

const yesNoRule = (column: string, source: string) => (_m: RegExpExecArray, emit: Emit, line: string) => {
  const v = parseYesNo(line.replace(/^.*?(?:hipertro\S*|disfonksiyon|ödem|ptö|pto)\s*[:=]?/i, ''));
  if (v === null) emit(column, null, source, line, 'var / yok anlaşılamadı, yazılmadı');
  else emit(column, v, source, line);
};

const numberRule = (column: string, source: string, group = 1) => (m: RegExpExecArray, emit: Emit, line: string) => {
  const v = parseTypedNumber(m[group]);
  if (v === null) emit(column, null, source, line, 'Sayı okunamadı, yazılmadı');
  else emit(column, v, source, line);
};

/** Comorbidity text → Yok0Var1 flags. Only written when a "komorbid" line exists. */
const COMORBIDITY_FLAGS: [string, RegExp][] = [
  ['DMYok0Var1', word('dm|diyabet\\S*|diabetes')],
  ['HTYok0Var1', word('ht|htn|hipertansiyon')],
  ['KAHYok0Var1', word('kah|koroner arter hastalığı|koroner')],
  ['KOAHYok0Var1', word('koah')],
  ['SVOYok0Var1', word('svo|sva|inme|serebrovasküler')],
];

const RULES: Rule[] = [
  { test: /^eko\s*:?\s*$/i, apply: () => {} },
  {
    test: /^ya[şs]\s*[:=]?\s*(\d+)\s*$/i,
    apply: (m, emit, line) => emit(DEMOGRAPHIC_COLUMNS.age, Number(m[1]), 'Yaş', line),
  },
  {
    test: /^ef\s*[:=]?\s*%?\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/i,
    apply: numberRule(ECHO_COLUMNS.ef, 'Ef'),
  },
  {
    test: /^kapak\s+patolojisi\s*[:=]?\s*(.*)$/i,
    apply: (m, emit, line) => {
      const rest = m[1].trim();
      const yn = parseYesNo(rest.split(/[\s,(:]/)[0] ?? '');
      if (yn === 0) {
        emit('Kapak_patolojisi', 0, 'Kapak patolojisi', line);
        emit('Kapak_patolojisi_tipi', '0', 'Kapak patolojisi', line);
      } else if (rest !== '') {
        const detail = rest.replace(/^(var|mevcut)\s*[:,(-]?\s*/i, '').replace(/\)\s*$/, '').trim();
        emit('Kapak_patolojisi', 1, 'Kapak patolojisi', line);
        if (detail) emit('Kapak_patolojisi_tipi', detail, 'Kapak patolojisi', line);
      } else {
        emit('Kapak_patolojisi', null, 'Kapak patolojisi', line, 'var / yok yazılmamış');
      }
    },
  },
  {
    test: /^e\s*\/\s*a\b(.*)$/i,
    apply: (m, emit, line) => {
      const t = lower(m[1]);
      const n = /(\d+(?:[.,]\d+)?)/.exec(t);
      let v: number | null = null;
      if (/büyük|>/.test(t)) v = 1;
      else if (/küçük|</.test(t)) v = 0;
      else if (n && !/den|dan/.test(t)) {
        const x = parseTypedNumber(n[1]);
        v = x === null || x === 1 ? null : x < 1 ? 0 : 1;
      }
      if (v === null) emit(ECHO_COLUMNS.ea, null, 'E/A', line, 'Anlaşılamadı, yazılmadı');
      else emit(ECHO_COLUMNS.ea, v, 'E/A', line);
    },
  },
  {
    test: /(ventrik\S*\s+hipertro|hipertrof|(?<![a-z])(svh|lvh)(?![a-z]))/i,
    apply: yesNoRule('Sol_ventrikül_hipertrofisi', 'Sol ventrikül hipertrofisi'),
  },
  { test: /diyastolik\s+disfonksiyon/i, apply: yesNoRule('Diyastolik_disfonksiyon', 'Diyastolik disfonksiyon') },
  {
    test: new RegExp(`^sol\\s*atri[yu]?um(?:\\s+çapı)?\\s*[:=]?\\s*${NUM}\\s*(?:cm)?\\s*$`, 'i'),
    apply: numberRule(ECHO_COLUMNS.leftAtrium, 'Sol atriyum'),
  },
  { test: new RegExp(`^tapse\\s*[:=]?\\s*${NUM}`, 'i'), apply: numberRule(ECHO_COLUMNS.tapse, 'TAPSE') },
  { test: new RegExp(`^(?:pab|spab)\\s*[:=]?\\s*${NUM}`, 'i'), apply: numberRule(ECHO_COLUMNS.pab, 'PAB') },
  { test: new RegExp(`^(?:vci|ivc)\\s*[:=]?\\s*${NUM}`, 'i'), apply: numberRule(ECHO_COLUMNS.ivc, 'VCI') },
  {
    test: /%\s*50\s*['’`]?\s*d[ae]n\s+(fazla|az)\s+kollabe/i,
    apply: (m, emit, line) => emit(ECHO_COLUMNS.ivcCollapse, lower(m[1]) === 'fazla' ? 1 : 0, 'VCI kollabe', line),
  },
  {
    test: new RegExp(`^kbh\\s*süre(?:si)?\\s*[:=]?\\s*${NUM}`, 'i'),
    apply: numberRule('KBHsüresi', 'KBH süresi'),
  },
  {
    test: /^komorbid(?:ite|iteler)?\s*[:=]?\s*(.*)$/i,
    apply: (m, emit, line) => {
      const text = m[1].trim();
      const none = text === '' || parseYesNo(text) === 0;
      if (!none) emit('Komorbidite', text, 'Komorbid', line);
      for (const [column, re] of COMORBIDITY_FLAGS) {
        emit(column, none ? 0 : re.test(text) ? 1 : 0, 'Komorbid satırından', line);
      }
    },
  },
  {
    test: /^(?:ofis\s*)?(?:ta|tansiyon|kb)\s*[:=]?\s*(\d{2,3})\s*(?:\(\s*skb\s*\))?\s*\/\s*(\d{2,3})/i,
    apply: (m, emit, line) => {
      emit('SKBmmHg', Number(m[1]), 'Tansiyon (SKB)', line);
      emit('DKBmmHg', Number(m[2]), 'Tansiyon (DKB)', line);
    },
  },
  { test: /^(?:pt[öo]|pretibial\s*ödem)\s*[:=]?/i, apply: yesNoRule('pretibial_odem', 'Pretibial ödem') },
];

/** "Glukoz - 103 mg/dL" or "Glukoz: 103". Returns true if the line was a known lab test. */
function tryLab(line: string, emit: Emit): boolean {
  const m = /^(.*?\S)\s*(?:\s[-–—]\s|:)\s*(.+)$/.exec(line);
  if (!m) return false;
  const mapping = findLabMapping(m[1]);
  if (!mapping) return false;
  const valueText = m[2].trim();
  if (/^[<>]/.test(valueText)) {
    emit(mapping.column, null, mapping.test, line, `Sonuç "${valueText}" — kesin sayı değil, yazılmadı`);
    return true;
  }
  const num = /^(\d+(?:[.,]\d+)?)(?:\s|$)/.exec(valueText);
  const value = num ? parseTypedNumber(num[1]) : null;
  if (value === null) {
    emit(mapping.column, null, mapping.test, line, `Sonuç sayı değil ("${valueText}"), yazılmadı`);
    return true;
  }
  const scaled = mapping.scale ? parseTrNumber(num![1].replace('.', ','), mapping.scale) : value;
  emit(mapping.column, scaled, mapping.test, line);
  return true;
}

const squash = (s: string) => lower(s).replace(/[\s_]+/g, '');

/** "Boy: 162" where "Boy" is a column of the list. */
function tryColumn(line: string, columns: Map<string, string>, emit: Emit): boolean {
  const m = /^([^:=]+?)\s*[:=]\s*(.+)$/.exec(line);
  if (!m) return false;
  const column = columns.get(squash(m[1]));
  if (!column) return false;
  const text = m[2].trim();
  const n = parseTypedNumber(text);
  emit(column, n ?? text, column, line);
  return true;
}

const FILE_NO = /^(?:dosya|protokol)\s*(?:no|numarası|numarasi)?\.?\s*[:=]?\s*(\d+)\s*$/i;
const SEX = /^(?:cinsiyet(?:i)?\s*[:=]?\s*)?(kadın|kadin|erkek|k|e)\s*$/i;
const STARTS_PATIENT = [FILE_NO, /^ya[şs]\s*[:=]?\s*\d+/i];

function isHeaderLike(line: string) {
  return FILE_NO.test(line) || STARTS_PATIENT.some((r) => r.test(line)) || SEX.test(line);
}

function isKnown(line: string, columns: Map<string, string>): boolean {
  const noop: Emit = () => {};
  return (
    isHeaderLike(line) ||
    RULES.some((r) => r.test.test(line)) ||
    tryLab(line, noop) ||
    tryColumn(line, columns, noop)
  );
}

/**
 * Splits the document into patient blocks: a block starts at an unrecognised line (the name)
 * directly followed by a "Dosya No" or "Yaş" line.
 */
function splitPatients(lines: string[], columns: Map<string, string>): { name: string; body: string[] }[] {
  const blocks: { name: string; body: string[] }[] = [];
  let current: { name: string; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const startsBlock =
      !isKnown(line, columns) && next !== undefined && STARTS_PATIENT.some((r) => r.test(next));
    if (startsBlock || (current === null && !isKnown(line, columns))) {
      current = { name: line, body: [] };
      blocks.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return blocks;
}

export function parseWordLines(rawLines: string[], fileName: string, columnNames: string[]): ParsedReport[] {
  const columns = new Map(columnNames.map((c) => [squash(c), c]));
  const lines = rawLines.map(normalizeName).filter((l) => l !== '');

  return splitPatients(lines, columns).map(({ name, body }) => {
    const patient: PatientInfo = { name: name.toLocaleUpperCase('tr'), fileNo: '', birth: null, sex: null };
    const observations: Observation[] = [];
    const unrecognized: string[] = [];
    const emit: Emit = (column, value, source, raw, warning) =>
      observations.push({ column, value, raw, source, warnings: warning ? [warning] : [] });

    for (const line of body) {
      const fileNo = FILE_NO.exec(line);
      if (fileNo) {
        patient.fileNo = fileNo[1];
        continue;
      }
      const sex = SEX.exec(line);
      if (sex) {
        patient.sex = lower(sex[1]).startsWith('k') ? 1 : 2;
        continue;
      }
      if (tryLab(line, emit)) continue;
      const rule = RULES.find((r) => r.test.test(line));
      if (rule) {
        rule.apply(rule.test.exec(line)!, emit, line);
        continue;
      }
      if (tryColumn(line, columns, emit)) continue;
      unrecognized.push(line);
    }
    return { kind: 'word', fileName, patient, date: null, observations, unrecognized };
  });
}
