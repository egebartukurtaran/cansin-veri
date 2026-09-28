import { isEkoReport, parseEko } from './eko';
import { isLabReport, parseLab } from './lab';
import type { ReportResult, TextItem } from './types';

/** Minimal shape of pdf.js text content we rely on. */
interface PdfTextContent {
  items: unknown[];
}
interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export async function extractItems(doc: PdfDocument): Promise<TextItem[]> {
  const items: TextItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const raw of tc.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number };
      if (!it.str || !it.str.trim() || !it.transform) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, page: p });
    }
  }
  return items;
}

export function parseItems(items: TextItem[], fileName: string): ReportResult {
  if (items.length === 0) {
    return { kind: 'unknown', fileName, reason: 'PDF içinde metin yok (taranmış belge olabilir)' };
  }
  if (isLabReport(items)) return parseLab(items, fileName);
  if (isEkoReport(items)) return parseEko(items, fileName);
  return { kind: 'unknown', fileName, reason: 'Laboratuvar veya eko raporu değil' };
}
