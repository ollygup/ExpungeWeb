import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { OPS, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';
import { customLogger } from '../../../../utils/custom-logger';

interface PendingOcrJob {
  resolve: (matches: OcrMatch[]) => void;
  reject: (err: Error) => void;
  progress$: Subject<{ page: number; total: number }>;
}

@Injectable({ providedIn: 'root' })
export class OcrService implements OnDestroy {

  private worker: Worker | null = null;
  private pendingJobs = new Map<string, PendingOcrJob>();

  constructor() { this.initWorker(); }

  private initWorker(): void {
    this.worker = new Worker(new URL('./ocr.worker', import.meta.url), { type: 'module' });

    this.worker.onmessage = (event: MessageEvent<OcrWorkerResponse>) => {
      const msg = event.data;
      const job = this.pendingJobs.get(msg.id);
      if (!job) return;

      if (msg.type === 'done') {
        job.progress$.complete();
        this.pendingJobs.delete(msg.id);
        job.resolve(msg.matches);
      } else if (msg.type === 'error') {
        job.progress$.complete();
        this.pendingJobs.delete(msg.id);
        job.reject(new Error(msg.message));
      } else if (msg.type === 'progress') {
        job.progress$.next({ page: msg.page, total: msg.total });
      }
    };

    this.worker.onerror = (err: ErrorEvent) =>
      customLogger.error('[OcrService] Worker error:', err.message);
  }

  /**
   * Returns image regions in PDF user-space coordinates (y-up, scale=1).
   * The caller is responsible for converting to canvas space.
   *
   * Display size comes entirely from the CTM matrix (a unit square transformed by CTM).
   * obj.width/height are pixel dimensions of the image asset — irrelevant for display bounds.
   *
   * CTM [a, b, c, d, e, f]:
   *   - a = display width (with sign encoding h-flip)
   *   - d = display height (with sign encoding v-flip; typically negative for standard images)
   *   - e = x translation in PDF user space
   *   - f = y translation in PDF user space (y-up: f is the bottom when d < 0, top when d > 0)
   */
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
      const fn = ops.fnArray[i];
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
          // x: take the left edge (min of e and e+a in case a < 0)
          // y: PDF y-up — bottom of image in PDF space is min(f, f+d)
          regions.push({
            x: Math.min(e, e + a),
            y: Math.min(f, f + d),
            width: displayW,
            height: displayH,
          });
        }
      }
    }

    return regions;
  }

  async findInImages(
    pdfJsDoc: PDFDocumentProxy,
    searchTerm: string,
    totalPages: number,
    onProgress?: (page: number, total: number) => void,
    ocrFullPage = false,
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
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Cannot get 2D context for OCR canvas');

        const renderTask: RenderTask = page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        });
        await renderTask.promise;

        const imageRegions = ocrFullPage
          ? [{ x: 0, y: 0, width: canvasW, height: canvasH }]
          : await this.getImageRegions(page);

        customLogger.log(`[OcrService] Page ${pageNum}: ${imageRegions.length} image region(s)`);

        for (const region of imageRegions) {
          // Regions from getImageRegions are in PDF user-space at scale=1 (y-up).
          // Convert to canvas space (y-down) and scale by OCR_SCALE.
          //
          // PDF y-up → canvas y-down:
          //   canvas_y_top = viewport1x.height - (region.y + region.height)
          //
          // Then scale to OCR canvas resolution:
          const canvasX = Math.max(0, Math.floor(region.x * OCR_SCALE));
          const canvasY = Math.max(0, Math.floor(
            (viewport1x.height - (region.y + region.height)) * OCR_SCALE
          ));
          const cropW = Math.max(0, Math.ceil(region.width * OCR_SCALE));
          const cropH = Math.max(0, Math.ceil(region.height * OCR_SCALE));

          if (cropW <= 0 || cropH <= 0) continue;
          if (canvasX >= canvasW || canvasY >= canvasH) continue;

          const clampedW = Math.min(cropW, canvasW - canvasX);
          const clampedH = Math.min(cropH, canvasH - canvasY);
          if (clampedW <= 0 || clampedH <= 0) continue;

          const cropCanvas = new OffscreenCanvas(clampedW, clampedH);
          const cropCtx = cropCanvas.getContext('2d');
          if (!cropCtx) continue;

          cropCtx.drawImage(canvas, canvasX, canvasY, clampedW, clampedH, 0, 0, clampedW, clampedH);

          regionBlobs.push({
            pageNum,
            blob: await cropCanvas.convertToBlob({ type: 'image/png' }),
            pdfHeight1x: viewport1x.height,
            scaleX: canvasW / viewport1x.width,
            scaleY: canvasH / viewport1x.height,
            offsetPixelX: canvasX,
            offsetPixelY: canvasY,
          });
        }

        onProgress?.(pageNum, totalPages);
      } catch (err) {
        customLogger.warn(`[OcrService] Failed processing page ${pageNum}:`, err);
      }
    }

    if (!regionBlobs.length) return [];

    const id = crypto.randomUUID();
    const progress$ = new Subject<{ page: number; total: number }>();
    if (onProgress) progress$.subscribe(p => onProgress(p.page, p.total));

    return new Promise<OcrMatch[]>((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, progress$ });
      this.worker!.postMessage(
        { type: 'findInImages', id, pages: regionBlobs, searchTerm } satisfies OcrWorkerMessage,
      );
    });
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.pendingJobs.forEach(job => {
      job.reject(new Error('OcrService destroyed'));
      job.progress$.complete();
    });
    this.pendingJobs.clear();
  }
}