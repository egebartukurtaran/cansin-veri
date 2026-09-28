/** Date parsed from a report; kept as components to avoid timezone surprises. */
export interface ReportDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DATE_RE = /^(\d{2})[./](\d{2})[./](\d{4})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/;

export function parseDate(text: string): ReportDate | null {
  const m = DATE_RE.exec(text.trim());
  if (!m) return null;
  const d: ReportDate = {
    day: +m[1],
    month: +m[2],
    year: +m[3],
    hour: m[4] ? +m[4] : 0,
    minute: m[5] ? +m[5] : 0,
  };
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) return null;
  return d;
}

/** Sortable key: larger = more recent. */
export function dateKey(d: ReportDate): number {
  return (((d.year * 100 + d.month) * 100 + d.day) * 100 + d.hour) * 100 + d.minute;
}

export function formatDate(d: ReportDate, withTime = true): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.day)}.${p(d.month)}.${d.year}`;
  return withTime && (d.hour || d.minute) ? `${s} ${p(d.hour)}:${p(d.minute)}` : s;
}

/** Full years between birth and the reference date. */
export function ageAt(birth: ReportDate, at: ReportDate): number {
  let age = at.year - birth.year;
  if (at.month < birth.month || (at.month === birth.month && at.day < birth.day)) age--;
  return age;
}

/**
 * Parses a Turkish-formatted plain number ("4,95", "1492", "13,0").
 * `scale` multiplies by 10^scale exactly (decimal shift, no float error).
 * Returns null for anything that is not a plain number.
 */
export function parseTrNumber(text: string, scale = 0): number | null {
  const m = /^(\d+)(?:,(\d+))?$/.exec(text.trim());
  if (!m) return null;
  let intPart = m[1];
  let frac = m[2] ?? '';
  for (let i = 0; i < scale; i++) {
    intPart += frac[0] ?? '0';
    frac = frac.slice(1);
  }
  const n = Number(frac ? `${intPart}.${frac}` : intPart);
  return Number.isFinite(n) ? n : null;
}

export function formatNumber(n: number): string {
  return String(n).replace('.', ',');
}
