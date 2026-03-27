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
  type: 'text' | 'ocr' | 'draw' | 'draw-focused' | 'draw-preview';
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
  public pdfService = inject(PdfService);
  protected drawService = inject(DrawService);
  private zone = inject(NgZone);

  // ── Signals ──────────────────────────────────────────────────
  readonly pdfLoaded = signal(false);
  readonly isRendering = signal(false);
  readonly currentPage = signal(1);
  readonly totalPages = signal(0);
  readonly zoom = signal(100);
  readonly svgRects = signal<SvgRect[]>([]);

  // Page dimensions at scale=1 (PDF points) — needed for overlay coord math
  pageWidth1x = 0;
  pageHeight1x = 0;

  // SVG overlay dimensions (CSS pixels, matches canvas.style dimensions)
  svgWidth = 0;
  svgHeight = 0;

  readonly zoomScale = computed(() => this.zoom() / 100);

  // ── Draw state ────────────────────────────────────────────────
  // All in canvas CSS-pixel space (pre-transform, matching SVG overlay coords)
  private isDragging = false;
  private dragStartCss = { x: 0, y: 0 };
  private dragCurrentCss = { x: 0, y: 0 };

  private subs = new Subscription();
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
      })
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
      })
    );

    const intervalId = setInterval(() => this.updateSvgRects(), 100);
    this.subs.add({ unsubscribe: () => clearInterval(intervalId) });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.renderController?.abort();
  }

  // ── Navigation ────────────────────────────────────────────────
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
    const requestedPage = this.highlightService.activePage();
    if (requestedPage !== this.lastActivePage && requestedPage !== this.currentPage()) {
      this.lastActivePage = requestedPage;
      this.goToPage(requestedPage);
    }
  }

  // ── Zoom ──────────────────────────────────────────────────────
  zoomIn(): void { this.zoom.update(z => Math.min(250, z + 25)); this.render(); }
  zoomOut(): void { this.zoom.update(z => Math.max(50, z - 25)); this.render(); }
  zoomFit(): void { this.zoom.set(100); this.render(); }

  // ── Render ────────────────────────────────────────────────────
  async render(): Promise<void> {
    this.renderController?.abort();
    this.renderController = new AbortController();
    const abortSignal = this.renderController.signal;

    if (!this.canvasRef?.nativeElement) return;
    this.isRendering.set(true);

    const canvas = this.canvasRef.nativeElement;
    canvas.width = 0;
    canvas.height = 0;

    try {
      if (abortSignal.aborted) return;
      await this.pdfService.renderPage(this.currentPage(), canvas, this.zoomScale());
      if (abortSignal.aborted) return;

      const pdfJsDoc = this.pdfService.getPdfJsDoc();
      if (pdfJsDoc) {
        const page = await pdfJsDoc.getPage(this.currentPage());
        const vp = page.getViewport({ scale: 1 });
        this.pageWidth1x = vp.width;
        this.pageHeight1x = vp.height;
      }

      this.svgWidth = parseInt(canvas.style.width, 10) || canvas.width;
      this.svgHeight = parseInt(canvas.style.height, 10) || canvas.height;

      this.pdfService.setCurrentPageInfo(this.currentPage(), this.zoomScale());
      this.updateSvgRects();
    } finally {
      if (!abortSignal.aborted) {
        this.zone.run(() => this.isRendering.set(false));
      }
    }
  }

  // ── Overlay ───────────────────────────────────────────────────
  updateSvgRects(): void {
    this.checkPageNavigation();

    const pageHighlights = this.highlightService.pageHighlights();
    const focused = this.highlightService.focused();
    const focusedDrawId = this.drawService.focusedRectId();

    // Search / OCR highlights
    const highlightRects: SvgRect[] = pageHighlights
      .filter(h => h.pageNum === this.currentPage())
      .map(h => this.toSvgRect(
        h,
        focused?.globalIndex === h.globalIndex && focused?.type === h.type,
      ));

    // Committed drawn rects for current page — focused one gets its own type
    const drawnRects: SvgRect[] = this.drawService.drawnRects()
      .filter(r => r.pageNum === this.currentPage())
      .map(r => this.pdfRectToSvgRect(
        r.rect,
        r.id === focusedDrawId ? 'draw-focused' : 'draw',
      ));

    // Live drag preview
    const previewRects: SvgRect[] = (this.isDragging && this.drawService.isDrawMode())
      ? [this.buildPreviewRect()]
      : [];

    this.svgRects.set([...highlightRects, ...drawnRects, ...previewRects]);
  }

  private toSvgRect(h: PageHighlight, focused: boolean): SvgRect {
    const [x0pdf, y0pdf, x1pdf, y1pdf] = h.rect;
    const z = this.zoomScale();
    const H = this.pageHeight1x;

    return {
      x: x0pdf * z,
      y: (H - y1pdf) * z,
      w: (x1pdf - x0pdf) * z,
      h: (y1pdf - y0pdf) * z,
      focused,
      type: h.type,
    };
  }

  /** Converts a PDF-space rect [x0,y0,x1,y1] to an SvgRect in CSS-pixel space. */
  private pdfRectToSvgRect(
    rect: [number, number, number, number],
    type: SvgRect['type'],
  ): SvgRect {
    const [x0pdf, y0pdf, x1pdf, y1pdf] = rect;
    const z = this.zoomScale();
    const H = this.pageHeight1x;

    return {
      x: x0pdf * z,
      y: (H - y1pdf) * z,
      w: (x1pdf - x0pdf) * z,
      h: (y1pdf - y0pdf) * z,
      focused: false,
      type,
    };
  }

  /** Builds the live preview rect from the current drag positions (CSS pixels). */
  private buildPreviewRect(): SvgRect {
    const x = Math.min(this.dragStartCss.x, this.dragCurrentCss.x);
    const y = Math.min(this.dragStartCss.y, this.dragCurrentCss.y);
    const w = Math.abs(this.dragCurrentCss.x - this.dragStartCss.x);
    const h = Math.abs(this.dragCurrentCss.y - this.dragStartCss.y);

    return { x, y, w, h, focused: false, type: 'draw-preview' };
  }

  // ── Draw — coordinate helpers ─────────────────────────────────

  /**
   * Converts a pointer clientX/Y to canvas CSS-pixel space (pre-transform).
   * canvas.getBoundingClientRect() returns the visual (post-transform) rect.
   * canvas.offsetWidth is the CSS-pixel width (pre-transform).
   * The ratio corrects for the CSS scale transform on canvas-wrap.
   */
  private getCanvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.offsetWidth / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  /**
   * Converts canvas CSS-pixel coords to PDF space.
   * canvas.style.width = pageWidth1x * zoomScale  →  pdfX = cssX / zoomScale
   * SVG y is flipped vs PDF y:  cssY = (H - pdfY) * z  →  pdfY = H - cssY / z
   */
  private cssToPdf(cssX: number, cssY: number): [number, number] {
    const z = this.zoomScale();
    const H = this.pageHeight1x;

    return [cssX / z, H - cssY / z];
  }

  /** Returns a normalised PDF-space rect [x0,y0,x1,y1] from two CSS-pixel points. */
  private buildPdfRect(
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): [number, number, number, number] {
    const [x0, y0] = this.cssToPdf(start.x, start.y);
    const [x1, y1] = this.cssToPdf(end.x, end.y);

    // Normalise so x0 < x1 and y0 < y1 regardless of drag direction
    return [
      Math.min(x0, x1),
      Math.min(y0, y1),
      Math.max(x0, x1),
      Math.max(y0, y1),
    ];
  }

  // ── Draw — mouse events ───────────────────────────────────────
  onMouseDown(event: MouseEvent): void {
    if (!this.drawService.isDrawMode() || !this.pageHeight1x) return;
    event.preventDefault();

    this.isDragging = true;
    const pt = this.getCanvasPoint(event.clientX, event.clientY);
    this.dragStartCss = pt;
    this.dragCurrentCss = pt;
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
    // Commit if mouse leaves canvas while dragging (e.g. drag too fast)
    if (!this.isDragging) return;
    this.commitDrag(event.clientX, event.clientY);
  }

  // ── Draw — touch events ───────────────────────────────────────
  onTouchStart(event: TouchEvent): void {
    if (!this.drawService.isDrawMode() || !this.pageHeight1x) return;
    // Prevent scroll while drawing
    event.preventDefault();

    const touch = event.touches[0];
    this.isDragging = true;
    const pt = this.getCanvasPoint(touch.clientX, touch.clientY);
    this.dragStartCss = pt;
    this.dragCurrentCss = pt;
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

  // ── Draw — commit ─────────────────────────────────────────────
  private commitDrag(clientX: number, clientY: number): void {
    const endCss = this.getCanvasPoint(clientX, clientY);
    const pdfRect = this.buildPdfRect(this.dragStartCss, endCss);

    const MIN_SIZE_PX = 5; // ignore accidental tiny taps
    const wPx = Math.abs(endCss.x - this.dragStartCss.x);
    const hPx = Math.abs(endCss.y - this.dragStartCss.y);

    if (wPx >= MIN_SIZE_PX && hPx >= MIN_SIZE_PX) {
      customLogger.log('[viewer] draw commit — page:', this.currentPage(), 'rect:', pdfRect);
      this.drawService.addRect(this.currentPage(), pdfRect);
    } else {
      customLogger.log('[viewer] draw commit skipped — too small:', wPx, hPx);
    }

    this.isDragging = false;
    this.dragStartCss = { x: 0, y: 0 };
    this.dragCurrentCss = { x: 0, y: 0 };
    this.updateSvgRects();
  }

  trackByIndex(index: number): number { return index; }
}