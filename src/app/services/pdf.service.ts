import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

import { IndexedDbService } from './indexed-db.service';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
import { customLogger } from '../../utils/custom-logger';

pdfjsLib.GlobalWorkerOptions.workerSrc = window.location.origin + '/assets/pdf.worker.min.mjs';

@Injectable({ providedIn: 'root' })
export class PdfService {

  private idb = inject(IndexedDbService);

  // ── Signals ────────────────────────────────────────────────────────────────
  readonly currentBytes = signal<Uint8Array | null>(null);
  readonly filename = signal<string>('');
  readonly totalPagesSignal = signal<number>(0);
  readonly isLoaded = computed(() => this.currentBytes() !== null);

  readonly pdfLoaded$ = toObservable(this.isLoaded);
  readonly filename$ = toObservable(this.filename);

  readonly renderTrigger$ = new Subject<void>();

  get totalPages(): number { return this.totalPagesSignal(); }

  private _currentPageInfo = { page: 1, scale: 1 };

  setCurrentPageInfo(page: number, scale: number): void {
    this._currentPageInfo = { page, scale };
  }

  getCurrentPageInfo(): { page: number; scale: number } {
    return { ...this._currentPageInfo };
  }

  private pdfJsDoc: PDFDocumentProxy | null = null;

  constructor() { }

  // ── Load ───────────────────────────────────────────────────────────────────
  async loadFromIndexedDB(): Promise<boolean> {
    const stored = await this.idb.load();
    if (!stored) {
      return false;
    }
    customLogger.log(`[PdfService] loadFromIndexedDB: found "${stored.filename}", initDocument...`);
    await this.initDocument(stored.currentBytes, stored.filename);
    return true;
  }

  async loadFromFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.idb.saveDocument(file.name, bytes);
    await this.initDocument(bytes, file.name);
    this.renderTrigger$.next();
  }

  async revertToOriginal(): Promise<void> {
    const stored = await this.idb.load();
    if (!stored) return;
    await this.idb.updateCurrentBytes(stored.originalBytes);
    await this.initDocument(stored.originalBytes, stored.filename);
    this.renderTrigger$.next();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  async renderPage(pageNum: number, canvas: HTMLCanvasElement, zoomScale = 1): Promise<void> {
    if (!this.pdfJsDoc) return;

    const dpr = Math.max(window.devicePixelRatio || 1, 2);
    const page = await this.pdfJsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: zoomScale * dpr });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const renderTask: RenderTask = page.render({ canvas, viewport });
    await renderTask.promise;
  }

  // ── commitBytes ────────────────────────────────────────────────────────────
  async commitBytes(newBytes: Uint8Array): Promise<void> {
    customLogger.log(`[PdfService] commitBytes: ${newBytes.byteLength} bytes`);
    await this.idb.updateCurrentBytes(newBytes);
    await this.initDocument(newBytes, this.filename());
    this.renderTrigger$.next();
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  async initDocument(bytes: Uint8Array, name: string): Promise<void> {
    const copy = bytes.slice();
    this.pdfJsDoc = await pdfjsLib.getDocument({ data: copy }).promise;
    this.filename.set(name);
    this.totalPagesSignal.set(this.pdfJsDoc.numPages);
    this.currentBytes.set(bytes);
    customLogger.log(`[PdfService] initDocument: done — ${this.pdfJsDoc.numPages} pages`);
  }

  getPage(pageNum: number): Promise<PDFPageProxy> | null {
    return this.pdfJsDoc ? this.pdfJsDoc.getPage(pageNum) : null;
  }

  getPdfJsDoc(): PDFDocumentProxy | null {
    return this.pdfJsDoc;
  }

  async getPageText(pageNum: number): Promise<string> {
    const pagePromise = this.getPage(pageNum);
    if (!pagePromise) return '';
    const page = await pagePromise;
    const content = await page.getTextContent();
    return content.items.map((item: any) => item.str ?? '').join(' ');
  }

  /**
   * Returns PDF-space bounding rects for all text items on a page that
   * contain the search term. Used by the highlight overlay in the PDF viewer.
   *
   * PDF.js text items carry a `transform` array [a, b, c, d, x, y] where
   * x/y is the glyph origin in PDF coordinate space (bottom-left origin).
   * `width` and `height` give the item dimensions in the same space.
   */
  async getPageTextMatchRects(
    pageNum: number,
    term: string,
  ): Promise<[number, number, number, number][]> {
    const pagePromise = this.getPage(pageNum);
    if (!pagePromise) return [];

    const page = await pagePromise;
    const content = await page.getTextContent();
    const termLower = term.toLowerCase();
    const rects: [number, number, number, number][] = [];

    for (const item of content.items) {
      const ti = item as TextItem;
      if (!ti.str || !ti.str.toLowerCase().includes(termLower)) continue;

      const [, , , , x, y] = ti.transform;
      const w = ti.width ?? 0;
      const h = ti.height ?? 10; // fallback if height not provided

      if (w <= 0) continue;

      // PDF space: origin bottom-left, y increases upward.
      // The glyph origin (x, y) is at the text baseline.
      // We expand slightly above/below baseline for a visible highlight box.
      rects.push([x, y - h * 0.15, x + w, y + h * 0.85]);
    }

    return rects;
  }

  // ── Download ───────────────────────────────────────────────────────────────
  downloadCurrent(): void {
    const bytes = this.currentBytes();
    if (!bytes) return;
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.filename() || 'redacted.pdf';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Clear ───────────────────────────────────────────────────────────────
  clear(): void {
    customLogger.log('[PdfService] clear: wiping all state, firing renderTrigger$');
    this.pdfJsDoc = null;
    this.currentBytes.set(null);
    this.filename.set('');
    this.totalPagesSignal.set(0);
    this._currentPageInfo = { page: 1, scale: 1 };
    this.renderTrigger$.next();
  }
}