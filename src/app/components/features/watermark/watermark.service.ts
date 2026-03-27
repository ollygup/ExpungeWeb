import { inject, Injectable } from '@angular/core';
import { customLogger } from '../../../../utils/custom-logger';
import type { WatermarkParams, WatermarkWorkerMsg, WatermarkWorkerRes } from './watermark.types';
import { PdfService } from '../../../services/pdf.service';

@Injectable({ providedIn: 'root' })
export class WatermarkService {
  private readonly pdfService = inject(PdfService);

  apply(params: WatermarkParams): Promise<void> {
    const bytes = this.pdfService.currentBytes();
    if (!bytes) return Promise.reject(new Error('No document loaded'));

    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('./watermark.worker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = ({ data }: MessageEvent<WatermarkWorkerRes>) => {
        worker.terminate();
        if (data.type === 'success') {
          this.pdfService.commitBytes(data.resultBytes);
          resolve();
        } else {
          reject(new Error(data.message));
        }
      };

      worker.onerror = (e) => {
        worker.terminate();
        customLogger.error('[WatermarkService]', e);
        reject(e);
      };

      const copy = bytes.buffer.slice(0) as ArrayBuffer;
      worker.postMessage(
        { type: 'apply', pdfBytes: new Uint8Array(copy), params } satisfies WatermarkWorkerMsg,
        [copy]
      );
    });
  }
}