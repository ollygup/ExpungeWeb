export interface SearchMatch {
    page: number;
    context: string;
    term: string;
    // PDF-space rect extracted from PDF.js text items — used for highlight overlay.
    // May be undefined if the text item couldn't be mapped to a position.
    rect?: [number, number, number, number];
  }
  
  export interface OcrMatch {
    page: number;
    term: string;
    context: string;
    // PDF-space coordinates in points (origin bottom-left, matches MuPDF coordinate system)
    rect: [number, number, number, number];
    confidence: number;
    checked: boolean; // always defaults to false — OCR can be inaccurate
  }
  
  export interface RedactionOptions {
    terms: string[];
    fillColor?: [number, number, number];
    clearMetadata?: boolean;
    caseSensitive?: boolean;
    // Pre-computed rects from OCR (pageIndex is 0-indexed to match MuPDF worker)
    ocrRects?: { pageIndex: number; rect: [number, number, number, number] }[];
  }
  
  export interface RedactionResult {
    bytes: Uint8Array;
    matchCount: number;
    pagesAffected: number;
  }
  
  // ── Worker message contracts ───────────────────────────────────────────────
  
  export type WorkerMessage =
    | { type: 'redact'; id: string; pdfBytes: Uint8Array; options: RedactionOptions };
  
  export type WorkerResponse =
    | { type: 'done';     id: string; result: RedactionResult }
    | { type: 'error';    id: string; message: string }
    | { type: 'progress'; id: string; page: number; total: number };