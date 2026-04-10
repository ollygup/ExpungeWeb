import * as ort from 'onnxruntime-web';
import type { OcrMatch } from '../redaction/redaction.types';
import type { OcrPageBlob, OcrWorkerMessage, OcrWorkerResponse } from './ocr.types';
import { customLogger } from '../../../../utils/custom-logger';

// ── Config ────────────────────────────────────────────────────────────────────
const DET_MAX_SIDE = 960;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP_RATIO = 1.6;
const REC_H = 48;
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

// ── Model state ───────────────────────────────────────────────────────────────
let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let charList: string[] = [];
let modelsReady: Promise<void> | null = null;

async function ensureModels(): Promise<void> {
  if (detSession && recSession) return;
  if (modelsReady) return modelsReady;

  modelsReady = (async () => {
    const base = new URL('/assets/', self.location.origin).href;
    ort.env.wasm.wasmPaths = base + 'ort/';
    ort.env.wasm.numThreads = 1;

    const [detBuf, recBuf, dictText] = await Promise.all([
      fetch(base + 'paddle/det.onnx').then(r => r.arrayBuffer()),
      fetch(base + 'paddle/rec.onnx').then(r => r.arrayBuffer()),
      fetch(base + 'paddle/ppocrv5_dict.txt').then(r => r.text()),
    ]);

    detSession = await ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] });
    recSession = await ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] });

    // normalize text first
    const cleanedDictText = dictText
      .replace(/^\uFEFF/, '') // remove Byte Order Mark if present
      .replace(/\r/g, '');    // normalize line endings

    // split into lines
    const dictLines = cleanedDictText
      .split('\n')
      .filter(line => line !== '');

    // build char list
    charList = ['blank', ...dictLines, ' '];
  })();

  return modelsReady;
}

// ── Message handler ───────────────────────────────────────────────────────────
addEventListener('message', async (event: MessageEvent<OcrWorkerMessage>) => {
  const msg = event.data;
  if (msg.type !== 'findInImages') return;

  try {
    await ensureModels();
    const matches = await findInImages(msg.pages, msg.searchTerm, msg.id);
    postMessage({ type: 'done', id: msg.id, matches } satisfies OcrWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    customLogger.error('[OcrWorker] Fatal:', message);
    postMessage({ type: 'error', id: msg.id, message } satisfies OcrWorkerResponse);
  }
});

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function findInImages(
  pages: OcrPageBlob[],
  searchTerm: string,
  jobId: string,
): Promise<OcrMatch[]> {
  const matches: OcrMatch[] = [];
  const termLower = searchTerm.toLowerCase();

  for (let i = 0; i < pages.length; i++) {
    const { pageNum, blob, pdfHeight1x, scaleX, scaleY, offsetPixelX, offsetPixelY } = pages[i];
    postMessage({ type: 'progress', id: jobId, page: i + 1, total: pages.length } satisfies OcrWorkerResponse);

    try {
      const imgData = await blobToImageData(blob);
      const { tensor, detScaleX, detScaleY } = buildDetTensor(imgData);
      const detOut = await detSession!.run({ [detSession!.inputNames[0]]: tensor });
      const probTensor = detOut[detSession!.outputNames[0]];
      const dims = probTensor.dims as number[];
      const [mapH, mapW] = dims.length === 4 ? [dims[2], dims[3]] : [dims[1], dims[2]];
      const boxes = dbPostProcess(probTensor.data as Float32Array, mapH, mapW);

      customLogger.log(`[OcrWorker] p${pageNum}: ${boxes.length} boxes`);

      const srcCanvas = imageDataToCanvas(imgData);

      for (const box of boxes) {
        const recTensor = buildRecTensor(srcCanvas, box, detScaleX, detScaleY);
        if (!recTensor) continue;

        const recOut = await recSession!.run({ [recSession!.inputNames[0]]: recTensor });
        const { text, conf } = ctcDecode(recOut[recSession!.outputNames[0]]);
        customLogger.log(`[OcrWorker] rec: "${text}" conf=${conf.toFixed(2)}`);

        const termIdx = text.toLowerCase().indexOf(termLower);
        if (!text || termIdx === -1) continue;

        const [bx0, by0, bx1, by1] = box;

        // proportional sub-rect based on character position
        const ratio0 = termIdx / text.length;
        const ratio1 = (termIdx + searchTerm.length) / text.length;
        const subX0 = bx0 + ratio0 * (bx1 - bx0);
        const subX1 = bx0 + ratio1 * (bx1 - bx0);

        const px0 = subX0 * detScaleX + offsetPixelX;
        const py0 = by0 * detScaleY + offsetPixelY;
        const px1 = subX1 * detScaleX + offsetPixelX;
        const py1 = by1 * detScaleY + offsetPixelY;

        const pdfRect = pixelToPdf({ x0: px0, y0: py0, x1: px1, y1: py1 }, scaleX, scaleY, pdfHeight1x);
        if (pdfRect[2] <= pdfRect[0] || pdfRect[3] <= pdfRect[1]) continue;

        matches.push({ page: pageNum, term: searchTerm, context: text, rect: pdfRect, confidence: Math.round(conf * 100), checked: false });
      }
    } catch (err) {
      customLogger.warn(`[OcrWorker] p${pageNum} failed:`, err);
    }
  }

  return matches;
}

// ── Det preprocessing ─────────────────────────────────────────────────────────
function buildDetTensor(img: ImageData): { tensor: ort.Tensor; detScaleX: number; detScaleY: number } {
  const { width: oW, height: oH } = img;
  const scale = Math.max(oW, oH) > DET_MAX_SIDE ? DET_MAX_SIDE / Math.max(oW, oH) : 1;
  const padW = Math.ceil(Math.round(oW * scale) / 32) * 32;
  const padH = Math.ceil(Math.round(oH * scale) / 32) * 32;

  const dst = new OffscreenCanvas(padW, padH);
  const dstCtx = dst.getContext('2d')!;
  dstCtx.drawImage(imageDataToCanvas(img), 0, 0, Math.round(oW * scale), Math.round(oH * scale));

  const px = dstCtx.getImageData(0, 0, padW, padH).data;
  const HW = padH * padW;
  const td = new Float32Array(3 * HW);

  for (let i = 0; i < HW; i++) {
    const p = i * 4;
    td[i] = (px[p] / 255 - DET_MEAN[0]) / DET_STD[0];
    td[HW + i] = (px[p + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
    td[2 * HW + i] = (px[p + 2] / 255 - DET_MEAN[2]) / DET_STD[2];
  }

  return {
    tensor: new ort.Tensor('float32', td, [1, 3, padH, padW]),
    detScaleX: oW / padW,
    detScaleY: oH / padH,
  };
}

// ── DB post-processing (BFS connected components + unclip) ────────────────────
function dbPostProcess(
  prob: Float32Array,
  mapH: number,
  mapW: number,
): Array<[number, number, number, number]> {
  const binary = new Uint8Array(mapH * mapW);
  for (let i = 0; i < binary.length; i++) binary[i] = prob[i] > DET_THRESH ? 1 : 0;

  const labels = new Int32Array(mapH * mapW).fill(-1);
  const boxes: Array<[number, number, number, number]> = [];
  let lbl = 0;

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const start = y * mapW + x;
      if (!binary[start] || labels[start] !== -1) continue;

      let [minX, minY, maxX, maxY, sumP, cnt] = [x, y, x, y, 0, 0];
      const stack = [start];
      labels[start] = lbl;

      while (stack.length) {
        const idx = stack.pop()!;
        const cy = Math.floor(idx / mapW), cx = idx % mapW;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        sumP += prob[idx]; cnt++;

        for (const [ny, nx] of [[cy - 1, cx], [cy + 1, cx], [cy, cx - 1], [cy, cx + 1]] as [number, number][]) {
          if (ny < 0 || ny >= mapH || nx < 0 || nx >= mapW) continue;
          const ni = ny * mapW + nx;
          if (!binary[ni] || labels[ni] !== -1) continue;
          labels[ni] = lbl; stack.push(ni);
        }
      }
      lbl++;

      if (cnt < 8 || sumP / cnt < BOX_THRESH) continue;

      const w = maxX - minX, h = maxY - minY;
      const d = (w * h * UNCLIP_RATIO) / (2 * (w + h));
      const x0 = Math.max(0, Math.floor(minX - d));
      const y0 = Math.max(0, Math.floor(minY - d));
      const x1 = Math.min(mapW - 1, Math.ceil(maxX + d));
      const y1 = Math.min(mapH - 1, Math.ceil(maxY + d));
      if (x1 - x0 < 4 || y1 - y0 < 2) continue;

      boxes.push([x0, y0, x1, y1]);
    }
  }

  return boxes;
}

// ── Rec preprocessing ─────────────────────────────────────────────────────────
function buildRecTensor(
  src: OffscreenCanvas,
  box: [number, number, number, number],
  detScaleX: number,
  detScaleY: number,
): ort.Tensor | null {
  const ox0 = Math.round(box[0] * detScaleX), oy0 = Math.round(box[1] * detScaleY);
  const ox1 = Math.round(box[2] * detScaleX), oy1 = Math.round(box[3] * detScaleY);
  const bW = ox1 - ox0, bH = oy1 - oy0;
  if (bW <= 0 || bH <= 0) return null;

  const recW = Math.max(1, Math.round(bW * REC_H / bH));
  const dst = new OffscreenCanvas(recW, REC_H);
  const dstCtx = dst.getContext('2d')!;
  dstCtx.drawImage(src, ox0, oy0, bW, bH, 0, 0, recW, REC_H);

  const px = dstCtx.getImageData(0, 0, recW, REC_H).data;
  const HW = REC_H * recW;
  const td = new Float32Array(3 * HW);

  for (let i = 0; i < HW; i++) {
    const p = i * 4;
    td[i] = (px[p] / 255 - 0.5) / 0.5;
    td[HW + i] = (px[p + 1] / 255 - 0.5) / 0.5;
    td[2 * HW + i] = (px[p + 2] / 255 - 0.5) / 0.5;
  }

  return new ort.Tensor('float32', td, [1, 3, REC_H, recW]);
}

// ── CTC greedy decode ─────────────────────────────────────────────────────────
let _recDimsLogged = false;

function ctcDecode(tensor: ort.Tensor): { text: string; conf: number } {
  const dims = tensor.dims as number[];
  let seqLen: number, numClasses: number;

  if (dims.length === 3) { seqLen = dims[0] === 1 ? dims[1] : dims[0]; numClasses = dims[2]; }
  else if (dims.length === 2) { seqLen = dims[0]; numClasses = dims[1]; }
  else { customLogger.warn('[OcrWorker] ctcDecode: unexpected dims', dims); return { text: '', conf: 0 }; }

  const data = tensor.data as Float32Array;
  const SPACE_GAP = Math.max(2, Math.round(seqLen * 0.12));

  let text = '', sumConf = 0, cnt = 0, last = -1, blankRun = 0;

  for (let t = 0; t < seqLen; t++) {
    const off = t * numClasses;
    let maxIdx = 0, maxVal = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      if (data[off + c] > maxVal) { maxVal = data[off + c]; maxIdx = c; }
    }

    if (maxIdx === 0) {
      blankRun++;
    } else {
      if (blankRun >= SPACE_GAP && text.length > 0 && !text.endsWith(' ')) text += ' ';
      blankRun = 0;
      if (maxIdx !== last) { text += charList[maxIdx] ?? ''; sumConf += maxVal; cnt++; }
    }
    last = maxIdx;
  }

  return { text: text.trim(), conf: cnt > 0 ? sumConf / cnt : 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  if (bmp.width === 0 || bmp.height === 0) {
    bmp.close();
    throw new Error(`Invalid bitmap dimensions: ${bmp.width}×${bmp.height}`);
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function imageDataToCanvas(img: ImageData): OffscreenCanvas {
  const c = new OffscreenCanvas(img.width, img.height);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(img, 0, 0);
  return c;
}

function pixelToPdf(
  r: { x0: number; y0: number; x1: number; y1: number },
  scaleX: number, scaleY: number, pdfH: number,
): [number, number, number, number] {
  return [r.x0 / scaleX, pdfH - r.y1 / scaleY, r.x1 / scaleX, pdfH - r.y0 / scaleY];
}