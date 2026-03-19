import { OcrMatch } from '../redaction/redaction.types';

export interface OcrPageBlob {
    pageNum: number;
    blob: Blob;
    pdfHeight1x: number; // PDF points at scale=1, needed for coord conversion
    scaleX: number; // effective horizontal scale (canvas.width / page.width)
    scaleY: number; // effective vertical scale (canvas.height / page.height)
}

// ── Messages sent TO the worker ────────────────────────────────────────────
export type OcrWorkerMessage =
    | {
        type: 'findInImages';
        id: string;
        pages: OcrPageBlob[];
        searchTerm: string;
    };

// ── Messages received FROM the worker ─────────────────────────────────────
export type OcrWorkerResponse =
    | { type: 'done'; id: string; matches: OcrMatch[] }
    | { type: 'error'; id: string; message: string }
    | { type: 'progress'; id: string; page: number; total: number };