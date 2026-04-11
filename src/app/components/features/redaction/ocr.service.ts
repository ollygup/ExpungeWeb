import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { OPS, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';
import { customLogger } from '../../../../utils/custom-logger';

interface PendingOcrJob {
  resolve:   (matches: OcrMatch[]) => void;
  reject:    (err: Error) => void;
  progress$: Subject<{ page: number; total: number }>;
}

// ── Added: extract-region worker message types ────────────────────────────────
interface ExtractRegionRequest {
  type: 'extractRegion';
  id:   string;
  blob: Blob;
}

interface ExtractRegionResponse {
  type:       'extractDone';
  id:         string;
  text:       string;
  confidence: number;
}

interface PendingExtractJob {
  resolve: (r: { text: string; confidence: number }) => void;
  reject:  (err: Error) => void;
}
// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OcrService implements OnDestroy {

  private worker: Worker | null = null;
  private pendingJobs    = new Map<string, PendingOcrJob>();
  private pendingExtracts = new Map<string, PendingExtractJob>(); // added

  constructor() { this.initWorker(); }

  private initWorker(): void {
    this.worker = new Worker(new URL('./ocr.worker', import.meta.url), { type: 'module' });

    this.worker.onmessage = (event: MessageEvent<OcrWorkerResponse | ExtractRegionResponse>) => {
      const msg = event.data;

      // ── Handle extract-region responses ──────────────────────────────────
      if (msg.type === 'extractDone') {
        const job = this.pendingExtracts.get(msg.id);
        if (job) {
          this.pendingExtracts.delete(msg.id);
          job.resolve({ text: msg.text, confidence: msg.confidence });
        }
        return;
      }

      // ── Handle findInImages responses (unchanged) ─────────────────────
      const searchMsg = msg as OcrWorkerResponse;
      const job = this.pendingJobs.get(searchMsg.id);
      if (!job) return;

      if (searchMsg.type === 'done') {
        job.progress$.complete();
        this.pendingJobs.delete(searchMsg.id);
        job.resolve(searchMsg.matches);
      } else if (searchMsg.type === 'error') {
        job.progress$.complete();
        this.pendingJobs.delete(searchMsg.id);
        job.reject(new Error(searchMsg.message));
      } else if (searchMsg.type === 'progress') {
        job.progress$.next({ page: searchMsg.page, total: searchMsg.total });
      }
    };

    this.worker.onerror = (err: ErrorEvent) =>
      customLogger.error('[OcrService] Worker error:', err.message);
  }

  // ── getImageRegions (unchanged) ───────────────────────────────────────────
  private async getImageRegions(
    page: PDFPageProxy,
  ): Promise<{ x: number; y: number; width: number; height: number }[]> {
    const ops = await page.getOperatorList();
    const regions: { x: number; y: number; width: number; height: number }[] = [];
    const ctmStack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    const mul = (m1: number[], m2: number[]): number[] => [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn   = ops.fnArray[i];
      const args = ops.argsArray[i];

      if (fn === OPS.save)      { ctmStack.push(ctm.slice()); continue; }
      if (fn === OPS.restore)   { ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0]; continue; }
      if (fn === OPS.transform) { ctm = mul(ctm, args as number[]); continue; }

      if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintImageXObjectRepeat ||
        fn === OPS.paintInlineImageXObject
      ) {
        const [a, , , d, e, f] = ctm;
        const displayW = Math.abs(a);
        const displayH = Math.abs(d);
        if (displayW > 0 && displayH > 0) {
          regions.push({
            x:      Math.min(e, e + a),
            y:      Math.min(f, f + d),
            width:  displayW,
            height: displayH,
          });
        }
      }
    }

    return regions;
  }

  // ── findInImages (unchanged) ──────────────────────────────────────────────
  async findInImages(
    pdfJsDoc:    PDFDocumentProxy,
    searchTerm:  string,
    totalPages:  number,
    onProgress?: (page: number, total: number) => void,
    ocrFullPage  = false,
  ): Promise<OcrMatch[]> {
    if (!this.worker) throw new Error('OCR worker not initialised');

    const regionBlobs: OcrPageBlob[] = [];
    const OCR_SCALE = 3;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        const page       = await pdfJsDoc.getPage(pageNum);
        const viewport1x = page.getViewport({ scale: 1 });
        const viewport   = page.getViewport({ scale: OCR_SCALE });

        const canvasW = Math.floor(viewport.width);
        const canvasH = Math.floor(viewport.height);
        if (canvasW <= 0 || canvasH <= 0) {
          customLogger.warn(`[OcrService] Page ${pageNum} has zero dimensions — skipping`);
          continue;
        }

        const canvas = new OffscreenCanvas(canvasW, canvasH);
        const ctx    = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot get 2D context for OCR canvas');

        const renderTask: RenderTask = page.render({
          canvas:        canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx    as unknown as CanvasRenderingContext2D,
          viewport,
        });
        await renderTask.promise;

        const imageRegions = ocrFullPage
          ? [{ x: 0, y: 0, width: canvasW, height: canvasH }]
          : await this.getImageRegions(page);

        customLogger.log(`[OcrService] Page ${pageNum}: ${imageRegions.length} image region(s)`);

        for (const region of imageRegions) {
          const canvasX  = Math.max(0, Math.floor(region.x * OCR_SCALE));
          const canvasY  = Math.max(0, Math.floor(
            (viewport1x.height - (region.y + region.height)) * OCR_SCALE
          ));
          const cropW    = Math.max(0, Math.ceil(region.width  * OCR_SCALE));
          const cropH    = Math.max(0, Math.ceil(region.height * OCR_SCALE));

          if (cropW <= 0 || cropH <= 0) continue;
          if (canvasX >= canvasW || canvasY >= canvasH) continue;

          const clampedW = Math.min(cropW, canvasW - canvasX);
          const clampedH = Math.min(cropH, canvasH - canvasY);
          if (clampedW <= 0 || clampedH <= 0) continue;

          const cropCanvas = new OffscreenCanvas(clampedW, clampedH);
          const cropCtx    = cropCanvas.getContext('2d');
          if (!cropCtx) continue;

          cropCtx.drawImage(canvas, canvasX, canvasY, clampedW, clampedH, 0, 0, clampedW, clampedH);

          regionBlobs.push({
            pageNum,
            blob:          await cropCanvas.convertToBlob({ type: 'image/png' }),
            pdfHeight1x:   viewport1x.height,
            scaleX:        canvasW / viewport1x.width,
            scaleY:        canvasH / viewport1x.height,
            offsetPixelX:  canvasX,
            offsetPixelY:  canvasY,
          });
        }

        onProgress?.(pageNum, totalPages);
      } catch (err) {
        customLogger.warn(`[OcrService] Failed processing page ${pageNum}:`, err);
      }
    }

    if (!regionBlobs.length) return [];

    const id        = crypto.randomUUID();
    const progress$ = new Subject<{ page: number; total: number }>();
    if (onProgress) progress$.subscribe(p => onProgress(p.page, p.total));

    return new Promise<OcrMatch[]>((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, progress$ });
      this.worker!.postMessage(
        { type: 'findInImages', id, pages: regionBlobs, searchTerm } satisfies OcrWorkerMessage,
      );
    });
  }

  // ── extractTextFromRegion (added) ─────────────────────────────────────────
  /**
   * OCRs a single arbitrary PDF-space rect on a given page.
   * Returns the full text found and a confidence score.
   *
   * Renders the page at 3× scale, crops the rect, sends the blob to the
   * worker as an 'extractRegion' message (see ocr.worker addition stub).
   */
  async extractTextFromRegion(
    pdfJsDoc: PDFDocumentProxy,
    pageNum:  number,
    pdfRect:  [number, number, number, number], // PDF space [x0,y0,x1,y1] bottom-left origin
  ): Promise<{ text: string; confidence: number }> {
    if (!this.worker) throw new Error('OCR worker not initialised');

    const OCR_SCALE = 3;
    const page      = await pdfJsDoc.getPage(pageNum);
    const vp1x      = page.getViewport({ scale: 1 });
    const vp        = page.getViewport({ scale: OCR_SCALE });

    const canvasW = Math.floor(vp.width);
    const canvasH = Math.floor(vp.height);

    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx    = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot get 2D context for OCR canvas');

    await page.render({
      canvas:        canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx    as unknown as CanvasRenderingContext2D,
      viewport:      vp,
    }).promise;

    // PDF rect (y-up, scale=1) → canvas pixel rect (y-down, OCR_SCALE)
    const [x0pdf, y0pdf, x1pdf, y1pdf] = pdfRect;

    const canvasX  = Math.max(0, Math.floor(x0pdf  * OCR_SCALE));
    const canvasY  = Math.max(0, Math.floor((vp1x.height - y1pdf) * OCR_SCALE));
    const cropW    = Math.max(1, Math.ceil((x1pdf - x0pdf) * OCR_SCALE));
    const cropH    = Math.max(1, Math.ceil((y1pdf - y0pdf) * OCR_SCALE));

    const clampedW = Math.min(cropW, canvasW - canvasX);
    const clampedH = Math.min(cropH, canvasH - canvasY);

    if (clampedW <= 0 || clampedH <= 0) {
      return { text: '', confidence: 0 };
    }

    const crop    = new OffscreenCanvas(clampedW, clampedH);
    const cropCtx = crop.getContext('2d')!;
    cropCtx.drawImage(canvas, canvasX, canvasY, clampedW, clampedH, 0, 0, clampedW, clampedH);

    const blob = await crop.convertToBlob({ type: 'image/png' });

    customLogger.log('[OcrService] extractTextFromRegion — page:', pageNum, 'size:', clampedW, 'x', clampedH);

    const id = crypto.randomUUID();

    return new Promise<{ text: string; confidence: number }>((resolve, reject) => {
      this.pendingExtracts.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'extractRegion', id, blob } satisfies ExtractRegionRequest);
    });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.pendingJobs.forEach(job => {
      job.reject(new Error('OcrService destroyed'));
      job.progress$.complete();
    });
    this.pendingJobs.clear();
    this.pendingExtracts.forEach(job => job.reject(new Error('OcrService destroyed')));
    this.pendingExtracts.clear();
  }
}