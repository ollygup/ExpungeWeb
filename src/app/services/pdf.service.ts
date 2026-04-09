import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';

import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextItem } from 'pdfjs-dist/types/src/display/api';

import { IndexedDbService } from './indexed-db.service';
import { customLogger } from '../../utils/custom-logger';

@Injectable({ providedIn: 'root' })
export class PdfService {

  private idb = inject(IndexedDbService);
  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);

  private pdfjsLib: typeof import('pdfjs-dist') | null = null;

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

  private async getPdfJs(): Promise<typeof import('pdfjs-dist')> {
    if (!this.pdfjsLib) {
      this.pdfjsLib = await import('pdfjs-dist');
      this.pdfjsLib.GlobalWorkerOptions.workerSrc =
        window.location.origin + '/assets/pdfjs/pdf.worker.min.mjs';
    }
    return this.pdfjsLib;
  }

  async loadFromIndexedDB(): Promise<boolean> {
    if (!this.isBrowser) return false;
    const stored = await this.idb.load();
    if (!stored) return false;
    customLogger.log(`[PdfService] loadFromIndexedDB: found "${stored.filename}", initDocument...`);
    await this.initDocument(stored.currentBytes, stored.filename);
    return true;
  }

  async loadFromFile(file: File): Promise<void> {
    if (!this.isBrowser) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.idb.saveDocument(file.name, bytes);
    await this.initDocument(bytes, file.name);
    this.renderTrigger$.next();
  }

  async revertToOriginal(): Promise<void> {
    if (!this.isBrowser) return;
    const stored = await this.idb.load();
    if (!stored) return;
    await this.idb.updateCurrentBytes(stored.originalBytes);
    await this.initDocument(stored.originalBytes, stored.filename);
    this.renderTrigger$.next();
  }

  async renderPage(pageNum: number, canvas: HTMLCanvasElement, zoomScale = 1): Promise<void> {
    if (!this.pdfJsDoc || !this.isBrowser) return;

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

  async commitBytes(newBytes: Uint8Array): Promise<void> {
    if (!this.isBrowser) return;
    customLogger.log(`[PdfService] commitBytes: ${newBytes.byteLength} bytes`);
    await this.idb.updateCurrentBytes(newBytes);
    await this.initDocument(newBytes, this.filename());
    this.renderTrigger$.next();
  }

  async initDocument(bytes: Uint8Array, name: string): Promise<void> {
    if (!this.isBrowser) return;
    const pdfjs = await this.getPdfJs();
    const copy = bytes.slice();
    this.pdfJsDoc = await pdfjs.getDocument({ data: copy }).promise;
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
      const h = ti.height ?? 10;

      if (w <= 0) continue;

      rects.push([x, y - h * 0.15, x + w, y + h * 0.85]);
    }

    return rects;
  }

  downloadCurrent(): void {
    if (!this.isBrowser) return;
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