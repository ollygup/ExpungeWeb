import type * as MuPDF from 'mupdf';
import type { WatermarkWorkerMsg, WatermarkWorkerRes, WatermarkParams } from './watermark.types';
import { customLogger } from '../../../../utils/custom-logger';
import { loadMupdf } from '../../../services/loaders/mupdf-loader';

let mupdf: typeof MuPDF;
const ready = loadMupdf().then(m => { mupdf = m; });

function escapePdf(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildStream(w: number, h: number, p: WatermarkParams): Uint8Array {
    const rad = (p.angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const [r, g, b] = p.color;
    const grid = p.density + 1;
    const cw = w / grid, ch = h / grid;
    const t = escapePdf(p.text);

    // rg (fill color) placed outside BT but inside q/Q — unambiguously valid PDF
    let s = `q\n/WmGS gs\n${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} rg\nBT\n/WmFont ${p.fontSize} Tf\n`;
    for (let row = 0; row < grid; row++) {
        for (let col = 0; col < grid; col++) {
            const tx = cw * col;
            const ty = ch * row;
            // Tm sets text matrix (position + rotation) — valid inside BT
            s += `${cos.toFixed(6)} ${sin.toFixed(6)} ${(-sin).toFixed(6)} ${cos.toFixed(6)} ${tx.toFixed(2)} ${ty.toFixed(2)} Tm\n`;
            s += `(${t}) Tj\n`;
        }
    }
    s += `ET\nQ\n`;
    return new TextEncoder().encode(s);
}

async function applyWatermark(pdfBytes: Uint8Array, params: WatermarkParams): Promise<Uint8Array> {
    await ready;

    const doc = mupdf.Document.openDocument(
        pdfBytes.buffer.slice(0) as ArrayBuffer,
        'application/pdf'
    ) as MuPDF.PDFDocument;

    // Created once; referenced by all pages via indirect ref
    const fontRef = doc.addSimpleFont(new mupdf.Font('Helvetica'));

    const gsObj = doc.newDictionary();
    gsObj.put('Type', doc.newName('ExtGState'));
    gsObj.put('ca', doc.newReal(params.opacity)); // fill opacity
    gsObj.put('CA', doc.newReal(params.opacity)); // stroke opacity
    const gsRef = doc.addObject(gsObj);

    const count = doc.countPages();

    for (let i = 0; i < count; i++) {
        const page = doc.findPage(i);

        // Prefer CropBox (visible area) over MediaBox
        const cropBox = page.get('CropBox');
        const box = cropBox.isNull() ? page.get('MediaBox') : cropBox;
        const pageW = box.get(2).asNumber() - box.get(0).asNumber();
        const pageH = box.get(3).asNumber() - box.get(1).asNumber();

        const streamDict = doc.newDictionary();
        const wmStream = doc.addStream(buildStream(pageW, pageH, params), streamDict);

        // Merge into page Resources (non-destructive: only add our keys)
        let res = page.get('Resources');
        if (!res.isDictionary()) {
            res = doc.newDictionary();
            page.put('Resources', res);
        }

        let fontRes = res.get('Font');
        if (!fontRes.isDictionary()) {
            fontRes = doc.newDictionary();
            res.put('Font', fontRes);
        }
        fontRes.put('WmFont', fontRef);

        let gsRes = res.get('ExtGState');
        if (!gsRes.isDictionary()) {
            gsRes = doc.newDictionary();
            res.put('ExtGState', gsRes);
        }
        gsRes.put('WmGS', gsRef);

        // Prepend watermark stream → renders behind page content
        const existing = page.get('Contents');
        const arr = doc.newArray();
        arr.push(wmStream);
        if (existing.isArray()) {
            for (let j = 0; j < existing.length; j++) arr.push(existing.get(j));
        } else if (!existing.isNull()) {
            arr.push(existing);
        }
        page.put('Contents', arr);
    }

    const buf = doc.saveToBuffer('compress');
    const result = new Uint8Array(buf.asUint8Array().slice(0));
    doc.destroy();
    return result;
}

self.onmessage = async (e: MessageEvent<WatermarkWorkerMsg>) => {
    if (e.data.type !== 'apply') return;
    try {
        const result = await applyWatermark(e.data.pdfBytes, e.data.params);
        const transferable = result.buffer.slice(
            result.byteOffset,
            result.byteOffset + result.byteLength,
        ) as ArrayBuffer;
        self.postMessage(
            { type: 'success', resultBytes: result } satisfies WatermarkWorkerRes,
            { transfer: [transferable] },
        );
    } catch (err) {
        customLogger.error('[watermark.worker]', err);
        self.postMessage({ type: 'error', message: String(err) } satisfies WatermarkWorkerRes);
    }
};