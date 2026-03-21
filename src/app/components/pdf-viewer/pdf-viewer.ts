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

interface SvgRect {
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  type: 'text' | 'ocr';
}

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatTooltipModule],
  templateUrl: './pdf-viewer.html',
  styleUrls: ['./pdf-viewer.scss'],
})
export class PdfViewerComponent implements OnInit, OnDestroy {
  @ViewChild('pdfCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('scrollArea', { static: false }) scrollRef!: ElementRef<HTMLDivElement>;

  protected highlightService = inject(HighlightService);
  public pdfService = inject(PdfService);
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
          // Delay one tick — ViewChild canvas must be in DOM before render
          setTimeout(() => this.render());
        } else {
          this.totalPages.set(0);
          this.currentPage.set(1);
          this.svgRects.set([]);
        }
      })
    );

    // Fires when bytes change (new file uploaded, reverted, or cleared).
    // pdfLoaded$ won't re-emit when isLoaded stays true (e.g. revert/overwrite).
    this.subs.add(
      this.pdfService.renderTrigger$.subscribe(() => {
        console.log('[viewer] renderTrigger$ fired, isLoaded:', this.pdfService.isLoaded());

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

  // Navigate to page when HighlightService requests it (from redaction panel click)
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

      // Store page dimensions for overlay coordinate math
      const pdfJsDoc = this.pdfService.getPdfJsDoc();
      if (pdfJsDoc) {
        const page = await pdfJsDoc.getPage(this.currentPage());
        const vp = page.getViewport({ scale: 1 });
        this.pageWidth1x = vp.width;
        this.pageHeight1x = vp.height;
      }

      // SVG dimensions match canvas CSS size
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

    this.svgRects.set(
      pageHighlights
        .filter(h => h.pageNum === this.currentPage())
        .map(h => this.toSvgRect(
          h,
          focused?.globalIndex === h.globalIndex && focused?.type === h.type,
        ))
    );
  }

  private toSvgRect(h: PageHighlight, focused: boolean): SvgRect {
    const [x0pdf, y0pdf, x1pdf, y1pdf] = h.rect;
    const z = this.zoomScale();
    const H = this.pageHeight1x;

    return {
      // PDF space → CSS pixels on canvas
      // x: straight multiply by zoom
      // y: flip because PDF origin is bottom-left, SVG is top-left
      x: x0pdf * z,
      y: (H - y1pdf) * z,
      w: (x1pdf - x0pdf) * z,
      h: (y1pdf - y0pdf) * z,
      focused,
      type: h.type,
    };
  }

  trackByIndex(index: number): number { return index; }
}