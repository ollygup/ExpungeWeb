export interface RedactionOptions {
    terms: string[];
    caseSensitive?: boolean;   // default: false
    fillColor?: [number, number, number]; // RGB 0–1, default black
    clearMetadata?: boolean;   // default: true
}

export interface RedactionResult {
    bytes: Uint8Array;
    matchCount: number;
    pagesAffected: number;
}

export type WorkerMessage =
    | { type: 'redact'; id: string; pdfBytes: Uint8Array; options: RedactionOptions }

export type WorkerResponse =
    | { type: 'done'; id: string; result: RedactionResult }
    | { type: 'error'; id: string; message: string }
    | { type: 'progress'; id: string; page: number; total: number }


export interface SearchMatch {
    page: number;
    context: string;   // surrounding text snippet shown in the UI
    term: string;
}