import type * as MuPDF from 'mupdf';
import { customLogger } from '../../../utils/custom-logger';

let _mupdf: typeof MuPDF | null = null;

export async function loadMupdf(): Promise<typeof MuPDF> {
  if (_mupdf) return _mupdf;
  const url = new URL('/assets/mupdf/mupdf.js', self.location.href);
  const mod = await import(/* @vite-ignore */ url.href);
  _mupdf = (mod.default ?? mod) as typeof MuPDF;
  if (typeof _mupdf?.Document?.openDocument !== 'function') {
    customLogger.error('[mupdf-loader] keys:', Object.keys(_mupdf ?? {}));
    throw new Error('mupdf failed to initialize');
  }
  return _mupdf;
}