import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { applyPlan, buildPlan, findColumn, summarize, type Plan } from '../src/merge';
import { readSav, type SavFile } from '../src/sav/sav';
import { documentLines, readDocxLines } from '../src/word/docx';
import { parseAgeSex, parseTypedNumber, parseWordLines, parseYesNo } from '../src/word/notes';
import { fixture, hasFixtures, patient } from './helpers';

const COLUMNS = [
  'Adsoyad', 'DosyaNo', 'CinsiyetK1E2', 'Yaş', 'Boy', 'KBHsüresi', 'Komorbidite', 'DMYok0Var1', 'HTYok0Var1',
  'KAHYok0Var1', 'KOAHYok0Var1', 'SVOYok0Var1', 'pretibial_odem', 'SKBmmHg', 'DKBmmHg', 'glukoz', 'Kre', 'Lökosit',
  'PTH', 'CRP', 'HCO3', 'EFyüzde', 'Kapak_patolojisi', 'Kapak_patolojisi_tipi', 'Sol_ventrikül_hipertrofisi',
  'Diyastolik_disfonksiyon', 'e_a', 'Sol_atriyum_çapı',
];

const NOTE = [
  'AYŞE YILDIZ ',
  'Yaş: 60 ',
  'kadın',
  'Glukoz - 103 mg/dL',
  'Kreatinin - 1,25 mg/dL',
  'WBC (Lökosit) - 7,55 x10.e3/uL',
  'Kreatinin (Spot İdrar) - 67 mg/dL',
  'Kan Üre Azotu (BUN) - 21 mg/dL',
  'cHCO3(Pst)c (Venöz) - 22,1',
  'Parathormon - 36,8 pg/mL',
  'CRP Nefelometrik - < 0,5 mg/L',
  'Eko: ',
  'Ef: 60 ',
  'Kapak patolojisi yok ',
  'e/a 1den büyük ',
  'ventrikül hipertroi yok ',
  'diyastolik disfonksiyon yok',
  'sol atrium 3,3',
  'kbh süresi: 7',
  'komorbid: HT, DM, Hiperlipidemi',
  'Ofis Ta: 145 (skb) /85 (dkb)',
  'PTÖ: -',
  'boy: 162',
];

const values = (lines: string[]) => {
  const [r] = parseWordLines(lines, 'test.docx', COLUMNS);
  return { r, v: Object.fromEntries(r.observations.map((o) => [o.column, o.value])) };
};

describe('word notes', () => {
  test('reads demographics, labs, echo and clinical lines', () => {
    const { r, v } = values(NOTE);
    expect(r.patient).toEqual({ name: 'AYŞE YILDIZ', fileNo: '', birth: null, sex: 1 });
    expect(r.date).toBeNull();
    expect(v).toEqual({
      Yaş: 60, glukoz: 103, Kre: 1.25, Lökosit: 7550, HCO3: 22.1, PTH: 36.8, CRP: null,
      EFyüzde: 60, Kapak_patolojisi: 0, Kapak_patolojisi_tipi: '0', e_a: 1, Sol_ventrikül_hipertrofisi: 0,
      Diyastolik_disfonksiyon: 0, Sol_atriyum_çapı: 3.3, KBHsüresi: 7, Komorbidite: 'HT, DM, Hiperlipidemi',
      DMYok0Var1: 1, HTYok0Var1: 1, KAHYok0Var1: 0, KOAHYok0Var1: 0, SVOYok0Var1: 0,
      SKBmmHg: 145, DKBmmHg: 85, pretibial_odem: 0, Boy: 162,
    });
    // Unknown tests are reported, never guessed ("Kreatinin (Spot İdrar)" is not "Kreatinin").
    expect(r.unrecognized).toEqual(['Kreatinin (Spot İdrar) - 67 mg/dL', 'Kan Üre Azotu (BUN) - 21 mg/dL']);
  });

  test('valve pathology present, e/a below one, unclear hypertrophy', () => {
    const { v, r } = values([
      'X Y', 'Yaş: 50', 'erkek', 'Kapak patolojisi var: eser MY, eser TY', 'e/a 1den küçük', 'sol ventrikül hipertrofisi ?',
    ]);
    expect(r.patient.sex).toBe(2);
    expect(v.Kapak_patolojisi).toBe(1);
    expect(v.Kapak_patolojisi_tipi).toBe('eser MY, eser TY');
    expect(v.e_a).toBe(0);
    expect(v.Sol_ventrikül_hipertrofisi).toBeNull();
  });

  test('several patients in one file, with file numbers', () => {
    const reps = parseWordLines(
      ['HASTA BİR', 'Dosya No: 1111111', 'Yaş: 70', 'Kreatinin - 1,1', '', 'HASTA İKİ', 'Yaş: 65', 'Kreatinin - 2,2'],
      'x.docx',
      COLUMNS,
    );
    expect(reps.map((r) => [r.patient.name, r.patient.fileNo])).toEqual([['HASTA BİR', '1111111'], ['HASTA İKİ', '']]);
    expect(reps[1].observations.find((o) => o.column === 'Kre')!.value).toBe(2.2);
  });

  test('age and sex written in different ways', () => {
    const cases: [string, { age?: number; sex?: 1 | 2 }][] = [
      ['Yaş: 60', { age: 60 }],
      ['YAŞ : 60 yıl', { age: 60 }],
      ['Yas 60', { age: 60 }],
      ['Yaş - 60', { age: 60 }],
      ['60 yaşında', { age: 60 }],
      ['kadın', { sex: 1 }],
      ['KADIN', { sex: 1 }],
      ['Erkek', { sex: 2 }],
      ['Cinsiyet: K', { sex: 1 }],
      ['Cinsiyet - Erkek', { sex: 2 }],
      ['Cinsiyeti: kadın', { sex: 1 }],
      ['60 yaşında kadın hasta', { age: 60, sex: 1 }],
      ['60 yaş erkek', { age: 60, sex: 2 }],
      ['60/K', { age: 60, sex: 1 }],
      ['60 K', { age: 60, sex: 1 }],
      ['Kadın, 60', { age: 60, sex: 1 }],
      ['Yaş: 60, Cinsiyet: Erkek', { age: 60, sex: 2 }],
      ['bayan', { sex: 1 }],
    ];
    for (const [line, want] of cases) expect(parseAgeSex(line), line).toEqual(want);
    for (const line of ['e/a 1den büyük', 'Kreatinin - 1,25', 'Ef: 60', 'Ofis Ta: 145 (skb) /85 (dkb)', 'Yaş: 300', 'kbh süresi: 7']) {
      expect(parseAgeSex(line), line).toBeNull();
    }
  });

  test('age and sex in the patient block and on the name line', () => {
    const one = (lines: string[]) => parseWordLines(lines, 'x.docx', COLUMNS);
    const get = (lines: string[]) => {
      const reps = one(lines);
      expect(reps).toHaveLength(1);
      const r = reps[0];
      return { name: r.patient.name, sex: r.patient.sex, age: r.observations.find((o) => o.column === 'Yaş')?.value };
    };
    expect(get(['AYŞE YILDIZ', '60 yaşında kadın hasta', 'Kreatinin - 1,1'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });
    expect(get(['AYŞE YILDIZ', 'Cinsiyet: Kadın', 'Yaş: 60'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });
    expect(get(['AYŞE YILDIZ, 60, K', 'Kreatinin - 1,1'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });
    expect(get(['AYŞE YILDIZ (60 yaş kadın)', 'Kreatinin - 1,1'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });
    expect(get(['AYŞE YILDIZ 60 K', 'Kreatinin - 1,1'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });
    // Table layout: "Yaş | 60" rows become "Yaş - 60".
    expect(get(['AYŞE YILDIZ', 'Yaş - 60', 'Cinsiyet - Kadın'])).toEqual({ name: 'AYŞE YILDIZ', sex: 1, age: 60 });

    // Several patients, each starting with name + age/sex line.
    const reps = one(['HASTA BİR', 'erkek', 'Yaş: 70', 'Kreatinin - 1,1', 'HASTA İKİ, 65, K', 'Kreatinin - 2,2']);
    expect(reps.map((r) => [r.patient.name, r.patient.sex])).toEqual([['HASTA BİR', 2], ['HASTA İKİ', 1]]);
  });

  test('age and sex reach the list for a new patient and a matched one', () => {
    const sav = fakeSav([{ Adsoyad: 'AYŞE YILDIZ', DosyaNo: '555' }]);
    const plan = buildPlan(sav, [
      ...parseWordLines(['AYŞE YILDIZ', '60 yaşında kadın hasta'], 'a.docx', COLUMNS),
      ...parseWordLines(['MEHMET KAYA', 'Dosya No: 777', 'Erkek, 70'], 'b.docx', COLUMNS),
    ]);
    const rows = applyPlan(sav, plan).rows;
    expect(rows[0].slice(0, 4)).toEqual(['AYŞE YILDIZ', '555', 1, 60]);
    expect(rows[1].slice(0, 4)).toEqual(['MEHMET KAYA', '777', 2, 70]);
  });

  test('contradicting sex in one note is not written', () => {
    const [r] = parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'kadın', 'erkek'], 'x.docx', COLUMNS);
    expect(r.patient.sex).toBeNull();
  });

  test('helpers', () => {
    expect(parseTypedNumber('22.1')).toBe(22.1);
    expect(parseTypedNumber('1.492')).toBeNull();
    expect(parseYesNo('-')).toBe(0);
    expect(parseYesNo('+')).toBe(1);
    expect(parseYesNo('var')).toBe(1);
    expect(parseYesNo('belirsiz')).toBeNull();
  });
});

// ---- .docx container ----

function makeDocx(documentXml: string): Uint8Array {
  // Minimal zip with one deflated entry.
  const name = Buffer.from('word/document.xml');
  const data = Buffer.from(documentXml, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, name, comp, central, name, eocd]));
}

describe('docx reading', () => {
  test('paragraphs, runs, entities and table rows', async () => {
    const xml =
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>AYŞE </w:t></w:r><w:r><w:t xml:space="preserve">YILDIZ</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Yaş: 60</w:t></w:r></w:p>' +
      '<w:p/>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Protein, Total</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>7,3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>e/a &lt;1 &amp; ok</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    expect(documentLines(xml)).toEqual(['AYŞE YILDIZ', 'Yaş: 60', '', 'Protein, Total - 7,3', 'e/a <1 & ok']);
    expect(await readDocxLines(makeDocx(xml))).toEqual(documentLines(xml));
  });

  test('not a docx', async () => {
    await expect(readDocxLines(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});

// ---- merge rules specific to Word ----

function fakeSav(rows: Record<string, number | string | null>[]): SavFile {
  const vars: [string, number][] = [['Adsoyad', 40], ['DosyaNo', 20], ['CinsiyetK1E2', 0], ['Yaş', 0], ['Kre', 0], ['Komorbidite', 96]];
  const variables = vars.map(([name, width]) => ({ name, shortName: name, width, slots: width ? Math.ceil(width / 8) : 1 }));
  return {
    header: new Uint8Array(176), dictionary: new Uint8Array(0), ncases64Offset: -1, compression: 1, bias: 100, variables,
    rows: rows.map((r) => variables.map((v) => r[v.name] ?? (v.width ? '' : null))),
  };
}
const change = (plan: Plan, column: string) => plan.patients[0].changes.find((c) => c.column === column)!;

describe('merge with Word', () => {
  test('matched by name case-insensitively when there is no file number', () => {
    const sav = fakeSav([{ Adsoyad: 'ayşe yıldız', DosyaNo: '555' }]);
    const plan = buildPlan(sav, parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,25'], 'w.docx', COLUMNS));
    expect(plan.patients[0].rowIndex).toBe(0);
    expect(plan.patients[0].fileNo).toBe('555');
    expect(change(plan, 'Adsoyad').status).toBe('same');
    expect(change(plan, 'Kre').status).toBe('write');
  });

  test('unknown name without file number → nothing written, no new row', () => {
    const sav = fakeSav([{ Adsoyad: 'BAŞKA', DosyaNo: '1' }]);
    const plan = buildPlan(sav, parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,25'], 'w.docx', COLUMNS));
    expect(plan.summary.toWrite).toBe(0);
    expect(applyPlan(sav, plan).rows).toHaveLength(1);
  });

  test('new patient with a file number is added', () => {
    const sav = fakeSav([]);
    const plan = buildPlan(sav, parseWordLines(['AYŞE YILDIZ', 'Dosya No: 999', 'Yaş: 60', 'kadın', 'komorbid: ht'], 'w.docx', COLUMNS));
    const out = applyPlan(sav, plan);
    expect(out.rows).toEqual([['AYŞE YILDIZ', '999', 1, 60, null, 'ht']]);
  });

  test('Word wins over a PDF (on an empty cell it is a normal write, with a note)', () => {
    const sav = fakeSav([{ Adsoyad: 'AYŞE YILDIZ', DosyaNo: '555' }]);
    const word = parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,25'], 'w.docx', COLUMNS);
    const pdf = {
      kind: 'lab' as const, fileName: 'lab.pdf', date: { year: 2026, month: 3, day: 1, hour: 0, minute: 0 },
      patient: { name: 'AYŞE YILDIZ', fileNo: '555', birth: null, sex: null },
      observations: [{ column: 'Kre', value: 1.3, raw: '1,3', source: 'Kreatinin', warnings: [] }],
    };
    const plan = buildPlan(sav, [...word, pdf]);
    expect(plan.patients).toHaveLength(1);
    const c = change(plan, 'Kre');
    expect(c.status).toBe('write');
    expect(c.proposed).toBe(1.25);
    expect(c.messages.join()).toMatch(/PDF'te 1,3/);
  });

  test('Word replaces a different list value only while ticked', () => {
    const sav = fakeSav([{ Adsoyad: 'AYŞE YILDIZ', DosyaNo: '555', Kre: 1.3, Yaş: 60 }]);
    const plan = buildPlan(sav, parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,25'], 'w.docx', COLUMNS));
    const c = change(plan, 'Kre');
    expect(c.status).toBe('override');
    expect(c.selected).toBe(true);
    expect(plan.summary.toWrite).toBe(1);
    expect(applyPlan(sav, plan).rows[0][4]).toBe(1.25);

    c.selected = false;
    expect(summarize(plan.patients, 0).toWrite).toBe(0);
    expect(applyPlan(sav, plan).rows[0][4]).toBe(1.3);
  });

  test('two Word files disagreeing → conflict, nothing written', () => {
    const sav = fakeSav([{ Adsoyad: 'AYŞE YILDIZ', DosyaNo: '555' }]);
    const plan = buildPlan(sav, [
      ...parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,25'], 'a.docx', COLUMNS),
      ...parseWordLines(['AYŞE YILDIZ', 'Yaş: 60', 'Kreatinin - 1,4'], 'b.docx', COLUMNS),
    ]);
    expect(change(plan, 'Kre').status).toBe('conflict');
  });

  test('PDF-only conflicts with the list are still not overwritten', () => {
    const sav = fakeSav([{ Adsoyad: 'AYŞE YILDIZ', DosyaNo: '555', Kre: 2 }]);
    const pdf = {
      kind: 'lab' as const, fileName: 'lab.pdf', date: { year: 2026, month: 3, day: 1, hour: 0, minute: 0 },
      patient: { name: 'AYŞE YILDIZ', fileNo: '555', birth: null, sex: null },
      observations: [{ column: 'Kre', value: 1.3, raw: '1,3', source: 'Kreatinin', warnings: [] }],
    };
    expect(change(buildPlan(sav, [pdf]), 'Kre').status).toBe('conflict');
  });

  test('renamed column alias (AKŞ ↔ glukoz)', () => {
    const sav = fakeSav([]);
    sav.variables.push({ name: 'AKŞ', shortName: 'AKS', width: 0, slots: 1 });
    expect(findColumn(sav, 'glukoz')).toBe(sav.variables.length - 1);
    expect(findColumn(sav, 'yaş')).toBe(3);
  });
});

// ---- real Word file against the hand-entered list ----

describe.skipIf(!hasFixtures('c_word.docx', 'liste2.sav'))('real Word file', () => {
  test('matches the values entered by hand; differences become ticked overrides', async () => {
    const sav = readSav(new Uint8Array(fs.readFileSync(fixture('liste2.sav'))));
    const lines = await readDocxLines(new Uint8Array(fs.readFileSync(fixture('c_word.docx'))));
    const reports = parseWordLines(lines, 'c_word.docx', sav.variables.map((v) => v.name));
    expect(reports).toHaveLength(1);
    const plan = buildPlan(sav, reports);
    const p = plan.patients[0];
    expect(p.fileNo).toBe(patient('C').fileNo);
    expect(p.unrecognized).toEqual(['Kan Üre Azotu (BUN) - 21 mg/dL']);
    const overrides = p.changes.filter((c) => c.status === 'override').map((c) => c.column).sort();
    expect(overrides).toEqual(['CRP', 'Ferritin', 'HCO3', 'PTH', 'Spotidrarproteinüri', 'Ürik_asit'].sort());
    expect(p.changes.filter((c) => c.status === 'same')).toHaveLength(43);
    expect(plan.summary.conflicts).toBe(0);
    expect(plan.summary.toWrite).toBe(6);
  });
});
