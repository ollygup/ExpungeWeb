// ── OCR Worker ────────────────────────────────────────────────────────────────
// Receives pre-rendered PNG blobs from the main thread (PDF.js cannot run
// inside a worker in PDF.js v4 due to sub-worker restrictions).
// Runs Scribe/Tesseract recognition entirely off the main thread.

import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';

// ── Scribe instance ───────────────────────────────────────────────────────────
let scribe: any = null;
let scribeReady: Promise<void> | null = null;

async function ensureScribe(): Promise<void> {
    if (scribe) return;
    if (scribeReady) return scribeReady;

    scribeReady = (async () => {
        const url = new URL('/assets/scribe/scribe.js', self.location.origin);
        // @ts-ignore — no type declarations for scribe.js-ocr
        const mod = await import(/* @vite-ignore */ url.href);
        scribe = mod.default ?? mod;
        await scribe.init({ pdf: false, ocr: true });
    })();

    return scribeReady;
}

// ── Coordinate conversion ─────────────────────────────────────────────────────
function pixelToPdfCoords(
    pixelRect: { x0: number; y0: number; x1: number; y1: number },
    scaleX: number,
    scaleY: number,
    pdfPageHeight: number,
): [number, number, number, number] {
    const x0 = pixelRect.x0 / scaleX;
    const y0 = pdfPageHeight - pixelRect.y1 / scaleY;
    const x1 = pixelRect.x1 / scaleX;
    const y1 = pdfPageHeight - pixelRect.y0 / scaleY;
    return [x0, y0, x1, y1];
}

function normaliseBbox(
    raw: any,
): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!raw) return null;
    if (typeof raw.left === 'number') return { x0: raw.left, y0: raw.top, x1: raw.right, y1: raw.bottom };
    if (typeof raw.x0 === 'number') return { x0: raw.x0, y0: raw.y0, x1: raw.x1, y1: raw.y1 };
    if (Array.isArray(raw) && raw.length >= 4) return { x0: raw[0], y0: raw[1], x1: raw[2], y1: raw[3] };
    return null;
}

// ── Message handler ───────────────────────────────────────────────────────────
addEventListener('message', async (event: MessageEvent<OcrWorkerMessage>) => {
    const msg = event.data;
    if (msg.type !== 'findInImages') return;

    try {
        await ensureScribe();
        const matches = await findInImages(msg.pages, msg.searchTerm, msg.id);
        postMessage({ type: 'done', id: msg.id, matches } satisfies OcrWorkerResponse);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        postMessage({ type: 'error', id: msg.id, message } satisfies OcrWorkerResponse);
    }
});

// ── Core OCR pipeline ─────────────────────────────────────────────────────────
async function findInImages(
    pages: OcrPageBlob[],
    searchTerm: string,
    jobId: string,
): Promise<OcrMatch[]> {
    const matches: OcrMatch[] = [];
    const termLower = searchTerm.toLowerCase();
    const termWords = searchTerm.trim().toLowerCase().split(/\s+/);

    if (!pages.length) return matches;

    // Convert blobs to Files for Scribe
    const files = pages.map(p =>
        new File([p.blob], `page-${p.pageNum}.png`, { type: 'image/png' }),
    );

    // ── Single batched recognize call ─────────────────────────────────────────
    try {
        await scribe.clear();
        await scribe.importFiles(files);
        await scribe.recognize();
    } catch (err) {
        console.error('[OcrWorker] Scribe recognition failed:', err);
        return matches;
    }

    // ── Search each page result ───────────────────────────────────────────────
    for (let i = 0; i < pages.length; i++) {
        const { pageNum, pdfHeight1x, scaleX, scaleY } = pages[i];

        postMessage({ type: 'progress', id: jobId, page: i + 1, total: pages.length } satisfies OcrWorkerResponse);

        const ocrPage = scribe.data?.ocr?.active?.[i];
        if (!ocrPage?.lines?.length) continue;

        const allWords: Array<{
            text: string;
            bbox: { x0: number; y0: number; x1: number; y1: number };
            conf: number;
        }> = [];

        for (const line of ocrPage.lines) {
            for (const word of line.words ?? []) {
                if (!word?.text?.trim()) continue;
                const bbox = normaliseBbox(word.bbox ?? word);
                if (!bbox) continue;
                allWords.push({
                    text: word.text,
                    bbox,
                    conf: word.conf ?? word.confidence ?? 0,
                });
            }
        }

        if (!allWords.length) continue;

        for (let j = 0; j <= allWords.length - termWords.length; j++) {
            const slice = allWords.slice(j, j + termWords.length);
            const sliceText = slice.map(w => w.text.toLowerCase()).join(' ');

            if (sliceText !== termLower && !sliceText.includes(termLower)) continue;

            // allow OCR to roughly guess character size and redact partial word instead of full word
            const word       = slice[0]; // single word case
            const fullText   = word.text;
            const matchStart = fullText.toLowerCase().indexOf(termLower);
            const matchEnd   = matchStart + termLower.length;
            const ratio      = fullText.length;

            const bboxW = word.bbox.x1 - word.bbox.x0;
            const bboxH    = word.bbox.y1 - word.bbox.y0;
            const padY     = bboxH * 0.10; // add a 10% padding top and bottom
            const padX     = bboxW * 0.02; // add 2% padding left and right

            const x0 = word.bbox.x0 + (bboxW * matchStart / ratio) - padX;
            const x1 = word.bbox.x0 + (bboxW * matchEnd   / ratio) + padX;
            const y0 = word.bbox.y0 - padY;
            const y1 = word.bbox.y1 + padY;


            const pdfRect = pixelToPdfCoords({ x0, y0, x1, y1 }, scaleX, scaleY, pdfHeight1x);

            if (
                pdfRect[0] < 0 || pdfRect[1] < 0 ||
                pdfRect[2] <= pdfRect[0] ||
                pdfRect[3] <= pdfRect[1]
            ) continue;

            const avgConf = Math.round(
                slice.reduce((s, w) => s + w.conf, 0) / slice.length,
            );

            matches.push({
                page: pageNum,
                term: searchTerm,
                context: slice.map(w => w.text).join(' '),
                rect: pdfRect,
                confidence: avgConf,
                checked: false,
            });
        }
    }

    try { await scribe.clear(); } catch { /* best-effort */ }

    return matches;
}