import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subscription } from 'rxjs';
import { PdfService } from '../../services/pdf.service';
import { HighlightService, PageHighlight } from '../../services/highlight.service';
import { customLogger } from '../../../utils/custom-logger';
import { DrawService } from '../../services/draw.service';

interface SvgRect {
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  type: 'text' | 'ocr' | 'draw' | 'draw-focused' | 'draw-preview' | 'draw-pending' | 'draw-extract';
}

@Component({
  selector: 'app-pdf-viewer',
  imports: [CommonModule, MatIconModule, MatTooltipModule],
  templateUrl: './pdf-viewer.html',
  styleUrls: ['./pdf-viewer.scss'],
})
export class PdfViewerComponent implements OnInit, OnDestroy {
  @ViewChild('pdfCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('scrollArea', { static: false }) scrollRef!: ElementRef<HTMLDivElement>;

  protected highlightService = inject(HighlightService);
  public    pdfService       = inject(PdfService);
  protected drawService      = inject(DrawService);
  private   zone             = inject(NgZone);

  // ── Signals ────────────────────────────────────────────────────────────────
  readonly pdfLoaded   = signal(false);
  readonly isRendering = signal(false);
  readonly currentPage = signal(1);
  readonly totalPages  = signal(0);
  readonly zoom        = signal(100);
  readonly svgRects    = signal<SvgRect[]>([]);

  pageWidth1x  = 0;
  pageHeight1x = 0;
  svgWidth     = 0;
  svgHeight    = 0;

  readonly zoomScale = computed(() => this.zoom() / 100);

  // ── Draw state ─────────────────────────────────────────────────────────────
  private isDragging     = false;
  private dragStartCss   = { x: 0, y: 0 };
  private dragCurrentCss = { x: 0, y: 0 };

  private subs             = new Subscription();
  private renderController: AbortController | null = null;

  ngOnInit(): void {
    this.pdfService.loadFromIndexedDB();

    this.subs.add(
      this.pdfService.pdfLoaded$.subscribe(loaded => {
        this.pdfLoaded.set(loaded);
        if (loaded) {
          this.totalPages.set(this.pdfService.totalPages);
          this.currentPage.set(1);
          this.highlightService.setActivePage(1);
          setTimeout(() => this.render());
        } else {
          this.totalPages.set(0);
          this.currentPage.set(1);
          this.svgRects.set([]);
        }
      }),
    );

    this.subs.add(
      this.pdfService.renderTrigger$.subscribe(() => {
        customLogger.log('[viewer] renderTrigger$ fired, isLoaded:', this.pdfService.isLoaded());
        if (!this.pdfService.isLoaded()) {
          this.pdfLoaded.set(false);
          this.totalPages.set(0);
          this.currentPage.set(1);
          this.svgRects.set([]);
          return;
        }
        this.totalPages.set(this.pdfService.totalPages);
        this.currentPage.set(1);
        this.highlightService.setActivePage(1);
        setTimeout(() => this.render());
      }),
    );

    const id = setInterval(() => this.updateSvgRects(), 100);
    this.subs.add({ unsubscribe: () => clearInterval(id) });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.renderController?.abort();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  prevPage(): void {
    if (this.currentPage() > 1) {
      this.currentPage.update(p => p - 1);
      this.highlightService.setActivePage(this.currentPage());
      this.render();
    }
  }

  nextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.currentPage.update(p => p + 1);
      this.highlightService.setActivePage(this.currentPage());
      this.render();
    }
  }

  goToPage(n: number): void {
    const p = Math.max(1, Math.min(n, this.totalPages()));
    if (p !== this.currentPage()) {
      this.currentPage.set(p);
      this.highlightService.setActivePage(p);
      this.render();
    }
  }

  private lastActivePage = 0;

  private checkPageNavigation(): void {
    const requested = this.highlightService.activePage();
    if (requested !== this.lastActivePage && requested !== this.currentPage()) {
      this.lastActivePage = requested;
      this.goToPage(requested);
    }
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────
  zoomIn():  void { this.zoom.update(z => Math.min(250, z + 25)); this.render(); }
  zoomOut(): void { this.zoom.update(z => Math.max(50,  z - 25)); this.render(); }
  zoomFit(): void { this.zoom.set(100); this.render(); }

  // ── Render ─────────────────────────────────────────────────────────────────
  async render(): Promise<void> {
    this.renderController?.abort();
    this.renderController = new AbortController();
    const sig = this.renderController.signal;

    if (!this.canvasRef?.nativeElement) return;
    this.isRendering.set(true);

    const canvas = this.canvasRef.nativeElement;
    canvas.width = 0;
    canvas.height = 0;

    try {
      if (sig.aborted) return;
      await this.pdfService.renderPage(this.currentPage(), canvas, this.zoomScale());
      if (sig.aborted) return;

      const pdfJsDoc = this.pdfService.getPdfJsDoc();
      if (pdfJsDoc) {
        const page = await pdfJsDoc.getPage(this.currentPage());
        const vp   = page.getViewport({ scale: 1 });
        this.pageWidth1x  = vp.width;
        this.pageHeight1x = vp.height;
      }

      this.svgWidth  = parseInt(canvas.style.width,  10) || canvas.width;
      this.svgHeight = parseInt(canvas.style.height, 10) || canvas.height;

      this.pdfService.setCurrentPageInfo(this.currentPage(), this.zoomScale());
      this.updateSvgRects();
    } finally {
      if (!sig.aborted) this.zone.run(() => this.isRendering.set(false));
    }
  }

  // ── Overlay ────────────────────────────────────────────────────────────────
  updateSvgRects(): void {
    this.checkPageNavigation();

    const focused       = this.highlightService.focused();
    const focusedDrawId = this.drawService.focusedRectId();
    const pendingId     = this.drawService.pendingId();

    const highlightRects: SvgRect[] = this.highlightService.pageHighlights()
      .filter(h => h.pageNum === this.currentPage())
      .map(h => this.toSvgRect(
        h,
        focused?.globalIndex === h.globalIndex && focused?.type === h.type,
      ));

    const drawnRects: SvgRect[] = this.drawService.drawnRects()
      .filter(r => r.pageNum === this.currentPage())
      .map(r => {
        let type: SvgRect['type'];
        if (r.id === pendingId)            type = 'draw-pending';
        else if (r.purpose === 'extract')  type = 'draw-extract';
        else if (r.id === focusedDrawId)   type = 'draw-focused';
        else                               type = 'draw';
        return this.pdfRectToSvgRect(r.rect, type);
      });

    const previewRects: SvgRect[] = (this.isDragging && this.drawService.isDrawMode())
      ? [this.buildPreviewRect()]
      : [];

    this.svgRects.set([...highlightRects, ...drawnRects, ...previewRects]);
  }

  private toSvgRect(h: PageHighlight, focused: boolean): SvgRect {
    const [x0, y0, x1, y1] = h.rect;
    const z = this.zoomScale();
    const H = this.pageHeight1x;
    return { x: x0 * z, y: (H - y1) * z, w: (x1 - x0) * z, h: (y1 - y0) * z, focused, type: h.type };
  }

  private pdfRectToSvgRect(rect: [number, number, number, number], type: SvgRect['type']): SvgRect {
    const [x0, y0, x1, y1] = rect;
    const z = this.zoomScale();
    const H = this.pageHeight1x;
    return { x: x0 * z, y: (H - y1) * z, w: (x1 - x0) * z, h: (y1 - y0) * z, focused: false, type };
  }

  private buildPreviewRect(): SvgRect {
    const x = Math.min(this.dragStartCss.x, this.dragCurrentCss.x);
    const y = Math.min(this.dragStartCss.y, this.dragCurrentCss.y);
    const w = Math.abs(this.dragCurrentCss.x - this.dragStartCss.x);
    const h = Math.abs(this.dragCurrentCss.y - this.dragStartCss.y);
    return { x, y, w, h, focused: false, type: 'draw-preview' };
  }

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  private getCanvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.canvasRef.nativeElement;
    const rect   = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left)  * (canvas.offsetWidth  / rect.width),
      y: (clientY - rect.top)   * (canvas.offsetHeight / rect.height),
    };
  }

  /** Canvas CSS-px → viewport-fixed screen coords (accounts for CSS scale transform). */
  private cssToScreen(cssX: number, cssY: number): { x: number; y: number } {
    const canvas     = this.canvasRef.nativeElement;
    const canvasRect = canvas.getBoundingClientRect();
    return {
      x: canvasRect.left + cssX * (canvasRect.width  / canvas.offsetWidth),
      y: canvasRect.top  + cssY * (canvasRect.height / canvas.offsetHeight),
    };
  }

  private cssToPdf(cssX: number, cssY: number): [number, number] {
    const z = this.zoomScale();
    return [cssX / z, this.pageHeight1x - cssY / z];
  }

  private buildPdfRect(
    start: { x: number; y: number },
    end:   { x: number; y: number },
  ): [number, number, number, number] {
    const [x0, y0] = this.cssToPdf(start.x, start.y);
    const [x1, y1] = this.cssToPdf(end.x,   end.y);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  // ── Popup dispatch (called from template) ──────────────────────────────────
  onPopupExtract(): void {
    const id = this.drawService.pendingId();
    if (id) this.drawService.dispatchPopupAction(id, 'extract');
  }

  onPopupRedact(): void {
    const id = this.drawService.pendingId();
    if (id) this.drawService.dispatchPopupAction(id, 'redact');
  }

  onPopupDismiss(): void {
    const id = this.drawService.pendingId();
    if (id) this.drawService.dispatchPopupAction(id, 'dismiss');
  }

  // ── Mouse events ───────────────────────────────────────────────────────────
  onMouseDown(event: MouseEvent): void {
    if (!this.drawService.isDrawMode() || !this.pageHeight1x) return;
    if (this.drawService.pendingId()) return; // block new draw while popup is open
    event.preventDefault();
    this.isDragging = true;
    const pt = this.getCanvasPoint(event.clientX, event.clientY);
    this.dragStartCss = this.dragCurrentCss = pt;
    this.updateSvgRects();
  }

  onMouseMove(event: MouseEvent): void {
    if (!this.isDragging || !this.drawService.isDrawMode()) return;
    event.preventDefault();
    this.dragCurrentCss = this.getCanvasPoint(event.clientX, event.clientY);
    this.updateSvgRects();
  }

  onMouseUp(event: MouseEvent): void {
    if (!this.isDragging) return;
    event.preventDefault();
    this.commitDrag(event.clientX, event.clientY);
  }

  onMouseLeave(event: MouseEvent): void {
    if (!this.isDragging) return;
    this.commitDrag(event.clientX, event.clientY);
  }

  // ── Touch events ───────────────────────────────────────────────────────────
  onTouchStart(event: TouchEvent): void {
    if (!this.drawService.isDrawMode() || !this.pageHeight1x) return;
    if (this.drawService.pendingId()) return;
    event.preventDefault();
    const touch = event.touches[0];
    this.isDragging = true;
    const pt = this.getCanvasPoint(touch.clientX, touch.clientY);
    this.dragStartCss = this.dragCurrentCss = pt;
    this.updateSvgRects();
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.isDragging || !this.drawService.isDrawMode()) return;
    event.preventDefault();
    const touch = event.touches[0];
    this.dragCurrentCss = this.getCanvasPoint(touch.clientX, touch.clientY);
    this.updateSvgRects();
  }

  onTouchEnd(event: TouchEvent): void {
    if (!this.isDragging) return;
    event.preventDefault();
    const touch = event.changedTouches[0];
    this.commitDrag(touch.clientX, touch.clientY);
  }

  // ── Commit ─────────────────────────────────────────────────────────────────
  private commitDrag(clientX: number, clientY: number): void {
    const endCss = this.getCanvasPoint(clientX, clientY);
    const wPx = Math.abs(endCss.x - this.dragStartCss.x);
    const hPx = Math.abs(endCss.y - this.dragStartCss.y);

    if (wPx >= 5 && hPx >= 5) {
      const pdfRect = this.buildPdfRect(this.dragStartCss, endCss);

      // Anchor popup to bottom-right corner of the drawn box, clamped to viewport
      const boxRight  = Math.max(endCss.x, this.dragStartCss.x);
      const boxBottom = Math.max(endCss.y, this.dragStartCss.y);
      const screen    = this.cssToScreen(boxRight, boxBottom);

      const POPUP_W  = 228;
      const POPUP_H  = 112;
      const anchorX  = Math.min(screen.x + 8, window.innerWidth  - POPUP_W - 8);
      const anchorY  = Math.min(screen.y + 8, window.innerHeight - POPUP_H - 8);

      customLogger.log('[viewer] draw commit — page:', this.currentPage(), 'rect:', pdfRect);
      this.drawService.addRect(this.currentPage(), pdfRect, { x: anchorX, y: anchorY });
    } else {
      customLogger.log('[viewer] draw skipped — too small:', wPx, hPx);
    }

    this.isDragging     = false;
    this.dragStartCss   = { x: 0, y: 0 };
    this.dragCurrentCss = { x: 0, y: 0 };
    this.updateSvgRects();
  }

  trackByIndex(index: number): number { return index; }
}