import type { OcrMatch } from '../redaction/redaction.types';

export interface OcrPageBlob {
  pageNum:      number;
  blob:         Blob;
  pdfHeight1x:  number;
  scaleX:       number;
  scaleY:       number;
  offsetPixelX: number;
  offsetPixelY: number;
}

export type OcrWorkerMessage = {
  type:       'findInImages';
  id:         string;
  pages:      OcrPageBlob[];
  searchTerm: string;
} | { type: 'extractRegion'; id: string; blob: Blob };

export type OcrWorkerResponse =
  | { type: 'done';     id: string; matches: OcrMatch[] }
  | { type: 'error';    id: string; message: string      }
  | { type: 'progress'; id: string; page: number; total: number }
  | { type: 'extractDone'; id: string; text: string; confidence: number };