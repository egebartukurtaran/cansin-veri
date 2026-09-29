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

/**
 * Regexes with the i flag do not match Turkish "İ" against "i". Replacing it keeps the string
 * length, so positions found in the folded text are valid in the original.
 */
const fold = (s: string) => s.replace(/İ/g, 'i');

const KOMORBID =
  /^(?:komorbid(?:ite|iteler|iteleri)?|ek\s+hastal[ıi]k(?:lar[ıi]?|[ıi])?|eşlik\s+eden\s+hastal[ıi]k(?:lar[ıi]?)?|kronik\s+hastal[ıi]k(?:lar[ıi]?)?|özgeçmiş(?:i)?|öz\s*geçmiş(?:i)?)\s*[:=\-–]?\s*(.*)$/i;

function emitComorbidity(text: string, raw: string, emit: Emit) {
  const t = text.replace(/[\s,;]+$/, '').trim();
  const none = t === '' || parseYesNo(t) === 0;
  if (!none) emit('Komorbidite', t, 'Komorbidite', raw);
  for (const [column, re] of COMORBIDITY_FLAGS) {
    emit(column, none ? 0 : re.test(fold(t)) ? 1 : 0, 'Komorbidite satırından', raw);
  }
}

const RULES: Rule[] = [
  { test: /^eko\s*:?\s*$/i, apply: () => {} },
  {
    test: /^ef\s*[:=]?\s*%?\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/i,
    apply: numberRule(ECHO_COLUMNS.ef, 'Ef'),
  },
  {
    test: /^kapak\s+patolojisi\s*[:=]?\s*(.*)$/i,
    apply: (m, emit, line) => {
      const rest = line.slice(line.length - m[1].length).trim();
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

const FILE_NO = /^(?:dosya|protokol)\s*(?:no|numarası|numarasi)?\.?\s*[:=\-–]?\s*(\d+)\s*$/i;

const SEX_WORD = '(kadın|kadin|bayan|erkek|bay)';
const AGE_WORD = '(?:yaş(?:ında|inda)?|yas|yıl|y)';
const AGE_LABEL = new RegExp(`^ya[şs]\\s*[:=\\-–]?\\s*(\\d{1,3})\\s*${AGE_WORD}?$`);
const AGE_NUMBER = new RegExp(`^(\\d{1,3})\\s*${AGE_WORD}$`);
const SEX_ONLY = new RegExp(`^(?:cinsiyet(?:i)?\\s*[:=\\-–]?\\s*)?(${SEX_WORD.slice(1, -1)}|k|e)(?:\\s+hasta)?$`);
const SEX_ANY = '(kadın|kadin|bayan|erkek|bay|k|e)';
const AGE_SEX = new RegExp(`^(\\d{1,3})\\s*${AGE_WORD}?\\s+${SEX_ANY}(?:\\s+hasta)?$`);
const SEX_AGE = new RegExp(`^${SEX_ANY}(?:\\s+hasta)?\\s*,?\\s*(\\d{1,3})\\s*${AGE_WORD}?$`);

const sexCode = (w: string): 1 | 2 => (/^(k|bayan)/.test(w) ? 1 : 2);

/**
 * Reads a line that contains only age and/or sex, in the usual ways of writing it:
 * "Yaş: 60", "Yaş - 60" (table), "60 yaşında", "kadın", "Cinsiyet: K", "60 yaşında kadın hasta",
 * "60/K", "Kadın, 60". Returns null if the line has anything else in it.
 */
export function parseAgeSex(line: string): { age?: number; sex?: 1 | 2 } | null {
  const t = lower(line).replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
  const parts = t.split(/\s*[,;/|]\s*/).filter((x) => x !== '');
  if (parts.length === 0) return null;
  const out: { age?: number; sex?: 1 | 2 } = {};
  for (const part of parts) {
    let m: RegExpExecArray | null;
    if ((m = AGE_LABEL.exec(part) ?? AGE_NUMBER.exec(part))) out.age = Number(m[1]);
    else if ((m = SEX_ONLY.exec(part))) out.sex = sexCode(m[1]);
    else if ((m = AGE_SEX.exec(part))) {
      out.age = Number(m[1]);
      out.sex = sexCode(m[2]);
    } else if ((m = SEX_AGE.exec(part))) {
      out.sex = sexCode(m[1]);
      out.age = Number(m[2]);
    } else if (/^\d{1,3}$/.test(part) && parts.length > 1) out.age = Number(part);
    else return null;
  }
  if (out.age !== undefined && (out.age < 0 || out.age > 120)) return null;
  return out.age !== undefined || out.sex !== undefined ? out : null;
}

/** "AD SOYAD, 60, K" / "AD SOYAD (60 yaş kadın)" → name + age/sex. */
function splitNameLine(line: string): { name: string; info: { age?: number; sex?: 1 | 2 } | null } {
  const paren = /^(.*?\S)\s*\(([^)]*)\)\s*$/.exec(line);
  if (paren) {
    const info = parseAgeSex(paren[2]);
    if (info) return { name: paren[1], info };
  }
  const parts = line.split(/\s*[,;]\s*/);
  for (let i = 1; i < parts.length; i++) {
    const info = parseAgeSex(parts.slice(i).join(', '));
    if (info) return { name: parts.slice(0, i).join(', '), info };
  }
  const tail = /^(.*?\D)\s+(\d{1,3}\s*\S*(?:\s+\S+)?)$/.exec(line);
  if (tail) {
    const info = parseAgeSex(tail[2]);
    if (info?.age !== undefined) return { name: tail[1].trim(), info };
  }
  return { name: line, info: null };
}

const isPatientHeader = (line: string) => FILE_NO.test(line) || parseAgeSex(line) !== null;

function isHeaderLike(line: string) {
  return isPatientHeader(line);
}

function isKnown(line: string, columns: Map<string, string>): boolean {
  const noop: Emit = () => {};
  return (
    isHeaderLike(line) ||
    KOMORBID.test(fold(line)) ||
    RULES.some((r) => r.test.test(fold(line))) ||
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
      !isKnown(line, columns) &&
      ((next !== undefined && isPatientHeader(next)) || splitNameLine(line).info?.age !== undefined);
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
    const head = splitNameLine(name);
    const patient: PatientInfo = { name: head.name.toLocaleUpperCase('tr'), fileNo: '', birth: null, sex: null };
    const observations: Observation[] = [];
    const unrecognized: string[] = [];
    const emit: Emit = (column, value, source, raw, warning) =>
      observations.push({ column, value, raw, source, warnings: warning ? [warning] : [] });
    const ages = new Set<number>();
    const sexes = new Set<1 | 2>();
    const takeInfo = (info: { age?: number; sex?: 1 | 2 }, line: string) => {
      if (info.age !== undefined) {
        ages.add(info.age);
        emit(DEMOGRAPHIC_COLUMNS.age, info.age, 'Yaş', line);
      }
      if (info.sex !== undefined) sexes.add(info.sex);
    };
    if (head.info) takeInfo(head.info, name);

    // "Komorbidite:" with the list on the following lines ("- HT", "- DM", ...).
    let comorbidity: { lines: string[]; raw: string } | null = null;
    const flushComorbidity = () => {
      if (comorbidity) emitComorbidity(comorbidity.lines.join(', '), comorbidity.raw, emit);
      comorbidity = null;
    };

    for (const line of body) {
      // Continuation items: short list entries, not "X: value" / "X - 12 unit" lines.
      const looksLikeItem = !/[:=]\s*\S/.test(line) && !/\s[-–—]\s*\d/.test(line) && line.length <= 80;
      if (comorbidity && looksLikeItem && !isKnown(line, columns)) {
        const item = line.replace(/^[-–•*·]+\s*|^\d+[.)]\s*/, '').trim();
        if (item) comorbidity.lines.push(item);
        comorbidity.raw += ` / ${line}`;
        continue;
      }
      flushComorbidity();
      const kom = KOMORBID.exec(fold(line));
      if (kom) {
        const text = line.slice(line.length - kom[1].length).trim();
        if (text === '') comorbidity = { lines: [], raw: line };
        else emitComorbidity(text, line, emit);
        continue;
      }
      const fileNo = FILE_NO.exec(line);
      if (fileNo) {
        patient.fileNo = fileNo[1];
        continue;
      }
      const info = parseAgeSex(line);
      if (info) {
        takeInfo(info, line);
        continue;
      }
      if (tryLab(line, emit)) continue;
      const folded = fold(line);
      const rule = RULES.find((r) => r.test.test(folded));
      if (rule) {
        rule.apply(rule.test.exec(folded)!, emit, line);
        continue;
      }
      if (tryColumn(line, columns, emit)) continue;
      unrecognized.push(line);
    }
    flushComorbidity();
    if (sexes.size === 1) patient.sex = [...sexes][0];
    else if (sexes.size > 1) {
      emit(DEMOGRAPHIC_COLUMNS.sex, null, 'Cinsiyet', 'kadın / erkek', 'Word’de hem kadın hem erkek yazıyor, yazılmadı');
    }
    if (ages.size > 1) {
      // Several different ages for one patient: keep them all so the merge reports a conflict.
      for (const o of observations) if (o.column === DEMOGRAPHIC_COLUMNS.age) o.warnings.push('Word’de farklı yaşlar var');
    }
    return { kind: 'word', fileName, patient, date: null, observations, unrecognized };
  });
}
