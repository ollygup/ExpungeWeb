// ── Preprocess Worker ─────────────────────────────────────────────────────────
// Receives raw PNG blobs of image regions extracted by OcrService.
// Applies an OpenCV preprocessing pipeline optimised for typed/scanned PDF text
// before Scribe/Tesseract recognition. Returns processed blobs + scale applied.

import { customLogger } from '../../../../utils/custom-logger';
import { PreprocessRequest, PreprocessResult, PreprocessResponse } from './preprocess.types';

// ── OpenCV bootstrap ──────────────────────────────────────────────────────────

let cv: any        = null;
let cvReady: Promise<void> | null = null;

async function ensureCv(): Promise<void> {
  if (cv) return;
  if (cvReady) return cvReady;

  cvReady = (async () => {
    const url = new URL('/assets/opencv/opencv.js', self.location.origin);

    await import(/* @vite-ignore */ url.href);

    const instance = (self as any).cv;
    if (!instance) throw new Error('OpenCV did not attach to self.cv');

    await new Promise<void>((resolve) => {
      if (instance.Mat !== undefined) {
        cv = instance;
        resolve();
        return;
      }

      instance.onRuntimeInitialized = () => {
        cv = (self as any).cv;
        resolve();
      };
    });
  })();

  return cvReady;
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

async function blobToMat(blob: Blob): Promise<any> {
  const bitmap    = await createImageBitmap(blob);
  const canvas    = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx       = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return cv.matFromImageData(imageData);
}

async function matToBlob(mat: any): Promise<Blob> {
  const canvas = new OffscreenCanvas(mat.cols, mat.rows);
  const ctx    = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows),
    0, 0,
  );
  return canvas.convertToBlob({ type: 'image/png' });
}

// ── Preprocessing pipeline ────────────────────────────────────────────────────
// Optimised for typed text and scanned images in PDF regions.
// Returns the processed RGBA Mat and the integer upscale factor (≥1).
//
// Steps:
//   1. Greyscale          — reduces noise channels, speeds up all subsequent ops
//   2. Upscale (CUBIC)    — ensures minimum width for reliable glyph recognition
//   3. CLAHE              — local contrast normalisation (faded / uneven lighting)
//   4. Unsharp mask       — recovers sharpness lost to JPEG/compression blur
//   5. Adaptive threshold — binarise robustly against non-uniform illumination
//   6. Morph close        — reconnects broken strokes (thin fonts / low-DPI scans)

function preprocessForOcr(src: any): { mat: any; scale: number } {
  // 1. Greyscale
  const grey = new cv.Mat();
  cv.cvtColor(src, grey, cv.COLOR_RGBA2GRAY);
  customLogger.info('[PreprocessWorker] Greyscale applied');

  // 2. Upscale by smallest side to improve tiny text regions.
  const TARGET_MIN_SIDE = 1200;
  const minSide = Math.min(grey.cols, grey.rows);
  let scale = minSide < TARGET_MIN_SIDE
    ? Math.min(TARGET_MIN_SIDE / Math.max(minSide, 1), 4)
    : 1;

  let mat: any;
  if (scale > 1) {
    mat = new cv.Mat();
    cv.resize(
      grey, mat,
      new cv.Size(Math.round(grey.cols * scale), Math.round(grey.rows * scale)),
      0, 0, cv.INTER_CUBIC,
    );
    grey.delete();
  } else {
    mat = grey;
    scale = 1;
  }

  customLogger.info('[PreprocessWorker] Upscale applied with scale factor:', scale);


  // 3. CLAHE — contrast-limited adaptive histogram equalisation
  const clahe    = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const claheOut = new cv.Mat();
  clahe.apply(mat, claheOut);
  clahe.delete();
  mat.delete();
  mat = claheOut;

  customLogger.info('[PreprocessWorker] CLAHE applied');

  // 4. Unsharp mask — sharpen text edges blurred by compression / low resolution
  const blurred   = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(0, 0), 3);
  const sharpened = new cv.Mat();
  cv.addWeighted(mat, 1.5, blurred, -0.5, 0, sharpened);
  blurred.delete();
  mat.delete();
  mat = sharpened;

  customLogger.info('[PreprocessWorker] Unsharp mask applied');


  // 5. Binarise (optional)
  // Classify first: clean/light pages keep grayscale; dirtier scans try thresholding.
  const meanMat = new cv.Mat();
  const stdMat = new cv.Mat();
  cv.meanStdDev(mat, meanMat, stdMat);
  const intensityMean = meanMat.data64F?.[0] ?? 0;
  const intensityStdDev = stdMat.data64F?.[0] ?? 0;
  meanMat.delete();
  stdMat.delete();

  const isCleanLightPage = intensityMean > 185 && intensityStdDev < 42;
  let shouldThreshold = !isCleanLightPage;
  let binary: any = null;

  if (isCleanLightPage) {
    customLogger.info('[PreprocessWorker] Threshold skipped (clean/light page)');
  } else {
    binary = new cv.Mat();
    cv.threshold(mat, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    const totalPx = binary.cols * binary.rows;
    const nonZeroPx = totalPx > 0 ? cv.countNonZero(binary) : 0;
    const blackRatio = totalPx > 0 ? 1 - (nonZeroPx / totalPx) : 0;

    if (blackRatio < 0.01 || blackRatio > 0.65) {
      binary.delete();
      binary = new cv.Mat();
      cv.adaptiveThreshold(
        mat, binary, 255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
        31, 5,
      );

      const totalPx2 = binary.cols * binary.rows;
      const nonZeroPx2 = totalPx2 > 0 ? cv.countNonZero(binary) : 0;
      const blackRatio2 = totalPx2 > 0 ? 1 - (nonZeroPx2 / totalPx2) : 0;

      if (blackRatio2 < 0.01 || blackRatio2 > 0.65) {
        shouldThreshold = false;
        binary.delete();
        binary = null;
        customLogger.info('[PreprocessWorker] Threshold skipped (mask unusable)');
      } else {
        customLogger.info('[PreprocessWorker] Adaptive threshold applied');
      }
    } else {
      customLogger.info('[PreprocessWorker] Otsu threshold applied');
    }
  }

  if (shouldThreshold && binary) {
    mat.delete();
    mat = binary;

    // 6. Morphological open then close
    // Open removes isolated dots; close reconnects broken strokes.
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));

    const opened = new cv.Mat();
    cv.morphologyEx(mat, opened, cv.MORPH_OPEN, kernel);
    mat.delete();
    mat = opened;

    const morphed = new cv.Mat();
    cv.morphologyEx(mat, morphed, cv.MORPH_CLOSE, kernel);
    kernel.delete();
    mat.delete();
    mat = morphed;

    customLogger.info('[PreprocessWorker] Morphological close applied');
  }

  // Back to RGBA for OffscreenCanvas putImageData
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
  mat.delete();

  return { mat: rgba, scale };
}

// ── Message handler ───────────────────────────────────────────────────────────

addEventListener('message', async (event: MessageEvent<PreprocessRequest>) => {
  const { type, id, regions } = event.data;
  if (type !== 'preprocess') return;

  try {
    await ensureCv();

    const results: PreprocessResult[] = [];

    for (const region of regions) {
      const src            = await blobToMat(region.blob);
      const { mat, scale } = preprocessForOcr(src);
      src.delete();
      const blob = await matToBlob(mat);
      mat.delete();
      results.push({ index: region.index, blob, scale });
    }

    postMessage({ type: 'done', id, results } satisfies PreprocessResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    customLogger.error('[PreprocessWorker] Pipeline failed:', message);
    postMessage({ type: 'error', id, message } satisfies PreprocessResponse);
  }
});