import { describe, expect, test } from 'vitest';
import { A_EKO, A_LABS, B_EKO, B_LABS, hasFixtures, parsed, patient, values } from './helpers';
import type { ParsedReport } from '../src/pdf/types';

const merged = async (files: string[]) => {
  const reports = await Promise.all(files.map(parsed));
  return { reports, v: Object.assign({}, ...reports.map(values)) as Record<string, number | null> };
};
const obs = (reports: ParsedReport[], column: string) =>
  reports.flatMap((r) => r.observations).find((o) => o.column === column)!;

describe.skipIf(!hasFixtures(...A_LABS))('lab: patient A', () => {
  test('header', async () => {
    const p = patient('A');
    const r = await parsed('a_biyokimya.pdf');
    expect(r.kind).toBe('lab');
    expect(r.patient).toEqual({ name: p.name, fileNo: p.fileNo, birth: p.birth, sex: 1 });
    // Numune Alma Zamanı, not İstek/Kabul/Onay.
    expect(r.date).toEqual(p.dates.labSample);
  });

  test('reference values', async () => {
    const { reports, v } = await merged(A_LABS);
    expect(v).toEqual({
      AKŞ: 83, Kre: 1.24, eGFR: 47, Ürik_asit: 4.95, Totalprotein: 7.7, Alb: 4.9, Na: 140, K: 3.9,
      Ca: 10.5, PO4: 4.6, AST: 23, ALT: 24, TG: 162, Totalkolesterol: 173, LDL: 75, HDL: 66, TS: 19,
      Hb: 13, PLT: 243, Lökosit: 5990, Nötrofil: 3850, Lenfosit: 1570,
      Ferritin: 31.5, ProBNP: 1072, Spotidraralbuminüri: 61, Spotidrarproteinüri: 209,
    });
    expect(obs(reports, 'K').warnings.join()).toMatch(/hemoliz/);
    expect(obs(reports, 'Na').warnings).toEqual([]);
  });

  test('negative: spot urine creatinine and non-HDL are not mapped', async () => {
    const { reports } = await merged(A_LABS);
    const sources = reports.flatMap((r) => r.observations.map((o) => o.source));
    expect(sources).not.toContain('Kreatinin (Spot İdrar)');
    expect(sources).not.toContain('Kolesterol, Non-HDL');
    expect(obs(reports, 'Kre').value).toBe(1.24);
    expect(obs(reports, 'HDL').value).toBe(66);
  });
});

describe.skipIf(!hasFixtures(...B_LABS))('lab: patient B', () => {
  test('hemogram ignores "Önceki Sonuçlar"', async () => {
    const p = patient('B');
    const r = await parsed('b_hemogram.pdf');
    expect(r.patient.fileNo).toBe(p.fileNo);
    expect(r.patient.sex).toBe(2);
    expect(r.date).toEqual(p.dates.hemogramSample);
    expect(values(r)).toEqual({ Hb: 12.6, PLT: 108, Lökosit: 5410, Nötrofil: 3550, Lenfosit: 1250 });
  });

  test('biochemistry ignores previous results', async () => {
    const v = values(await parsed('b_biyokimya.pdf'));
    expect(v.AKŞ).toBe(186);
    expect(v.Kre).toBe(1.85);
    expect(v.K).toBe(4.5);
  });

  test('non-numeric result ("*") is not written', async () => {
    const r = await parsed('b_idrar.pdf');
    const o = r.observations.find((o) => o.column === 'Spotidraralbuminüri')!;
    expect(o.value).toBeNull();
    expect(o.warnings.length).toBeGreaterThan(0);
    expect(values(r).Spotidrarproteinüri).toBe(1572);
  });
});

describe.skipIf(!hasFixtures(A_EKO))('eko: patient A', () => {
  test('values', async () => {
    const p = patient('A');
    const r = await parsed(A_EKO);
    expect(r.kind).toBe('eko');
    expect(r.patient).toMatchObject({ name: p.name, fileNo: p.fileNo, sex: 1 });
    expect(r.date).toEqual(p.dates.ekoDate);
    expect(values(r)).toEqual({
      EFyüzde: 60, e_a: 0, Sol_atriyum_çapı: 3.5, TAPSE: 23, VCI_çapı_ekspiryum: 23, VCI_kollabe: 1, pab: 36,
    });
    const cols = r.observations.map((o) => o.column);
    for (const c of ['Kapak_patolojisi', 'Kapak_patolojisi_tipi', 'Sol_ventrikül_hipertrofisi', 'Diyastolik_disfonksiyon']) {
      expect(cols).not.toContain(c);
    }
  });
});

describe.skipIf(!hasFixtures(B_EKO))('eko: patient B', () => {
  test('values; "6,4x7,5" left atrium is not written', async () => {
    const r = await parsed(B_EKO);
    expect(r.patient).toMatchObject({ fileNo: patient('B').fileNo, sex: 2 });
    expect(values(r)).toEqual({ EFyüzde: 60, e_a: 1, Sol_atriyum_çapı: null, pab: 40 });
  });
});
