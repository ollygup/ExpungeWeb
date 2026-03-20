import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';
import { customLogger } from '../../../../utils/custom-logger';

interface PendingOcrJob {
  resolve:   (matches: OcrMatch[]) => void;
  reject:    (err: Error) => void;
  progress$: Subject<{ page: number; total: number }>;
}

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

  /**
   * Renders all pages using PDF.js on the main thread (PDF.js v4 cannot run
   * inside a worker), then transfers the PNG blobs to ocr.worker.ts for
   * Scribe/Tesseract recognition off the main thread.
   */
  async findInImages(
    pdfJsDoc: PDFDocumentProxy,
    searchTerm: string,
    totalPages: number,
    onProgress?: (page: number, total: number) => void,
  ): Promise<OcrMatch[]> {
    if (!this.worker) throw new Error('OCR worker not initialised');

    // ── Render all pages on main thread ──────────────────────────────────────
    const pages: OcrPageBlob[] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      onProgress?.(pageNum, totalPages);

      try {
        const page          = await pdfJsDoc.getPage(pageNum);
        const pdfViewport1x = page.getViewport({ scale: 1 });

        // 3× consistent scale — page height is not a reliable proxy for
        // font size on A4 documents (images are pasted on standard A4).
        const OCR_SCALE = 3;
        const viewport  = page.getViewport({ scale: OCR_SCALE });
        const canvasW   = Math.floor(viewport.width);
        const canvasH   = Math.floor(viewport.height);

        const canvas = new OffscreenCanvas(canvasW, canvasH);
        const ctx    = canvas.getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;

        await page.render({
          canvas:        null as unknown as HTMLCanvasElement,
          canvasContext: ctx,
          viewport,
        }).promise;

        const blob = await canvas.convertToBlob({ type: 'image/png' });

        pages.push({
          pageNum,
          blob,
          pdfHeight1x: pdfViewport1x.height,
          // Effective scale accounts for Math.floor on canvas dimensions
          scaleX: canvasW / pdfViewport1x.width,
          scaleY: canvasH / pdfViewport1x.height,
        });
      } catch (err) {
        customLogger.warn(`[OcrService] Render failed for page ${pageNum}:`, err);
      }
    }

    if (!pages.length) return [];

    // ── Transfer blobs to worker for recognition ──────────────────────────────
    const id             = crypto.randomUUID();
    const progressSubject = new Subject<{ page: number; total: number }>();

    // Forward worker progress back to caller
    if (onProgress) {
      progressSubject.subscribe(p => onProgress(p.page, p.total));
    }

    return new Promise<OcrMatch[]>((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, progress$: progressSubject });

      this.worker!.postMessage(
        { type: 'findInImages', id, pages, searchTerm } satisfies OcrWorkerMessage,
      );
      // Note: blobs are not transferable — they are structured-cloned.
      // This is unavoidable; ArrayBuffers could be transferred but Blob
      // API is more convenient and the copy is fast for PNG data.
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