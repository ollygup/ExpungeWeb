import type * as MuPDF from 'mupdf';
import { WorkerMessage, WorkerResponse, RedactionOptions, RedactionResult } from './redaction.types';

let mupdf: typeof MuPDF;

async function loadMupdf(): Promise<void> {
  const url = new URL('/assets/mupdf/mupdf.js', self.location.href);
  const mod = await import(/* @vite-ignore */ url.href);

  mupdf = mod.default ?? mod;

  if (typeof mupdf?.Document?.openDocument !== 'function') {
    console.error('[Worker] Available keys:', Object.keys(mupdf ?? {}));
    throw new Error('mupdf failed to initialize correctly');
  }
}
const mupdfReady = loadMupdf();

addEventListener('message', async (event: MessageEvent) => {
  const msg = event.data as WorkerMessage;
  if (msg.type !== 'redact') return;

  try {
    await mupdfReady;
    const result = await performRedaction(msg.pdfBytes, msg.options, msg.id);
    postMessage(
      { type: 'done', id: msg.id, result } satisfies WorkerResponse,
      { transfer: [result.bytes.buffer.slice(0)] },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    postMessage({ type: 'error', id: msg.id, message } satisfies WorkerResponse);
  }
});

async function performRedaction(
  pdfBytes: Uint8Array,
  options: RedactionOptions,
  jobId: string,
): Promise<RedactionResult> {
  const {
    terms,
    fillColor = [0, 0, 0],
    clearMetadata = true,
  } = options;

  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf') as MuPDF.PDFDocument;
  let totalMatches = 0;
  const affectedPages = new Set<number>();
  const pageCount = doc.countPages();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    postMessage({
      type: 'progress',
      id: jobId,
      page: pageIndex + 1,
      total: pageCount,
    } satisfies WorkerResponse);

    const page = doc.loadPage(pageIndex) as MuPDF.PDFPage;
    let pageHadMatch = false;

    for (const term of terms) {
      const matchGroups = page.search(term) as unknown as number[][][];
      if (!matchGroups?.length) continue;

      for (const quadList of matchGroups) {
        for (const quad of quadList) {
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const rect: MuPDF.Rect = [
            Math.min(...xs), Math.min(...ys),
            Math.max(...xs), Math.max(...ys),
          ];

          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
          annot.setColor(fillColor);
          annot.update();

          totalMatches++;
          pageHadMatch = true;
        }
      }
    }

    if (pageHadMatch) {
      page.applyRedactions(true, 1);
      affectedPages.add(pageIndex);
    }
  }

  if (clearMetadata) stripMetadata(doc);

  const rawBytes = doc.saveToBuffer('garbage=3,compress').asUint8Array();
  const outBytes = new Uint8Array(rawBytes.buffer.slice(
    rawBytes.byteOffset,
    rawBytes.byteOffset + rawBytes.byteLength
  ));
  return { bytes: outBytes, matchCount: totalMatches, pagesAffected: affectedPages.size };
}

function stripMetadata(doc: MuPDF.PDFDocument): void {
  const fields = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
  try {
    const infoRef = doc.getTrailer().get('Info');
    if (infoRef) {
      const info = infoRef.resolve();
      for (const field of fields) {
        try { if (info.get(field)) info.delete(field); } catch { /* best-effort */ }
      }
    }
    const catalog = doc.getTrailer().get('Root')?.resolve();
    if (catalog?.get('Metadata')) catalog.delete('Metadata');
  } catch { /* best-effort */ }
}