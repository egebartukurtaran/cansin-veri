import { normalizeName } from '../mapping';
import type { TextItem } from './types';

/** Items on the same visual line as `ref` (same page, |dy| <= tol). */
export function sameRow(items: TextItem[], ref: TextItem, tol = 3): TextItem[] {
  return items
    .filter((it) => it.page === ref.page && Math.abs(it.y - ref.y) <= tol)
    .sort((a, b) => a.x - b.x);
}

export function findItems(items: TextItem[], pred: (s: string) => boolean): TextItem[] {
  return items.filter((it) => pred(normalizeName(it.str)));
}

export function findExact(items: TextItem[], text: string): TextItem[] {
  const t = normalizeName(text);
  return findItems(items, (s) => s === t);
}

/**
 * Text to the right of a label on the same line, before `maxX`.
 * Separator ':' items are skipped.
 */
export function valueRightOf(items: TextItem[], label: TextItem, maxX = Infinity): string {
  const start = label.x + label.width - 1;
  return normalizeName(
    sameRow(items, label)
      .filter((it) => it !== label && it.x > start && it.x < maxX && it.str.trim() !== ':')
      .map((it) => it.str)
      .join(' '),
  );
}

/** Groups items into lines (per page, top to bottom). */
export function lines(items: TextItem[], tol = 3): TextItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: TextItem[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last[0].page === it.page && Math.abs(last[0].y - it.y) <= tol) last.push(it);
    else out.push([it]);
  }
  for (const l of out) l.sort((a, b) => a.x - b.x);
  return out;
}

export function lineText(line: TextItem[]): string {
  return normalizeName(line.map((it) => it.str).join(' '));
}
