import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { RedactionOptions, RedactionResult, WorkerResponse } from './redaction.types';

interface PendingJob {
  resolve: (result: RedactionResult) => void;
  reject: (err: Error) => void;
  progress$: Subject<{ page: number; total: number }>;
}

@Injectable({ providedIn: 'root' })
export class RedactionService implements OnDestroy {

  private worker: Worker | null = null;
  private pendingJobs = new Map<string, PendingJob>();

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    this.worker = new Worker(
      new URL('./redaction.worker', import.meta.url),
      { type: 'module' }
    );

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const job = this.pendingJobs.get(msg.id);
      if (!job) return;

      if (msg.type === 'done') {
        job.progress$.complete();
        this.pendingJobs.delete(msg.id);
        job.resolve(msg.result);
      } else if (msg.type === 'error') {
        job.progress$.complete();
        this.pendingJobs.delete(msg.id);
        job.reject(new Error(msg.message));
      } else if (msg.type === 'progress') {
        job.progress$.next({ page: msg.page, total: msg.total });
      }
    };

    this.worker.onerror = (err) => {
      console.error('[RedactionService] Worker error:', err);
    };
  }

  /**
   * Redacts all occurrences of `options.terms` in the given PDF bytes.
   *
   * @param pdfBytes  Raw bytes of the source PDF
   * @param options   Terms to redact + configuration
   * @param progress$ Optional Subject to receive per-page progress events
   * @returns         Promise resolving to redacted PDF bytes + stats
   */
  redact(
    pdfBytes: Uint8Array,
    options: RedactionOptions,
    progress$?: Subject<{ page: number; total: number }>
  ): Promise<RedactionResult> {
    if (!this.worker) throw new Error('Worker not initialised');
  
    const id = crypto.randomUUID();
    const progressSubject = progress$ ?? new Subject<{ page: number; total: number }>();
  
    // ✅ Guarantee a fresh, standalone, detachable ArrayBuffer
    const transferable = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;
  
    return new Promise<RedactionResult>((resolve, reject) => {
      this.pendingJobs.set(id, { resolve, reject, progress$: progressSubject });
  
      this.worker!.postMessage(
        { type: 'redact', id, pdfBytes: new Uint8Array(transferable), options },
        [transferable]  // transfer the fresh copy
      );
    });
  }

  /**
   * Trigger a browser download of the redacted PDF.
   *
   * FIX: Uint8Array.slice() always produces a view backed by a plain ArrayBuffer
   * (never a SharedArrayBuffer), which satisfies the BlobPart constraint and
   * eliminates the TS2345 / TS2322 errors on Blob construction.
   */
  downloadPDF(bytes: Uint8Array, filename = 'redacted.pdf'): void {
    // .slice() with no args copies the underlying data into a brand-new ArrayBuffer,
    // so TypeScript knows the buffer is ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer).
    const safeBytes = bytes.slice();
    const blob = new Blob([safeBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
    this.pendingJobs.forEach(job => {
      job.reject(new Error('Service destroyed'));
      job.progress$.complete();
    });
    this.pendingJobs.clear();
  }
}