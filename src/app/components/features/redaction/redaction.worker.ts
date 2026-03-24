import type * as MuPDF from 'mupdf';
import { WorkerMessage, WorkerResponse, RedactionOptions, RedactionResult } from './redaction.types';
import { customLogger } from '../../../../utils/custom-logger';

let mupdf: typeof MuPDF;

async function loadMupdf(): Promise<void> {
  const url = new URL('/assets/mupdf/mupdf.js', self.location.href);
  const mod = await import(/* @vite-ignore */ url.href);

  mupdf = mod.default ?? mod;

  if (typeof mupdf?.Document?.openDocument !== 'function') {
    customLogger.error('[Worker] Available keys:', Object.keys(mupdf ?? {}));
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
  customLogger.log(`[Worker] Starting redaction job ${jobId} with options:`, options);
  
  const terms = options.terms;
  const fillColor = options.redactionMode === 'blendIn' ? [255, 255, 255] : [0, 0, 0];
  const clearMetadata = options.clearMetadata ?? false;
  const redactionMode = options.redactionMode === 'redact' ? 'redact' : 'blendIn';
  const ocrRects = options.ocrRects ? options.ocrRects : [];

  customLogger.log(`[Worker] Updated value for fillColor: ${fillColor}, redactionMode: ${redactionMode}`);

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
    const bounds = page.getBounds(); // [x0, y0, x1, y1] — the actual MuPDF page bounds
    customLogger.log(`[Worker] Page ${pageIndex} bounds:`, bounds);
    let pageHadMatch = false;

    let pagePixmap: MuPDF.Pixmap | null = null;
    if (redactionMode === 'blendIn') {
      try {
        pagePixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, true);
        customLogger.log(`[Worker] PagePixmap: ${pagePixmap}`);
      } catch (err) {
        customLogger.warn('[Worker] Failed to render pixmap for blendIn mode:', err);
      }
    }

    const blendInOverlays: Array<{ rect: MuPDF.Rect; color: [number, number, number] }> = [];

    // ── Text-based redaction ───────────────────────────────────────────────
    // Uses MuPDF's built-in text search — accurate, no OCR needed.
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

          const color = redactionMode === 'blendIn' && pagePixmap
            ? sampleBackgroundColor(pagePixmap, rect, bounds, 2)
            : fillColor;

          customLogger.log(`[Worker] Color: ${color}`);
          customLogger.log(`[Worker] redactionMode: ${redactionMode}`);

          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
          annot.update();

          if (redactionMode === 'blendIn') {
            blendInOverlays.push({ rect, color: color as [number, number, number] });
          }

          totalMatches++;
          pageHadMatch = true;
        }
      }
    }

    // ── OCR rect-based redaction ───────────────────────────────────────────
    const pageOcrRects = ocrRects.filter(r => r.pageIndex === pageIndex);
    for (const { rect } of pageOcrRects) {
      const bounds = page.getBounds();
      const pageHeight = bounds[3];

      // MuPDF WASM reads the coordinate in opposite direction, aka (0 starts from top)
      // while in PDF (0 starts from bottom, top is 9xx etc)
      const mupdfRect: MuPDF.Rect = [
        rect[0],
        pageHeight - rect[3], // flip: PDF y1 (top in PDF) → MuPDF y0 (top in MuPDF)
        rect[2],
        pageHeight - rect[1], // flip: PDF y0 (bottom in PDF) → MuPDF y1 (bottom in MuPDF)
      ];

      const color = redactionMode === 'blendIn' && pagePixmap
        ? sampleBackgroundColor(pagePixmap, mupdfRect, bounds, 2)
        : fillColor;

      customLogger.log(`[Worker] Color: ${color}`);
      customLogger.log(`[Worker] redactionMode: ${redactionMode}`);

      const annot = page.createAnnotation('Redact');
      annot.setRect(mupdfRect);
      annot.update();

      if (redactionMode === 'blendIn') {
        blendInOverlays.push({ rect: mupdfRect, color: color as [number, number, number] });
      }
      totalMatches++;
      pageHadMatch = true;
    }

    if (pageHadMatch) {
      page.applyRedactions(true, 2);

      const padding = 2;

      if (redactionMode === 'blendIn') {
        for (const { rect, color } of blendInOverlays) {
          const expandedRect: MuPDF.Rect = [
            rect[0] - padding, // x0 left
            rect[1] - padding, // y0 bottom
            rect[2] + padding, // x1 right
            rect[3] + padding, // y1 top
          ];
          const overlayAnnot = page.createAnnotation('Square');
          overlayAnnot.setRect(expandedRect);

          const normalizedColor = toAnnotColor(color);
          overlayAnnot.setColor(normalizedColor);
          overlayAnnot.setInteriorColor(normalizedColor);

          overlayAnnot.setBorderWidth(0);
          overlayAnnot.setOpacity(1);
          overlayAnnot.update();
        }
      }
      affectedPages.add(pageIndex);
    }
  }

  if (clearMetadata) stripMetadata(doc);

  const rawBytes = doc.saveToBuffer('garbage=3,compress').asUint8Array();
  const outBytes = new Uint8Array(rawBytes.buffer.slice(
    rawBytes.byteOffset,
    rawBytes.byteOffset + rawBytes.byteLength,
  ));
  return { bytes: outBytes, matchCount: totalMatches, pagesAffected: affectedPages.size };
}

function sampleBackgroundColor(
  pixmap: MuPDF.Pixmap,
  rect: MuPDF.Rect,
  bounds: MuPDF.Rect,
  scale: number,
): [number, number, number] {
  try {
    const [x0, y0, x1, y1] = rect;
    const [bx0, by0] = bounds;

    const px0 = Math.max(0, Math.floor((x0 - bx0) * scale));
    const py0 = Math.max(0, Math.floor((y0 - by0) * scale));
    const px1 = Math.min(pixmap.getWidth() - 1, Math.floor((x1 - bx0) * scale));
    const py1 = Math.min(pixmap.getHeight() - 1, Math.floor((y1 - by0) * scale));

    let r = 255, g = 255, b = 255;
    const pixels = pixmap.getPixels();
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const n = pixmap.getNumberOfComponents();

    if (pixels && n >= 3) {
      let count = 0;
      let sumR = 0, sumG = 0, sumB = 0;

      const sample = (px: number, py: number) => {
        if (px < 0 || px >= width || py < 0 || py >= height) return;

        const idx = (py * width + px) * n;

        const sr = pixels[idx];
        const sg = pixels[idx + 1];
        const sb = pixels[idx + 2];

        // skip likely text (dark pixels)
        if (sr < 40 && sg < 40 && sb < 40) return;

        sumR += sr;
        sumG += sg;
        sumB += sb;
        count++;
      };

      // sample just outside the rect

      // top
      for (let px = px0; px <= px1; px++) {
        sample(px, py0 - 1);
      }

      // bottom
      for (let px = px0; px <= px1; px++) {
        sample(px, py1 + 1);
      }

      // left
      for (let py = py0; py <= py1; py++) {
        sample(px0 - 1, py);
      }

      // right
      for (let py = py0; py <= py1; py++) {
        sample(px1 + 1, py);
      }

      if (count > 0) {
        r = Math.round(sumR / count);
        g = Math.round(sumG / count);
        b = Math.round(sumB / count);
      }
    }

    return [r, g, b];
  } catch {
    return [255, 255, 255];
  }
}
function toAnnotColor(color: [number, number, number]): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp(color[0] / 255), clamp(color[1] / 255), clamp(color[2] / 255)];
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