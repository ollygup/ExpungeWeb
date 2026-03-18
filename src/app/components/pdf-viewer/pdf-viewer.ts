import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subscription } from 'rxjs';
import { PdfService } from '../../services/pdf.service';

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

  pdfLoaded = false;
  isRendering = false;
  currentPage = 1;
  totalPages = 0;
  zoom = 100;

  get zoomScale() { return this.zoom / 100; }

  private subs = new Subscription();

  constructor(
    public pdfService: PdfService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.pdfService.loadFromIndexedDB();

    this.subs.add(
      this.pdfService.pdfLoaded$.subscribe(loaded => {
        this.pdfLoaded = loaded;
        if (loaded) {
          this.totalPages = this.pdfService.totalPages;
          this.currentPage = 1;
          setTimeout(() => this.render(), 60);
        }
      })
    );

    // Re-render when redaction is applied (new PDF bytes)
    this.subs.add(
      this.pdfService.renderTrigger$.subscribe(() => {
        setTimeout(() => this.render(), 30);
      })
    );
  }

  ngOnDestroy(): void { this.subs.unsubscribe(); }

  // ── Navigation ───────────────────────────────────────────────
  prevPage(): void {
    if (this.currentPage > 1) { this.currentPage--; this.render(); }
  }

  nextPage(): void {
    if (this.currentPage < this.totalPages) { this.currentPage++; this.render(); }
  }

  goToPage(n: number): void {
    const p = Math.max(1, Math.min(n, this.totalPages));
    if (p !== this.currentPage) { this.currentPage = p; this.render(); }
  }

  // ── Zoom ─────────────────────────────────────────────────────
  zoomIn():  void { this.zoom = Math.min(250, this.zoom + 25); }
  zoomOut(): void { this.zoom = Math.max(50,  this.zoom - 25); }
  zoomFit(): void { this.zoom = 100; }

  // ── Page Render ──────────────────────────────────────────────
  async render(): Promise<void> {
    if (!this.canvasRef?.nativeElement) return;
    this.isRendering = true;

    try {
      const canvas = this.canvasRef.nativeElement;
      await this.pdfService.renderPage(this.currentPage, canvas, this.zoomScale);

      // Notify service of current viewport (needed for redaction coordinate mapping)
      this.pdfService.setCurrentPageInfo(this.currentPage, this.zoomScale);
    } finally {
      this.zone.run(() => { this.isRendering = false; });
    }
  }
}