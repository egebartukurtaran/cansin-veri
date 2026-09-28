import { describe, expect, test } from 'vitest';
import { decode1254, encode1254, tryEncode1254 } from '../src/sav/cp1254';
import { findLabMapping } from '../src/mapping';
import { ageAt, parseDate, parseTrNumber } from '../src/util';

describe('parseTrNumber', () => {
  test('Turkish decimals', () => {
    expect(parseTrNumber('4,95')).toBe(4.95);
    expect(parseTrNumber('1492')).toBe(1492);
    expect(parseTrNumber('13,0')).toBe(13);
  });
  test('scale is an exact decimal shift', () => {
    expect(parseTrNumber('5,99', 3)).toBe(5990);
    expect(parseTrNumber('0,45', 3)).toBe(450);
    expect(parseTrNumber('12', 3)).toBe(12000);
    expect(parseTrNumber('1,2345', 3)).toBe(1234.5);
  });
  test('rejects anything that is not a plain number', () => {
    for (const s of ['< 0,5', '>1', '*', '', '6,4x7,5', '1.492', 'Negatif', '-3']) {
      expect(parseTrNumber(s)).toBeNull();
    }
  });
});

describe('dates and age', () => {
  test('parses report dates', () => {
    expect(parseDate('31/03/2026 14:35')).toEqual({ day: 31, month: 3, year: 2026, hour: 14, minute: 35 });
    expect(parseDate('10/04/2026 16:24:00')).toMatchObject({ hour: 16, minute: 24 });
    expect(parseDate('xx')).toBeNull();
  });
  test('age is reduced by one before the birthday', () => {
    const birth = parseDate('15/06/1950')!;
    expect(ageAt(birth, parseDate('31/03/2026')!)).toBe(75);
    expect(ageAt(birth, parseDate('14/06/2026')!)).toBe(75);
    expect(ageAt(birth, parseDate('15/06/2026')!)).toBe(76);
    expect(ageAt(parseDate('20/02/1941')!, parseDate('19/02/2026')!)).toBe(84);
    expect(ageAt(parseDate('20/02/1941')!, parseDate('20/02/2026')!)).toBe(85);
  });
});

describe('windows-1254', () => {
  test('round-trips Turkish letters', () => {
    const s = 'ĞÜŞİÖÇ ğüşıöç ŞÜKRÜ IŞIK ÇİÇEK';
    expect(decode1254(encode1254(s))).toBe(s);
    expect(encode1254('İ')[0]).toBe(0xdd);
    expect(encode1254('ı')[0]).toBe(0xfd);
  });
  test('unrepresentable characters are rejected', () => {
    expect(tryEncode1254('日本')).toBeNull();
  });
});

describe('lab mapping is exact', () => {
  test('no partial matches', () => {
    expect(findLabMapping('Kreatinin')?.column).toBe('Kre');
    expect(findLabMapping('Kreatinin (Spot İdrar)')).toBeUndefined();
    expect(findLabMapping('Kolesterol, Non-HDL')).toBeUndefined();
    expect(findLabMapping('Kolesterol, HDL')?.column).toBe('HDL');
    expect(findLabMapping('  Kolesterol,   HDL ')?.column).toBe('HDL');
  });
});
