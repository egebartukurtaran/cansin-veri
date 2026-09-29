// Parses the hand-written patient notes in a Word file. Each patient block looks like:
//
//   Ad soyad: AD SOYAD       (or just the name on its own line)
//   Dosya No: 1234567        (optional; without it the patient is matched by name)
//   78 yaş erkek
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
  const no = word('yok|yoktur|negatif|hayır|izlenmedi|saptanmadı|görülmedi').test(t) || /^[-–—]$/.test(t) || t === '0';
  const yes =
    word('var|mevcut|pozitif|evet|izlendi|saptandı|görüldü').test(t) || /^\+/.test(t) || t === '1';
  if (no === yes) return null;
  return no ? 0 : 1;
}

type Emit = (
  column: string,
  value: number | string | null,
  source: string,
  raw: string,
  warning?: string,
  onlyIfEmpty?: boolean,
) => void;

interface Rule {
  test: RegExp;
  apply: (m: RegExpExecArray, emit: Emit, line: string) => void;
}

const numberRule = (column: string, source: string, group = 1) => (m: RegExpExecArray, emit: Emit, line: string) => {
  const v = parseTypedNumber(m[group]);
  if (v === null) emit(column, null, source, line, 'Sayı okunamadı, yazılmadı');
  else emit(column, v, source, line);
};

/** Comorbidity text → Yok0Var1 flags. Only written when a comorbidity line exists. */
const COMORBIDITY_FLAGS: [string, RegExp][] = [
  ['DMYok0Var1', word('dm|diyabet\\S*|diabetes')],
  ['HTYok0Var1', word('ht|htn|hipertansiyon')],
  ['KAHYok0Var1', word('kah|koroner arter hastalığı|koroner')],
  ['KOAHYok0Var1', word('koah')],
  ['SVOYok0Var1', word('svo|sva|inme|serebrovasküler')],
];

/** "Kullandığı ilaç: antihipertansif var, tiyazid yok" → drug-class columns. */
const DRUG_CLASSES: [string, RegExp][] = [
  ['Antihipertansif_kullanımı', word('antihipertansif\\S*|anti\\s*-?\\s*ht|ahi')],
  ['RAAS_kullanımı', word('raas\\S*|acei|ace\\s*-?\\s*inh\\S*|ace\\s*-?\\s*i|arb|anjiyotensin\\S*')],
  ['Tiyazid_kullanımı', word('tiyazid\\S*|tiazid\\S*|hctz|hidroklorotiyazid')],
  ['KKB_kullanımı', word('kkb|ccb|kalsiyum\\s+kanal\\s+bloker\\S*')],
  ['Loop_kullanımı', word('loop(?:\\s+diüretik\\S*)?|furosemid|lasix')],
  ['BB_kullanımı', word('bb|beta\\s*-?\\s*bloker\\S*')],
  ['MRA_kullanımı', word('mra|spironolakton|aldakton|eplerenon')],
  ['SGLT2inhibitörü_kullanımı', word('sglt\\s*-?\\s*2\\S*(?:\\s+inh\\S*)?')],
  ['ESA_kullanımı', word('esa|eritropoetin|epo')],
  ['Statin_kullanımı', word('statin\\S*')],
];

/**
 * Regexes with the i flag do not match Turkish "İ" against "i". Replacing it keeps the string
 * length, so positions found in the folded text are valid in the original.
 */
const fold = (s: string) => s.replace(/İ/g, 'i');
/** The text of group 1 taken from the original line (group 1 must run to the end of the line). */
const tailOf = (line: string, m: RegExpExecArray) => line.slice(line.length - m[1].length).trim();

/** Label separator: ":" / "=" (repeated), or " - " before text. A lone "-" is kept as the value. */
const SEP = '(?:\\s*[:=])*\\s*(?:[-–]\\s+(?=\\S))?';
const KOMORBID = new RegExp(
  `^(?:komorb[a-zçğıöşü]*|ek\\s+hastal[a-zçğıöşü]*|eşlik\\s+eden\\s+hastal[a-zçğıöşü]*|kronik\\s+hastal[a-zçğıöşü]*|öz\\s*geçmiş[a-zçğıöşü]*)${SEP}(.*)$`,
  'i',
);

function emitComorbidity(text: string, raw: string, emit: Emit) {
  const t = text.replace(/[\s,;]+$/, '').trim();
  const none = t === '' || parseYesNo(t) === 0;
  if (!none) emit('Komorbidite', t, 'Komorbidite', raw);
  for (const [column, re] of COMORBIDITY_FLAGS) {
    if (none) emit(column, 0, 'Komorbidite: yok', raw);
    else if (re.test(fold(t))) emit(column, 1, 'Komorbidite satırından', raw);
    // Not mentioned → 0, but never replaces a value already in the list.
    else emit(column, 0, 'Komorbiditede geçmiyor', raw, undefined, true);
  }
}

/** Pretibial oedema is graded in the list: 0 = yok, 1..4 = +1..+4. "+/+" = both legs +1. */
export function parseOedema(text: string): { value: number | null; warning?: string } {
  const sides = lower(text).replace(/\s+/g, '').split('/').filter((x) => x !== '');
  if (sides.length === 0 || sides.length > 2) return { value: null, warning: 'Anlaşılamadı, yazılmadı' };
  const grades = sides.map((s): number | 'unknown' | null => {
    if (/^(yok|negatif|hayır|0|[-–—]+)$/.test(s)) return 0;
    let m: RegExpExecArray | null;
    if ((m = /^\+([1-4])$/.exec(s) ?? /^([1-4])\+$/.exec(s))) return Number(m[1]);
    if (/^\+{1,4}$/.test(s)) return s.length;
    if (/^(var|mevcut|pozitif)$/.test(s)) return 'unknown';
    return null;
  });
  if (grades.some((g) => g === null)) return { value: null, warning: 'Anlaşılamadı, yazılmadı' };
  if (grades.includes('unknown')) return { value: null, warning: 'Ödem var ama derecesi (+1…+4) yazılmamış, yazılmadı' };
  const distinct = new Set(grades);
  if (distinct.size > 1) return { value: null, warning: 'Sağ ve sol farklı derecede, yazılmadı' };
  return { value: grades[0] as number };
}

function smokingLike(column: string, source: string) {
  return (m: RegExpExecArray, emit: Emit, line: string) => {
    const t = lower(tailOf(line, m));
    if (word('bırak\\S*|eski|ex|önceden|geçmişte').test(t)) {
      emit(column, null, source, line, 'Bırakmış / eski kullanıcı — kodlaması belirsiz, yazılmadı');
    } else if (/^[-–—]$/.test(t) || word('yok|hayır|içmiyor|kullanmıyor|negatif').test(t) || t === '0') {
      emit(column, 0, source, line);
    } else if (/\d/.test(t) || /\+/.test(t) || word('var|içiyor|kullanıyor|aktif|evet|sosyal').test(t)) {
      emit(column, 1, source, line);
    } else {
      emit(column, null, source, line, 'var / yok anlaşılamadı, yazılmadı');
    }
  };
}

const VALVE_ITEM = new RegExp(
  '^(?:(?:eser|hafif|minimal|minimum|orta|ileri|ağır|hafif-orta|orta-ileri|\\d(?:\\s*[-–]\\s*\\d)?\\.?)\\s*)*' +
    '(?:my|ty|ay|py|mr|tr|ar|pr|ms|as|md|ad|(?:mitral|triküspit|trikuspit|aort|pulmoner)\\s+(?:yetmezli[ğg]i|darl[ıi][ğg][ıi]))$',
);

/** "Hafif ty, hafif my" → valve pathology present, type = the text. */
function tryValveLine(line: string, emit: Emit): boolean {
  const parts = lower(fold(line)).replace(/[.]$/, '').split(/\s*[,;/+]\s*|\s+ve\s+/).filter((x) => x !== '');
  if (parts.length === 0 || !parts.every((p) => VALVE_ITEM.test(p))) return false;
  emit('Kapak_patolojisi', 1, 'Kapak patolojisi', line);
  emit('Kapak_patolojisi_tipi', line.replace(/[.]$/, '').trim(), 'Kapak patolojisi', line);
  return true;
}

const RULES: Rule[] = [
  { test: /^eko\s*:?\s*$/i, apply: () => {} },
  {
    test: new RegExp(`^kapak\\s+patoloji(?:si|leri)?${SEP}(.*)$`, 'i'),
    apply: (m, emit, line) => {
      const rest = tailOf(line, m);
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
    // "e/a 1den büyük", "E/A oranı <1", "Ea küçük"
    test: /^e\s*[/:-]?\s*a(?![a-zçğıöşü])(.*)$/i,
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
    test: new RegExp(`^kbh\\s*süre(?:si)?${SEP}${NUM}`, 'i'),
    apply: numberRule('KBHsüresi', 'KBH süresi'),
  },
  {
    test: /^(?:ofis\s*)?(?:ta|tansiyon|kb)\s*[:=]?\s*(\d{2,3})\s*(?:\(\s*skb\s*\))?\s*\/\s*(\d{2,3})/i,
    apply: (m, emit, line) => {
      emit('SKBmmHg', Number(m[1]), 'Tansiyon (SKB)', line);
      emit('DKBmmHg', Number(m[2]), 'Tansiyon (DKB)', line);
    },
  },
  {
    // "Skb: 116/dkb: 69"
    test: /(?<![a-zçğıöşü])[sd]kb\s*[:=]?\s*\d{2,3}/i,
    apply: (_m, emit, line) => {
      const t = fold(line);
      const s = /(?<![a-zçğıöşü])skb\s*[:=]?\s*(\d{2,3})/i.exec(t);
      const d = /(?<![a-zçğıöşü])dkb\s*[:=]?\s*(\d{2,3})/i.exec(t);
      if (s) emit('SKBmmHg', Number(s[1]), 'Tansiyon (SKB)', line);
      if (d) emit('DKBmmHg', Number(d[1]), 'Tansiyon (DKB)', line);
    },
  },
  {
    test: new RegExp(`^(?:pt[öo]|pretibial\\s*ödem)${SEP}(.*)$`, 'i'),
    apply: (m, emit, line) => {
      const r = parseOedema(tailOf(line, m));
      emit('pretibial_odem', r.value, 'Pretibial ödem', line, r.warning);
    },
  },
  { test: new RegExp(`^sigara(?:\\s+kullanımı)?${SEP}(.*)$`, 'i'), apply: smokingLike('SigaraYok0Var1', 'Sigara') },
  { test: new RegExp(`^alkol(?:\\s+kullanımı)?${SEP}(.*)$`, 'i'), apply: smokingLike('AlkolYok0Var1', 'Alkol') },
  {
    test: new RegExp(`^(?:kulland[ıi][ğg][ıi]\\s+)?ila[çc](?:lar[ıi]?)?(?:\\s+kullan[ıi]m[ıi])?\\s*[:=\\-–]\\s*(.*)$`, 'i'),
    apply: (m, emit, line) => {
      for (const item of tailOf(line, m).split(/\s*[,;]\s*|\s+ve\s+/).filter((x) => x.trim() !== '')) {
        const cls = DRUG_CLASSES.find(([, re]) => re.test(fold(item)));
        if (!cls) {
          emit('', null, 'İlaç', line, `"${item}" ilaç grubu tanınmadı`);
          continue;
        }
        const yn = parseYesNo(item.replace(cls[1], ''));
        // A drug listed without "var/yok" is taken as used.
        emit(cls[0], yn === null && !/[?]/.test(item) ? 1 : yn, 'Kullandığı ilaç', line);
      }
    },
  },
];

/**
 * Free text (usually copied from the echo report): every value in the line is read, and
 * var/yok for hypertrophy and diastolic dysfunction is judged within its own sentence.
 * Returns true if anything was found.
 */
function scanText(line: string, emit: Emit): boolean {
  const t = fold(line);
  let found = false;
  const B = '(?<![a-zçğıöşü])';
  const numbers = (column: string, source: string, re: RegExp) => {
    const seen = new Set<string>();
    for (const m of t.matchAll(re)) {
      const v = parseTypedNumber(m[1]);
      const key = String(v);
      found = true;
      if (seen.has(key)) continue;
      seen.add(key);
      emit(column, v, source, line, v === null ? 'Sayı okunamadı, yazılmadı' : undefined);
    }
  };
  numbers(ECHO_COLUMNS.ef, 'EF', new RegExp(`${B}ef\\s*[:=]?\\s*%?\\s*(\\d{1,2}(?:[.,]\\d+)?)(?!\\d)`, 'gi'));
  numbers(ECHO_COLUMNS.tapse, 'TAPSE', new RegExp(`${B}tapse\\s*[:=]?\\s*${NUM}`, 'gi'));
  numbers(ECHO_COLUMNS.ivc, 'VCI', new RegExp(`${B}(?:ivc|vci)\\s*[:=]?\\s*${NUM}`, 'gi'));
  numbers(ECHO_COLUMNS.pab, 'PAB', new RegExp(`${B}s?pab\\s*[:=]?\\s*${NUM}`, 'gi'));
  numbers(ECHO_COLUMNS.leftAtrium, 'Sol atriyum', new RegExp(`${B}sol\\s*atri[yu]?um(?:\\s+çapı)?\\s*[:=]?\\s*${NUM}`, 'gi'));

  const collapse = [...t.matchAll(/%\s*50\s*['’`]?\s*(?:d[ae]n)?\s*(fazla|az)\s+kollabe/gi)];
  const kinds = new Set(collapse.map((m) => lower(m[1])));
  if (kinds.size === 1) emit(ECHO_COLUMNS.ivcCollapse, kinds.has('fazla') ? 1 : 0, 'VCI kollabe', line);
  else if (kinds.size > 1) emit(ECHO_COLUMNS.ivcCollapse, null, 'VCI kollabe', line, 'Çelişkili ifade, yazılmadı');
  if (collapse.length > 0) found = true;

  const NEG = word('yok|yoktur|izlenmedi|saptanmadı|görülmedi|negatif');
  for (const clause of t.split(/[.;,](?!\d)/)) {
    const judge = (column: string, source: string, positive: RegExp) => {
      found = true;
      if (/\?/.test(clause)) return emit(column, null, source, line, 'Belirsiz ifade, yazılmadı');
      const neg = NEG.test(clause) || /:\s*[-–—]\s*$/.test(clause);
      const pos = positive.test(clause) || word('var|mevcut|izlendi|saptandı|görüldü|pozitif').test(clause);
      if (neg === pos) emit(column, null, source, line, 'var / yok anlaşılamadı, yazılmadı');
      else emit(column, neg ? 0 : 1, source, line);
    };
    if (/hipertro/i.test(clause) || new RegExp(`${B}(?:svh|lvh)(?![a-z])`, 'i').test(clause)) {
      judge('Sol_ventrikül_hipertrofisi', 'Sol ventrikül hipertrofisi', /hipertrofik/i);
    }
    if (/diyastolik\s+disfonksiyon/i.test(clause)) {
      judge('Diyastolik_disfonksiyon', 'Diyastolik disfonksiyon', /(?:evre|grade|tip)\s*[1-3i]/i);
    }
  }
  return found;
}

/** "Glukoz - 103 mg/dL" or "Glukoz: 103". Returns true if the line was a known lab test. */
function tryLab(line: string, emit: Emit): boolean {
  // Try every " - " / ":" position, so test names containing a dash still match.
  let mapping: ReturnType<typeof findLabMapping>;
  let valueText = '';
  for (const sep of line.matchAll(/\s[-–—]\s|:/g)) {
    const found = findLabMapping(line.slice(0, sep.index).trim());
    const rest = line.slice(sep.index! + sep[0].length).trim();
    if (found && rest !== '') {
      mapping = found;
      valueText = rest;
      break;
    }
  }
  if (!mapping) return false;
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
const NAME_LABEL =
  /^(?:ad[ıi]?\s*[-,]?\s*soyad[ıi]?|hasta(?:n[ıi]n)?\s+ad[ıi](?:\s*[-,]?\s*soyad[ıi]?)?|isim)\s*[:=\-–]\s*(.+)$/i;
const SEPARATOR = /^[.…_\-–—=*·•~\s]+$/;

/** Everything that reads a value from a content line (labs, rules, free text...). */
function readContent(line: string, columns: Map<string, string>, emit: Emit): boolean {
  if (tryLab(line, emit)) return true;
  const folded = fold(line);
  const rule = RULES.find((r) => r.test.test(folded));
  if (rule) {
    rule.apply(rule.test.exec(folded)!, emit, line);
    return true;
  }
  if (tryValveLine(line, emit)) return true;
  if (tryColumn(line, columns, emit)) return true;
  return scanText(line, emit);
}

function isKnown(line: string, columns: Map<string, string>): boolean {
  return (
    isPatientHeader(line) ||
    SEPARATOR.test(line) ||
    NAME_LABEL.test(fold(line)) ||
    KOMORBID.test(fold(line)) ||
    readContent(line, columns, () => {})
  );
}

/**
 * Splits the document into patient blocks. A block starts at "Ad soyad: ...", or at an
 * unrecognised line (the name) directly followed by a "Dosya No" / age / sex line.
 */
function splitPatients(lines: string[], columns: Map<string, string>): { name: string; body: string[] }[] {
  const blocks: { name: string; body: string[] }[] = [];
  let current: { name: string; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SEPARATOR.test(line)) continue;
    const label = NAME_LABEL.exec(fold(line));
    if (label) {
      current = { name: tailOf(line, label), body: [] };
      blocks.push(current);
      continue;
    }
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
    const emit: Emit = (column, value, source, raw, warning, onlyIfEmpty) => {
      // A warning without a column (e.g. unknown drug group) is shown as an unread line.
      if (column === '') unrecognized.push(`${raw} — ${warning}`);
      else observations.push({ column, value, raw, source, warnings: warning ? [warning] : [], ...(onlyIfEmpty ? { onlyIfEmpty } : {}) });
    };
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
        const text = tailOf(line, kom);
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
      if (readContent(line, columns, emit)) continue;
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
