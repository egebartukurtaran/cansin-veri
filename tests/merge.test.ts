import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { applyPlan, buildPlan, type Plan } from '../src/merge';
import type { Observation, ParsedReport } from '../src/pdf/types';
import { findVariable, readSav, writeSav, type SavFile } from '../src/sav/sav';
import { parseDate } from '../src/util';
import { A_EKO, A_LABS, B_EKO, B_LABS, LIST, fixture, hasFixtures, parsed, patient } from './helpers';

const change = (plan: Plan, fileNo: string, column: string) =>
  plan.patients.find((p) => p.fileNo === fileNo)!.changes.find((c) => c.column === column);

// ---- synthetic data (runs in CI without patient fixtures) ----

function fakeSav(rows: Record<string, number | string | null>[]): SavFile {
  const vars: [string, number][] = [
    ['Adsoyad', 40], ['DosyaNo', 20], ['CinsiyetK1E2', 0], ['Yaş', 0], ['Kre', 0], ['Ferritin', 0], ['Boy', 0],
  ];
  const variables = vars.map(([name, width]) => ({ name, shortName: name, width, slots: width ? Math.ceil(width / 8) : 1 }));
  return {
    header: new Uint8Array(176),
    dictionary: new Uint8Array(0),
    ncases64Offset: -1,
    compression: 1,
    bias: 100,
    variables,
    rows: rows.map((r) => variables.map((v) => r[v.name] ?? (v.width ? '' : null))),
  };
}

function report(fileNo: string, date: string, obs: Partial<Observation>[], kind: 'lab' | 'eko' = 'lab', fileName = `${fileNo}-${date}.pdf`): ParsedReport {
  return {
    kind,
    fileName,
    patient: { name: 'TEST HASTA', fileNo, birth: parseDate('15/06/1950'), sex: 1 },
    date: parseDate(date)!,
    observations: obs.map((o) => ({ column: 'Kre', value: null, raw: '', source: 'Kreatinin', warnings: [], ...o })),
  };
}

describe('merge rules', () => {
  test('empty cell is written, same value is left alone, different value is a conflict', () => {
    const sav = fakeSav([{ DosyaNo: '1', Kre: null, Ferritin: 20, Yaş: 75, CinsiyetK1E2: 1, Adsoyad: 'TEST HASTA' }]);
    const plan = buildPlan(sav, [
      report('1', '31/03/2026 14:35', [{ column: 'Kre', value: 1.24 }, { column: 'Ferritin', value: 31.5, source: 'Ferritin' }]),
    ]);
    expect(change(plan, '1', 'Kre')!.status).toBe('write');
    expect(change(plan, '1', 'Ferritin')!.status).toBe('conflict');
    expect(change(plan, '1', 'Yaş')!.status).toBe('same');
    expect(change(plan, '1', 'CinsiyetK1E2')!.status).toBe('same');
    const out = applyPlan(sav, plan);
    expect(out.rows[0][findVariable(sav, 'Kre')]).toBe(1.24);
    expect(out.rows[0][findVariable(sav, 'Ferritin')]).toBe(20);
    expect(sav.rows[0][findVariable(sav, 'Kre')]).toBeNull(); // input untouched
  });

  test('most recent report wins', () => {
    const sav = fakeSav([{ DosyaNo: '1' }]);
    const plan = buildPlan(sav, [
      report('1', '01/01/2026 10:00', [{ value: 2.0 }]),
      report('1', '05/01/2026 10:00', [{ value: 1.5 }]),
      report('1', '03/01/2026 10:00', [{ value: 1.8 }]),
    ]);
    const c = change(plan, '1', 'Kre')!;
    expect(c.status).toBe('write');
    expect(c.proposed).toBe(1.5);
    expect(c.fileName).toBe('1-05/01/2026 10:00.pdf');
  });

  test('same date, different value → conflict', () => {
    const sav = fakeSav([{ DosyaNo: '1' }]);
    const plan = buildPlan(sav, [
      report('1', '01/01/2026 10:00', [{ value: 2.0 }], 'lab', 'a.pdf'),
      report('1', '01/01/2026 10:00', [{ value: 1.5 }], 'lab', 'b.pdf'),
    ]);
    expect(change(plan, '1', 'Kre')!.status).toBe('conflict');
    expect(plan.summary.conflicts).toBe(1);
    // Only demographics (name, sex, age) are written.
    expect(plan.patients[0].changes.filter((c) => c.status === 'write').map((c) => c.column).sort())
      .toEqual(['Adsoyad', 'CinsiyetK1E2', 'Yaş']);
  });

  test('unwritable newest value is not replaced by an older one', () => {
    const sav = fakeSav([{ DosyaNo: '1' }]);
    const plan = buildPlan(sav, [
      report('1', '01/01/2026 10:00', [{ value: 2.0 }]),
      report('1', '05/01/2026 10:00', [{ value: null, raw: '< 0,5', warnings: ['kesin değil'] }]),
    ]);
    const c = change(plan, '1', 'Kre')!;
    expect(c.status).toBe('skip');
    expect(c.messages).toContain('kesin değil');
  });

  test('new patient is appended at the end, empty rows untouched', () => {
    const sav = fakeSav([{ DosyaNo: '1' }, {}, {}]);
    const plan = buildPlan(sav, [report('77', '31/03/2026 14:35', [{ value: 1.1 }])]);
    const p = plan.patients[0];
    expect(p.isNew).toBe(true);
    const out = applyPlan(sav, plan);
    expect(out.rows).toHaveLength(4);
    const last = out.rows[3];
    const col = (n: string) => findVariable(sav, n);
    expect(last[col('DosyaNo')]).toBe('77');
    expect(last[col('Adsoyad')]).toBe('TEST HASTA');
    expect(last[col('CinsiyetK1E2')]).toBe(1);
    expect(last[col('Yaş')]).toBe(75);
    expect(last[col('Kre')]).toBe(1.1);
    expect(last[col('Boy')]).toBeNull();
    expect(out.rows[1]).toEqual(sav.rows[1]);
  });

  test('age uses the most recent lab date, not the echo date', () => {
    const sav = fakeSav([{ DosyaNo: '1' }]);
    const plan = buildPlan(sav, [
      report('1', '31/03/2026 14:35', []),
      report('1', '20/09/2026 10:00', [], 'eko'),
    ]);
    expect(change(plan, '1', 'Yaş')!.proposed).toBe(75);
    const onlyEcho = buildPlan(sav, [report('1', '20/09/2026 10:00', [], 'eko')]);
    expect(change(onlyEcho, '1', 'Yaş')!.proposed).toBe(76);
  });

  test('duplicate file number in the list → nothing written', () => {
    const sav = fakeSav([{ DosyaNo: '1' }, { DosyaNo: '1' }]);
    const plan = buildPlan(sav, [report('1', '31/03/2026 14:35', [{ value: 1.1 }])]);
    expect(plan.summary.toWrite).toBe(0);
    expect(plan.patients[0].messages.join()).toMatch(/2 satırda/);
  });

  test('columns missing from the list are reported, not written', () => {
    const sav = fakeSav([{ DosyaNo: '1' }]);
    const plan = buildPlan(sav, [report('1', '31/03/2026 14:35', [{ column: 'Hb', value: 13 }])]);
    expect(change(plan, '1', 'Hb')!.status).toBe('skip');
  });
});

// ---- real list + real PDFs ----

describe.skipIf(!hasFixtures(LIST, ...A_LABS, A_EKO, ...B_LABS, B_EKO))('merge with real fixtures', () => {
  const load = () => readSav(new Uint8Array(fs.readFileSync(fixture(LIST))));
  const all = () => Promise.all([...A_LABS, A_EKO, ...B_LABS, B_EKO].map(parsed));

  test('patient A: Ferritin and Yaş conflicts are not overwritten', async () => {
    const a = patient('A').fileNo;
    const sav = load();
    const plan = buildPlan(sav, await all());
    const ferritin = change(plan, a, 'Ferritin')!;
    expect(ferritin.status).toBe('conflict');
    expect(ferritin.current).toBe(20);
    expect(ferritin.proposed).toBe(31.5);
    const age = change(plan, a, 'Yaş')!;
    expect(age.status).toBe('conflict');
    expect(age.current).toBe(71);
    expect(age.proposed).toBe(70);
    expect(change(plan, a, 'Kre')!.status).toBe('same');
    expect(change(plan, a, 'ProBNP')!.status).toBe('write');
    expect(change(plan, a, 'EFyüzde')!.status).toBe('write');

    const out = applyPlan(sav, plan);
    const row = out.rows.find((r) => r[findVariable(sav, 'DosyaNo')] === a)!;
    expect(row[findVariable(sav, 'Ferritin')]).toBe(20);
    expect(row[findVariable(sav, 'Yaş')]).toBe(71);
    expect(row[findVariable(sav, 'ProBNP')]).toBe(1072);
  });

  test('patient B: existing row gets filled, age 86, sex 2', async () => {
    const b = patient('B').fileNo;
    const sav = load();
    const plan = buildPlan(sav, await all());
    const p = plan.patients.find((p) => p.fileNo === b)!;
    expect(p.isNew).toBe(false);
    expect(change(plan, b, 'Yaş')!.proposed).toBe(86);
    expect(change(plan, b, 'CinsiyetK1E2')!.proposed).toBe(2);
    expect(change(plan, b, 'Hb')!.proposed).toBe(12.6);
    expect(change(plan, b, 'Spotidraralbuminüri')!.status).toBe('skip');
    expect(change(plan, b, 'Sol_atriyum_çapı')!.status).toBe('skip');

    const out = applyPlan(sav, plan);
    expect(out.rows).toHaveLength(sav.rows.length);
    const back = readSav(writeSav(out));
    const row = back.rows.find((r) => r[findVariable(sav, 'DosyaNo')] === b)!;
    expect(row[findVariable(sav, 'Lökosit')]).toBe(5410);
    expect(row[findVariable(sav, 'pab')]).toBe(40);
    expect(row[findVariable(sav, 'Kapak_patolojisi')]).toBeNull();
  });
});
