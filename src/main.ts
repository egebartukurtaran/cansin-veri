import './style.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { applyPlan, buildPlan, displayValue, findColumn, type Change, type Plan, type Status } from './merge';
import { extractItems, parseItems, type PdfDocument } from './pdf/parse';
import type { ReportResult } from './pdf/types';
import { findVariable, readSav, writeSav, type SavFile } from './sav/sav';
import { readDocxLines } from './word/docx';
import { parseWordLines } from './word/notes';
import { clearLastHandle, loadLastHandle, saveLastHandle } from './storage';
import { formatDate } from './util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface ListState {
  name: string;
  handle: FileSystemFileHandle | null;
  sav: SavFile;
}

interface PdfEntry {
  key: string;
  name: string;
  /** A Word file can hold several patients. null while reading. */
  results: ReportResult[] | null;
}

const state = {
  list: null as ListState | null,
  pdfs: [] as PdfEntry[],
  plan: null as Plan | null,
  message: null as { kind: 'ok' | 'error'; text: string } | null,
  recent: null as FileSystemFileHandle | null,
  busy: false,
};

const hasFsAccess = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
const SAV_TYPES: FilePickerAcceptType[] = [{ description: 'SPSS veri dosyası', accept: { 'application/octet-stream': ['.sav'] } }];

// ---------- DOM helper ----------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---------- actions ----------

function setMessage(kind: 'ok' | 'error', text: string) {
  state.message = { kind, text };
}

function recompute() {
  state.plan =
    state.list && state.pdfs.length > 0 && state.pdfs.every((p) => p.results)
      ? buildPlan(state.list.sav, state.pdfs.flatMap((p) => p.results!))
      : null;
}

async function loadList(file: File, handle: FileSystemFileHandle | null) {
  try {
    const sav = readSav(await file.arrayBuffer());
    const missing = ['DosyaNo'].filter((c) => findVariable(sav, c) < 0);
    if (missing.length) throw new Error('Listede "DosyaNo" kolonu bulunamadı.');
    state.list = { name: file.name, handle, sav };
    state.message = null;
    if (handle) {
      await saveLastHandle(handle);
      state.recent = handle;
    }
  } catch (e) {
    setMessage('error', `Liste açılamadı: ${(e as Error).message}`);
  }
  recompute();
  render();
}

async function pickList() {
  if (!hasFsAccess) {
    const input = h('input', { type: 'file', accept: '.sav' });
    input.onchange = () => input.files?.[0] && loadList(input.files[0], null);
    input.click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker!({ types: SAV_TYPES, id: 'liste' });
    await loadList(await handle.getFile(), handle);
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') {
      setMessage('error', `Liste açılamadı: ${(e as Error).message}`);
      render();
    }
  }
}

async function continueRecent() {
  const handle = state.recent;
  if (!handle) return;
  try {
    const perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') {
      setMessage('error', 'Dosyaya erişim izni verilmedi.');
      render();
      return;
    }
    await loadList(await handle.getFile(), handle);
  } catch {
    await clearLastHandle();
    state.recent = null;
    setMessage('error', 'Son kullanılan dosya bulunamadı (taşınmış veya silinmiş olabilir). Lütfen listeyi seçin.');
    render();
  }
}

async function readPdf(file: File): Promise<ReportResult> {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      return parseItems(await extractItems(doc as unknown as PdfDocument), file.name);
    } finally {
      void doc.loadingTask.destroy();
    }
  } catch (e) {
    return { kind: 'unknown', fileName: file.name, reason: `PDF okunamadı (${(e as Error).message})` };
  }
}

async function readWord(file: File): Promise<ReportResult[]> {
  if (file.name.toLowerCase().endsWith('.doc')) {
    return [{ kind: 'unknown', fileName: file.name, reason: 'Eski Word biçimi (.doc). Word’de “Farklı Kaydet → .docx” ile kaydedip tekrar ekleyin' }];
  }
  try {
    const lines = await readDocxLines(new Uint8Array(await file.arrayBuffer()));
    const columns = state.list?.sav.variables.map((v) => v.name) ?? [];
    const reports = parseWordLines(lines, file.name, columns);
    return reports.length > 0 ? reports : [{ kind: 'unknown', fileName: file.name, reason: 'Word dosyasında hasta bulunamadı' }];
  } catch (e) {
    return [{ kind: 'unknown', fileName: file.name, reason: `Word dosyası okunamadı (${(e as Error).message})` }];
  }
}

const isWord = (f: File) => /\.docx?$/i.test(f.name);
const isPdf = (f: File) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf';

async function addPdfs(files: File[]) {
  const pdfs = files.filter((f) => isPdf(f) || isWord(f));
  const entries: { entry: PdfEntry; file: File }[] = [];
  for (const f of pdfs) {
    const key = `${f.name}|${f.size}|${f.lastModified}`;
    if (state.pdfs.some((p) => p.key === key)) continue;
    const entry: PdfEntry = { key, name: f.name, results: null };
    state.pdfs.push(entry);
    entries.push({ entry, file: f });
  }
  if (pdfs.length < files.length) setMessage('error', 'PDF veya Word olmayan dosyalar atlandı.');
  recompute();
  render();
  for (const { entry, file } of entries) {
    entry.results = isWord(file) ? await readWord(file) : [await readPdf(file)];
    recompute();
    render();
  }
}

function pickPdfs() {
  const input = h('input', { type: 'file', accept: '.pdf,.docx,.doc,application/pdf', multiple: true });
  input.onchange = () => input.files && addPdfs([...input.files]);
  input.click();
}

function suggestedName(original: string): string {
  const base = original.replace(/\.sav$/i, '').replace(/_\d{4}-\d{2}-\d{2}_\d{4}$/, '');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${base}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.sav`;
}

async function save() {
  const { list, plan } = state;
  if (!list || !plan || plan.summary.toWrite === 0) return;
  state.busy = true;
  render();
  try {
    const newSav = applyPlan(list.sav, plan);
    const bytes = writeSav(newSav);
    // Safety net: the file we just produced must read back to exactly what we meant to write.
    const check = readSav(bytes);
    if (JSON.stringify(check.rows) !== JSON.stringify(newSav.rows)) throw new Error('Doğrulama başarısız.');

    const name = suggestedName(list.name);
    if (hasFsAccess) {
      let handle: FileSystemFileHandle;
      try {
        handle = await window.showSaveFilePicker!({
          suggestedName: name,
          types: SAV_TYPES,
          id: 'liste',
          ...(list.handle ? { startIn: list.handle } : {}),
        });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        throw e;
      }
      if (list.handle && (await handle.isSameEntry(list.handle))) {
        setMessage('error', 'Orijinal listenin üzerine kaydedilemez. Lütfen yeni bir dosya adı seçin.');
        return;
      }
      const w = await handle.createWritable();
      await w.write(bytes as Uint8Array<ArrayBuffer>);
      await w.close();
      await saveLastHandle(handle);
      state.recent = handle;
      state.list = { name: handle.name, handle, sav: check };
    } else {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
      h('a', { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      state.list = { name, handle: null, sav: check };
    }
    const n = plan.summary.toWrite;
    state.pdfs = [];
    setMessage('ok', `Kaydedildi: ${state.list.name} (${n} değer yazıldı). Bu dosya artık kullanılan liste.`);
  } catch (e) {
    setMessage('error', `Kaydedilemedi: ${(e as Error).message}`);
  } finally {
    state.busy = false;
    recompute();
    render();
  }
}

// ---------- rendering ----------

const STATUS_LABEL: Record<Status, string> = {
  write: '✅ Yazılacak',
  same: '⚪ Zaten aynı',
  conflict: '⚠️ Çakışma (yazılmayacak)',
  skip: '⚠️ Uyarı (yazılmayacak)',
};

function renderList(): HTMLElement {
  const { list, recent } = state;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '1. Liste dosyası'),
    list
      ? h(
          'div',
          { class: 'row' },
          h('p', { class: 'loaded' }, '✔ ', h('strong', {}, list.name), ` — ${list.sav.rows.length} satır`),
          h('button', { class: 'secondary', onclick: pickList }, 'Başka liste seç'),
        )
      : h(
          'div',
          { class: 'row' },
          recent &&
            h('button', { class: 'primary', onclick: continueRecent }, `Son kullanılan: ${recent.name} — devam et`),
          h('button', { class: recent ? 'secondary' : 'primary', onclick: pickList }, 'Liste dosyasını seç (.sav)'),
        ),
  );
}

function renderPdfs(): HTMLElement {
  const disabled = !state.list;
  const zone = h(
    'div',
    { class: `drop${disabled ? ' disabled' : ''}`, onclick: () => !disabled && pickPdfs() },
    h('p', { class: 'big' }, 'PDF raporlarını veya Word dosyasını buraya sürükleyin'),
    h('p', {}, 'veya tıklayıp seçin (birden fazla seçebilirsiniz)'),
  );
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!disabled) zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (!disabled && e.dataTransfer) void addPdfs([...e.dataTransfer.files]);
  });

  const KIND: Record<string, string> = { lab: 'Laboratuvar', eko: 'Eko', word: 'Word' };
  const describe = (r: ReportResult) =>
    r.kind === 'unknown'
      ? `Tanınmadı — ${r.reason}`
      : [KIND[r.kind], r.patient.name, r.patient.fileNo && `(${r.patient.fileNo})`, r.date && formatDate(r.date)]
          .filter(Boolean)
          .join(' · ');
  const items = state.pdfs.map((p) => {
    const rs = p.results;
    const bad = rs?.some((r) => r.kind === 'unknown');
    const text = !rs ? 'okunuyor…' : rs.map(describe).join(' | ');
    return h('li', { class: bad ? 'bad' : '' }, h('strong', {}, p.name), ' — ', text);
  });

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '2. PDF raporları / Word dosyası'),
    disabled ? h('p', { class: 'muted' }, 'Önce liste dosyasını seçin.') : null,
    zone,
    items.length > 0 && h('ul', { class: 'files' }, ...items),
    items.length > 0 &&
      h(
        'button',
        {
          class: 'secondary',
          onclick: () => {
            state.pdfs = [];
            recompute();
            render();
          },
        },
        'Dosya listesini temizle',
      ),
  );
}

function renderChange(c: Change): HTMLElement {
  return h(
    'tr',
    { class: `st-${c.status}` },
    h('td', {}, c.column),
    h('td', {}, displayValue(c.current)),
    h('td', { class: 'new' }, displayValue(c.proposed)),
    h('td', { class: 'src' }, c.source, h('br'), h('small', {}, c.fileName)),
    h('td', {}, c.date ? formatDate(c.date) : ''),
    h(
      'td',
      {},
      STATUS_LABEL[c.status],
      ...c.messages.map((m) => h('div', { class: 'msg' }, (c.status === 'write' ? '⚠️ ' : '') + m)),
    ),
  );
}

function changeTable(changes: Change[]): HTMLElement {
  const headers = ['Kolon', 'Listedeki değer', 'Yeni değer', 'Kaynak', 'Tarih', 'Durum'];
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
      h('tbody', {}, ...changes.map(renderChange)),
    ),
  );
}

function renderPreview(): HTMLElement | null {
  const { plan, list } = state;
  if (!list || state.pdfs.length === 0) return null;
  if (!plan) return h('section', { class: 'card' }, h('h2', {}, '3. Önizleme'), h('p', {}, 'Dosyalar okunuyor…'));

  const s = plan.summary;
  const parts = [`${s.patients} hasta`, `${s.toWrite} değer yazılacak`];
  if (s.conflicts) parts.push(`${s.conflicts} çakışma`);
  if (s.warnings) parts.push(`${s.warnings} uyarı`);
  if (s.unrecognized) parts.push(`${s.unrecognized} tanınmayan dosya`);

  const order = (col: string) => {
    const i = findColumn(list.sav, col);
    return i < 0 ? 1e9 : i;
  };

  const cards = plan.patients.map((p) => {
    const changes = [...p.changes].sort((a, b) => order(a.column) - order(b.column));
    const important = changes.filter((c) => c.status !== 'same');
    const same = changes.filter((c) => c.status === 'same');
    return h(
      'div',
      { class: 'patient' },
      h(
        'h3',
        {},
        p.name || '(isimsiz)',
        p.fileNo && h('span', { class: 'fileno' }, ` · Dosya No ${p.fileNo}`),
        p.isNew
          ? h('span', { class: 'badge new' }, 'Yeni hasta')
          : p.rowIndex !== null
            ? h('span', { class: 'badge old' }, 'Mevcut hasta')
            : h('span', { class: 'badge bad' }, 'Eşleşmedi'),
      ),
      ...p.messages.map((m) => h('p', { class: 'warn' }, `⚠️ ${m}`)),
      p.unrecognized.length > 0 &&
        h(
          'details',
          {},
          h('summary', {}, `Word’de anlaşılamayan ${p.unrecognized.length} satır (bunlardan hiçbir şey yazılmadı)`),
          h('ul', { class: 'files' }, ...p.unrecognized.map((l) => h('li', {}, l))),
        ),
      important.length > 0 ? changeTable(important) : h('p', { class: 'muted' }, 'Yeni veya farklı değer yok.'),
      same.length > 0 &&
        h('details', {}, h('summary', {}, `Listede zaten aynı olan ${same.length} değeri göster`), changeTable(same)),
    );
  });

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '3. Önizleme'),
    h('p', { class: 'summary' }, parts.join(', ')),
    ...plan.failed.map((f) => h('p', { class: 'warn' }, `⚠️ Tanınmadı: ${f.fileName} — ${f.reason}`)),
    ...cards,
  );
}

function renderSave(): HTMLElement | null {
  const { plan, list } = state;
  if (!list) return null;
  const n = plan?.summary.toWrite ?? 0;
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '4. Kaydet'),
    h(
      'p',
      { class: 'muted' },
      'Değişiklikler yeni bir dosyaya kaydedilir. Orijinal liste değiştirilmez.',
    ),
    h(
      'button',
      { class: 'primary big', disabled: n === 0 || state.busy, onclick: save },
      state.busy ? 'Kaydediliyor…' : n > 0 ? `Yeni dosya olarak kaydet (${n} değer)` : 'Yazılacak değer yok',
    ),
  );
}

function render() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const msg = state.message;
  const parts: Child[] = [
    h(
      'header',
      {},
      h('h1', {}, 'Rapor → SPSS Listesi'),
      h('p', {}, 'Laboratuvar ve eko PDF’lerindeki değerleri araştırma listesine aktarır. Dosyalar bilgisayarınızdan çıkmaz.'),
    ),
    !hasFsAccess &&
      h(
        'p',
        { class: 'warn' },
        '⚠️ Bu tarayıcı dosya kaydetmeyi tam desteklemiyor. En iyi sonuç için Google Chrome kullanın.',
      ),
    msg && h('p', { class: msg.kind === 'ok' ? 'ok' : 'error' }, msg.text),
    renderList(),
    renderPdfs(),
    renderPreview(),
    renderSave(),
  ];
  app.replaceChildren(...parts.filter((x): x is Node => x instanceof Node));
}

// Prevent the browser from opening PDFs dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

render();
if (hasFsAccess) {
  void loadLastHandle().then((h) => {
    state.recent = h;
    render();
  });
}
