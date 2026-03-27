import type { OcrMatch } from '../redaction/redaction.types';

// One blob per image region (not per page — a page may contain multiple images).
export interface OcrPageBlob {
  pageNum:      number;
  blob:         Blob;
  pdfHeight1x:  number;
  scaleX:       number;
  scaleY:       number;
  // Pixel offset of this cropped region within the full rendered page.
  // The worker adds these back before converting OCR coords → PDF coords.
  offsetPixelX: number;
  offsetPixelY: number;
  preprocessScale:  number; // default 1
}

export type OcrWorkerMessage = {
  type:       'findInImages';
  id:         string;
  pages:      OcrPageBlob[];
  searchTerm: string;
};

export type OcrWorkerResponse =
  | { type: 'done';     id: string; matches: OcrMatch[] }
  | { type: 'error';    id: string; message: string      }
  | { type: 'progress'; id: string; page: number; total: number };