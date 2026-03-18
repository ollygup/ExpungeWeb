import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';

import { IndexedDbService } from './indexed-db.service';

pdfjsLib.GlobalWorkerOptions.workerSrc = window.location.origin + '/assets/pdf.worker.min.mjs';

@Injectable({ providedIn: 'root' })
export class PdfService {

  private idb = inject(IndexedDbService);

  // ── Signals (reactive state) ───────────────────────────────────
  readonly currentBytes = signal<Uint8Array | null>(null);
  readonly filename = signal<string>('');
  readonly totalPagesSignal = signal<number>(0);
  readonly isLoaded = computed(() => this.currentBytes() !== null);

  // ── Observables consumed by non-signal components ─────────────
  /** Emits true once a document is loaded, false after clear. */
  readonly pdfLoaded$ = toObservable(this.isLoaded);
  readonly filename$ = toObservable(this.filename);

  /** Fires whenever bytes change and a re-render is needed. */
  readonly renderTrigger$ = new Subject<void>();

  // Convenience getter so template / component code can read
  // totalPages as a plain number without calling the signal.
  get totalPages(): number { return this.totalPagesSignal(); }

  // ── Internal page info (set by the viewer after each render) ───
  private _currentPageInfo = { page: 1, scale: 1 };

  setCurrentPageInfo(page: number, scale: number): void {
    this._currentPageInfo = { page, scale };
  }

  getCurrentPageInfo(): { page: number; scale: number } {
    return { ...this._currentPageInfo };
  }

  private pdfJsDoc: PDFDocumentProxy | null = null;

  constructor() {
    // Persist bytes to IDB whenever they change.
    effect(() => {
      const bytes = this.currentBytes();
      const filename = this.filename();
      if (!bytes || !filename) return;

      this.idb.updateCurrentBytes(bytes).catch(err =>
        console.error('[PdfService] IDB persist failed:', err)
      );
    });
  }

  // ── Load ──────────────────────────────────────────────────────
  async loadFromIndexedDB(): Promise<boolean> {
    const stored = await this.idb.load();
    if (!stored) return false;
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
    await this.initDocument(stored.originalBytes, stored.filename);
    this.renderTrigger$.next();
  }

  // ── Render ────────────────────────────────────────────────────
  async renderPage(pageNum: number, canvas: HTMLCanvasElement, zoomScale = 1): Promise<void> {
    if (!this.pdfJsDoc) return;

    const page: PDFPageProxy = await this.pdfJsDoc.getPage(pageNum);
    const viewport: PageViewport = page.getViewport({ scale: zoomScale * 1.5 });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const renderTask: RenderTask = page.render({ canvas, viewport });
    await renderTask.promise;
  }

  // ── commitBytes: contract for all feature services ─────────────
  async commitBytes(newBytes: Uint8Array): Promise<void> {
    await this.initDocument(newBytes, this.filename());
    this.renderTrigger$.next();
  }

  // ── Internal ──────────────────────────────────────────────────
  async initDocument(bytes: Uint8Array, name: string): Promise<void> {
    const copy = bytes.slice(); // pdfjs may detach the buffer
    this.pdfJsDoc = await pdfjsLib.getDocument({ data: copy }).promise;

    this.filename.set(name);
    this.totalPagesSignal.set(this.pdfJsDoc.numPages);
    this.currentBytes.set(bytes);
  }

  /**
   * Expose raw PDFPageProxy for feature services (e.g. text search).
   * Returns null if no document is loaded.
   */
  getPage(pageNum: number): Promise<PDFPageProxy> | null {
    return this.pdfJsDoc ? this.pdfJsDoc.getPage(pageNum) : null;
  }

  /**
   * Returns the full text content of a page (used by search).
   */
  async getPageText(pageNum: number): Promise<string> {
    const pagePromise = this.getPage(pageNum);
    if (!pagePromise) return '';
    const page = await pagePromise;
    const content = await page.getTextContent();
    return content.items.map((item: any) => item.str ?? '').join(' ');
  }
}