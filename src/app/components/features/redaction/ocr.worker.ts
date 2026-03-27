// ── OCR Worker ────────────────────────────────────────────────────────────────
// Receives pre-rendered PNG blobs of individual image regions extracted by
// OcrService. Each blob corresponds to one embedded image XObject on a PDF page.
// Runs Scribe/Tesseract recognition entirely off the main thread.

import { customLogger } from '../../../../utils/custom-logger';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';

// ── Scribe instance ───────────────────────────────────────────────────────────
let scribe: any = null;
let scribeReady: Promise<void> | null = null;

async function ensureScribe(): Promise<void> {
  if (scribe) return;
  if (scribeReady) return scribeReady;

  scribeReady = (async () => {
    const url = new URL('/assets/scribe/scribe.js', self.location.origin);
    // @ts-ignore — no type declarations for scribe.js-ocr
    const mod = await import(/* @vite-ignore */ url.href);
    scribe = mod.default ?? mod;
    await scribe.init({
      pdf: false,
      ocr: true,
      ocrQuality: 'quality'
    });
  })();

  return scribeReady;
}

// ── Coordinate conversion ─────────────────────────────────────────────────────
// pixelRect coords must be in full-page pixel space (offset already added).
function pixelToPdfCoords(
  pixelRect: { x0: number; y0: number; x1: number; y1: number },
  scaleX: number,
  scaleY: number,
  pdfPageHeight: number,
): [number, number, number, number] {
  const x0 = pixelRect.x0 / scaleX;
  const y0 = pdfPageHeight - pixelRect.y1 / scaleY;
  const x1 = pixelRect.x1 / scaleX;
  const y1 = pdfPageHeight - pixelRect.y0 / scaleY;
  return [x0, y0, x1, y1];
}

function normaliseBbox(
  raw: any,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!raw) return null;
  if (typeof raw.left === 'number') return { x0: raw.left, y0: raw.top, x1: raw.right, y1: raw.bottom };
  if (typeof raw.x0  === 'number') return { x0: raw.x0,   y0: raw.y0,  x1: raw.x1,   y1: raw.y1   };
  if (Array.isArray(raw) && raw.length >= 4) return { x0: raw[0], y0: raw[1], x1: raw[2], y1: raw[3] };
  return null;
}

// ── Message handler ───────────────────────────────────────────────────────────
addEventListener('message', async (event: MessageEvent<OcrWorkerMessage>) => {
  const msg = event.data;
  if (msg.type !== 'findInImages') return;

  try {
    await ensureScribe();
    const matches = await findInImages(msg.pages, msg.searchTerm, msg.id);
    postMessage({ type: 'done', id: msg.id, matches } satisfies OcrWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    customLogger.error('[OcrWorker] job_error', { id: msg.id, message });
    postMessage({ type: 'error', id: msg.id, message } satisfies OcrWorkerResponse);
  }
});

// ── Core OCR pipeline ─────────────────────────────────────────────────────────
async function findInImages(
  pages: OcrPageBlob[],
  searchTerm: string,
  jobId: string,
): Promise<OcrMatch[]> {
  const matches: OcrMatch[] = [];
  const termLower = searchTerm.toLowerCase();
  const termWords = searchTerm.trim().toLowerCase().split(/\s+/);

  if (!pages.length) return matches;

  // ── Search each region result ─────────────────────────────────────────────
  for (let i = 0; i < pages.length; i++) {
    const { pageNum, pdfHeight1x, scaleX, scaleY, offsetPixelX, offsetPixelY, preprocessScale = 1 } = pages[i];
    const regionOcrStartMs = performance.now();

    postMessage({ type: 'progress', id: jobId, page: i + 1, total: pages.length } satisfies OcrWorkerResponse);

    try {
        await scribe.clear();
        await scribe.importFiles([new File([pages[i].blob], `region-${pageNum}-${i}.png`, { type: 'image/png' })]);
        await scribe.recognize();
      } catch (err) {
        customLogger.error('[OcrWorker] Scribe recognition failed on region:', err);
        customLogger.log(
          `[OcrWorker] page ${pageNum} region ${i + 1}/${pages.length} failed after ${(performance.now() - regionOcrStartMs).toFixed(2)} ms`,
        );
        continue;
      }

    const ocrPage = scribe.data?.ocr?.active?.[0];
    if (!ocrPage?.lines?.length) {
      customLogger.log(
        `[OcrWorker] page ${pageNum} region ${i + 1}/${pages.length} no lines after ${(performance.now() - regionOcrStartMs).toFixed(2)} ms`,
      );
      continue;
    }

    const allWords: Array<{
      text: string;
      bbox: { x0: number; y0: number; x1: number; y1: number };
      conf: number;
    }> = [];

    for (const line of ocrPage.lines) {
      for (const word of line.words ?? []) {
        if (!word?.text?.trim()) continue;
        const bbox = normaliseBbox(word.bbox ?? word);
        if (!bbox) continue;
        allWords.push({
          text: word.text,
          bbox,
          conf: word.conf ?? word.confidence ?? 0,
        });
      }
    }

    if (!allWords.length) {
      customLogger.log(
        `[OcrWorker] page ${pageNum} region ${i + 1}/${pages.length} no words after ${(performance.now() - regionOcrStartMs).toFixed(2)} ms`,
      );
      continue;
    }

    for (let j = 0; j <= allWords.length - termWords.length; j++) {
      const slice     = allWords.slice(j, j + termWords.length);
      const sliceText = slice.map(w => w.text.toLowerCase()).join(' ');

      if (sliceText !== termLower && !sliceText.includes(termLower)) continue;

      const word      = slice[0];
      const fullText  = word.text;
      const matchStart = fullText.toLowerCase().indexOf(termLower);
      const matchEnd   = matchStart + termLower.length;
      const ratio      = fullText.length;

      const bboxW = word.bbox.x1 - word.bbox.x0;
      const bboxH = word.bbox.y1 - word.bbox.y0;
      const padY  = bboxH * 0.10;
      const padX  = bboxW * 0.02;

      // Bbox coords from Scribe are in preprocessed-image pixel space.
      // Dividing by preprocessScale converts them back to original OCR-scale (×3) space
      // before adding the crop offset and feeding into pixelToPdfCoords().
      // Padding (padX/padY) is also in preprocessed space so must be divided too.
      const x0 = (word.bbox.x0 + (bboxW * matchStart / ratio) - padX) / preprocessScale + offsetPixelX;
      const x1 = (word.bbox.x0 + (bboxW * matchEnd   / ratio) + padX) / preprocessScale + offsetPixelX;
      const y0 = (word.bbox.y0 - padY) / preprocessScale + offsetPixelY;
      const y1 = (word.bbox.y1 + padY) / preprocessScale + offsetPixelY;

      const pdfRect = pixelToPdfCoords({ x0, y0, x1, y1 }, scaleX, scaleY, pdfHeight1x);

      if (
        pdfRect[0] < 0 || pdfRect[1] < 0 ||
        pdfRect[2] <= pdfRect[0] ||
        pdfRect[3] <= pdfRect[1]
      ) continue;

      const avgConf = Math.round(
        slice.reduce((s, w) => s + w.conf, 0) / slice.length,
      );

      matches.push({
        page:       pageNum,
        term:       searchTerm,
        context:    slice.map(w => w.text).join(' '),
        rect:       pdfRect,
        confidence: avgConf,
        checked:    false,
      });
    }

    customLogger.log(
      `[OcrWorker] page ${pageNum} region ${i + 1}/${pages.length} processed in ${(performance.now() - regionOcrStartMs).toFixed(2)} ms`,
    );
  }

  try { await scribe.clear(); } catch { /* best-effort */ }

  return matches;
}