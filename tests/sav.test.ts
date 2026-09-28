import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { findVariable, readSav, writeSav, type Cell } from '../src/sav/sav';
import { LIST, fixture, hasFixtures, patient } from './helpers';

const load = () => readSav(new Uint8Array(fs.readFileSync(fixture(LIST))));

function pythonWithPyreadstat(): string | null {
  for (const py of ['.venv/bin/python', 'python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import pyreadstat'], { stdio: 'ignore' });
      return py;
    } catch {
      /* try next */
    }
  }
  return null;
}

describe.skipIf(!hasFixtures(LIST))('sav', () => {
  test('reads dictionary and data', () => {
    const sav = load();
    expect(sav.variables).toHaveLength(77);
    expect(sav.variables.reduce((n, v) => n + v.slots, 0)).toBe(98);
    expect(sav.compression).toBe(1);
    expect(sav.bias).toBe(100);
    const dosya = findVariable(sav, 'DosyaNo');
    const a = patient('A');
    const row = sav.rows.find((r) => r[dosya] === a.fileNo)!;
    expect(row[findVariable(sav, 'Adsoyad')]).toBe(a.name);
    expect(row[findVariable(sav, 'Ferritin')]).toBe(20);
    expect(row[findVariable(sav, 'Yaş')]).toBe(71);
  });

  test('round-trip is byte-identical', () => {
    const original = new Uint8Array(fs.readFileSync(fixture(LIST)));
    expect(Buffer.compare(Buffer.from(writeSav(readSav(original))), Buffer.from(original))).toBe(0);
  });

  test('fill a cell and add a row', () => {
    const sav = load();
    const col = (n: string) => findVariable(sav, n);
    const b = patient('B').fileNo;
    const target = sav.rows.findIndex((r) => r[col('DosyaNo')] === b);
    sav.rows[target][col('Hb')] = 12.6;
    sav.rows[target][col('Lökosit')] = 5410;
    const newRow: Cell[] = sav.variables.map((v) => (v.width === 0 ? null : ''));
    newRow[col('Adsoyad')] = 'ŞÜKRÜ IŞIK ĞÜLİZAR';
    newRow[col('DosyaNo')] = '9999999';
    newRow[col('Kre')] = 1.24;
    newRow[col('Yaş')] = 70;
    sav.rows.push(newRow);

    const bytes = writeSav(sav);
    const back = readSav(bytes);
    expect(back.rows).toHaveLength(sav.rows.length);
    expect(back.rows).toEqual(sav.rows);

    const out = fixture('_test_output.sav');
    fs.writeFileSync(out, bytes);
    const py = pythonWithPyreadstat();
    if (py) {
      execFileSync(py, ['scripts/verify_sav.py', out, b], { stdio: 'inherit' });
    } else {
      console.warn('pyreadstat bulunamadı; scripts/verify_sav.py çalıştırılmadı.');
    }
  });
});
