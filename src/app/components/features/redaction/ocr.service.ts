import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { OPS } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';
import { customLogger } from '../../../../utils/custom-logger';

// ── Matrix helpers (avoids importing pdfjs Util separately) ──────────────────

function applyMatrix(p: [number, number], m: number[]): [number, number] {
  return [
    p[0] * m[0] + p[1] * m[2] + m[4],
    p[0] * m[1] + p[1] * m[3] + m[5],
  ];
}

function concatMatrix(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ImageRegion {
  x:      number;
  y:      number;
  width:  number;
  height: number;
}

interface PendingOcrJob {
  resolve:   (matches: OcrMatch[]) => void;
  reject:    (err: Error) => void;
  progress$: Subject<{ page: number; total: number }>;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OcrService implements OnDestroy {

  private worker: Worker | null = null;
  private pendingJobs = new Map<string, PendingOcrJob>();

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    this.worker = new Worker(
      new URL('./ocr.worker', import.meta.url),
      { type: 'module' },
    );

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

    this.worker.onerror = (err: ErrorEvent) => {
      customLogger.error('[OcrService] Worker error:', err.message, 'at', err.filename, 'line', err.lineno);
    };
  }

  // ── Extract image XObject bounding boxes from the page operator list ─────────
  // Walks the operator stream tracking the CTM so we know exactly where each
  // embedded image is painted on the canvas. Text operators are ignored entirely.
  private async getImageRegions(
    page: PDFPageProxy,
    viewport: PageViewport,
  ): Promise<ImageRegion[]> {
    const opList  = await page.getOperatorList();
    const regions: ImageRegion[] = [];

    const imageOps = new Set([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ]);

    const ctmStack: number[][] = [];
    let ctm: number[] = [1, 0, 0, 1, 0, 0];

    const { fnArray, argsArray } = opList;

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];

      if (fn === OPS.save) {
        ctmStack.push([...ctm]);

      } else if (fn === OPS.restore) {
        ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0];

      } else if (fn === OPS.transform) {
        // Concatenate the new matrix onto the current CTM
        ctm = concatMatrix(ctm, argsArray[i] as number[]);

      } else if (imageOps.has(fn)) {
        // An image occupies the unit square [0,0]→[1,1] in its own space.
        // Apply CTM to get PDF user-space coords, then viewport.transform
        // to get canvas pixel coords (includes scale + y-flip).
        const vt = viewport.transform as number[];
        const corners: [number, number][] = (
          [[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]
        ).map(p => applyMatrix(applyMatrix(p, ctm), vt));

        const xs = corners.map(p => p[0]);
        const ys = corners.map(p => p[1]);

        const x  = Math.max(0, Math.min(...xs));
        const y  = Math.max(0, Math.min(...ys));
        const x2 = Math.min(viewport.width,  Math.max(...xs));
        const y2 = Math.min(viewport.height, Math.max(...ys));

        const width  = x2 - x;
        const height = y2 - y;

        // Skip decorative/tiny images — unlikely to contain redactable text
        if (width > 16 && height > 16) {
          regions.push({
            x:      Math.floor(x),
            y:      Math.floor(y),
            width:  Math.ceil(width),
            height: Math.ceil(height),
          });
        }
      }
    }

    return regions;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // For each page, inspect the operator list to find embedded image XObjects.
  // Only those regions are rendered to PNG and sent to the OCR worker —
  // the PDF text layer is never rasterised, so Tesseract cannot confuse
  // selectable text with image content.
  // ─────────────────────────────────────────────────────────────────────────────
  async findInImages(
    pdfJsDoc: PDFDocumentProxy,
    searchTerm: string,
    totalPages: number,
    onProgress?: (page: number, total: number) => void,
  ): Promise<OcrMatch[]> {
    if (!this.worker) throw new Error('OCR worker not initialised');

    const regionBlobs: OcrPageBlob[] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        const page          = await pdfJsDoc.getPage(pageNum);
        const pdfViewport1x = page.getViewport({ scale: 1 });

        const OCR_SCALE = 3;
        const viewport  = page.getViewport({ scale: OCR_SCALE });
        const canvasW   = Math.floor(viewport.width);
        const canvasH   = Math.floor(viewport.height);

        // ── 1. Find image regions before touching the canvas ──────────────
        const imageRegions = await this.getImageRegions(page, viewport);

        if (!imageRegions.length) {
          customLogger.debug(`[OcrService] Page ${pageNum}: no embedded images — skipping`);
          continue;
        }

        // ── 2. Render full page once ──────────────────────────────────────
        const pageCanvas = new OffscreenCanvas(canvasW, canvasH);
        const pageCtx    = pageCanvas.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;

        await page.render({
          canvas:        null as unknown as HTMLCanvasElement,
          canvasContext: pageCtx,
          viewport,
        }).promise;

        // ── 3. Crop each image region to its own blob ─────────────────────
        const scaleX = canvasW / pdfViewport1x.width;
        const scaleY = canvasH / pdfViewport1x.height;

        for (const region of imageRegions) {
          const cropCanvas = new OffscreenCanvas(region.width, region.height);
          const cropCtx    = cropCanvas.getContext('2d')!;

          cropCtx.drawImage(
            pageCanvas,
            region.x, region.y, region.width, region.height,
            0,        0,        region.width, region.height,
          );

          const blob = await cropCanvas.convertToBlob({ type: 'image/png' });

          regionBlobs.push({
            pageNum,
            blob,
            pdfHeight1x:  pdfViewport1x.height,
            scaleX,
            scaleY,
            offsetPixelX: region.x,
            offsetPixelY: region.y,
          });
        }
      } catch (err) {
        customLogger.warn(`[OcrService] Failed processing page ${pageNum}:`, err);
      }
    }

    if (!regionBlobs.length) return [];

    // ── 4. Send all region blobs to worker ────────────────────────────────────
    const id              = crypto.randomUUID();
    const progressSubject = new Subject<{ page: number; total: number }>();

    if (onProgress) {
      progressSubject.subscribe(p => onProgress(p.page, p.total));
    }

    return new Promise<OcrMatch[]>((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, progress$: progressSubject });

      this.worker!.postMessage(
        { type: 'findInImages', id, pages: regionBlobs, searchTerm } satisfies OcrWorkerMessage,
      );
      // Blobs are structured-cloned (not transferable) — unavoidable.
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