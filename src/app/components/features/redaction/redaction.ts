import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, Subscription } from 'rxjs';

import { PdfService } from '../../../services/pdf.service';
import { RedactionService } from './redaction.service';
import { OcrService } from './ocr.service';
import { HighlightService, PageHighlight } from '../../../services/highlight.service';
import { SearchMatch, OcrMatch } from './redaction.types';
import { customLogger } from '../../../../utils/custom-logger';
import { DrawService } from '../../../services/draw.service';

export type RedactionTab = 'search' | 'draw';

@Component({
  selector: 'app-redaction',
  imports: [CommonModule, FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './redaction.html',
  styleUrl: './redaction.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RedactionComponent implements OnDestroy {
  private pdfService        = inject(PdfService);
  private redactionService  = inject(RedactionService);
  private ocrService        = inject(OcrService);
  protected highlightService = inject(HighlightService);
  protected drawService     = inject(DrawService);
  private cdr               = inject(ChangeDetectorRef);

  // ── Tab ────────────────────────────────────────────────────────────────────
  readonly activeTab = signal<RedactionTab>('search');

  onTabChange(tab: RedactionTab): void {
    this.activeTab.set(tab);
    // When switching away from draw, turn off draw mode on the viewer
    if (tab !== 'draw') {
      this.drawService.disableDrawMode();
    }
  }

  // ── State signals ──────────────────────────────────────────────────────────
  searchTerm        = signal('');
  isSearching       = signal(false);
  isOcrSearching    = signal(false);
  isRedacting       = signal(false);
  hasSearched       = signal(false);
  errorMessage      = signal('');
  successMessage    = signal('');

  textMatches       = signal<SearchMatch[]>([]);
  includeTextMatches = signal(true);

  ocrMatches        = signal<OcrMatch[]>([]);
  ocrEnabled        = signal(true);

  redactionProgress = signal<{ page: number; total: number } | null>(null);
  ocrProgress       = signal<{ page: number; total: number } | null>(null);
  redactedBytes     = signal<Uint8Array | null>(null);
  redactedFilename  = signal('');

  // ── Progress bar ───────────────────────────────────────────────────────────
  readonly barWidth   = signal(0);
  readonly barVisible = signal(false);

  private startBar(): void {
    this.barWidth.set(0);
    this.barVisible.set(true);
    this.cdr.markForCheck();
    this.barWidth.set(8);
  }

  private updateBar(page: number, total: number): void {
    const next = 8 + (page / total) * 85;
    if (next > this.barWidth()) {
      this.barWidth.set(next);
      this.cdr.markForCheck();
    }
  }

  private completeBar(): void {
    this.barWidth.set(100);
    this.cdr.markForCheck();
    setTimeout(() => {
      this.barVisible.set(false);
      this.barWidth.set(0);
      this.cdr.markForCheck();
    }, 600);
  }

  private resetBar(): void {
    this.barWidth.set(0);
    this.barVisible.set(false);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  readonly textMatchCount  = computed(() => this.textMatches().length);
  readonly ocrMatchCount   = computed(() => this.ocrMatches().length);
  readonly totalMatchCount = computed(() => this.textMatchCount() + this.ocrMatchCount());
  readonly pdfIsLoaded     = computed(() => this.pdfService.isLoaded());

  readonly canRedact = computed(() => {
    if (this.isRedacting() || this.isSearching() || this.isOcrSearching()) return false;
    if (this.totalMatchCount() === 0) return false;
    const hasTextSelected = this.textMatchCount() > 0 && this.includeTextMatches();
    const hasOcrSelected  = this.ocrMatches().some(m => m.checked);
    return hasTextSelected || hasOcrSelected;
  });

  readonly canRedactDrawn = computed(() =>
    !this.isRedacting() && this.drawService.hasRects()
  );

  readonly selectedCount = computed(() => {
    const textCount = (this.includeTextMatches() && this.textMatchCount() > 0)
      ? this.textMatchCount() : 0;
    const ocrCount = this.ocrMatches().filter(m => m.checked).length;
    return textCount + ocrCount;
  });

  searchInput = '';
  private progressSub?: Subscription;

  // ── Search ─────────────────────────────────────────────────────────────────
  async onSearch(): Promise<void> {
    const term = this.searchInput.trim();
    if (!term)              { this.errorMessage.set('Please enter a search term.'); return; }
    if (!this.pdfIsLoaded()) { this.errorMessage.set('No PDF loaded.');             return; }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.isSearching.set(true);
    this.hasSearched.set(false);
    this.textMatches.set([]);
    this.ocrMatches.set([]);
    this.redactedBytes.set(null);
    this.searchTerm.set(term);
    this.includeTextMatches.set(true);
    this.highlightService.clear();

    if (this.ocrEnabled()) {
      this.isOcrSearching.set(true);
      this.startBar();
    }

    this.cdr.markForCheck();

    const tasks: Promise<any>[] = [this.runTextSearch(term)];
    if (this.ocrEnabled()) tasks.push(this.runOcrSearch(term));

    const [textResult, ocrResult] = await Promise.allSettled(tasks);

    if (textResult.status === 'fulfilled') {
      this.textMatches.set(textResult.value);
    } else {
      this.errorMessage.set('Text search failed: ' + textResult.reason?.message);
    }

    if (this.ocrEnabled() && ocrResult?.status === 'fulfilled') {
      this.ocrMatches.set(ocrResult.value);
    } else if (this.ocrEnabled()) {
      customLogger.warn('[Redaction] OCR search failed:', ocrResult);
    }

    this.isSearching.set(false);
    this.isOcrSearching.set(false);
    this.hasSearched.set(true);

    this.pushHighlights();
    this.cdr.markForCheck();
  }

  private async runTextSearch(term: string): Promise<SearchMatch[]> {
    const matches: SearchMatch[] = [];
    const total = this.pdfService.totalPages;

    for (let pageNum = 1; pageNum <= total; pageNum++) {
      const pageText = await this.pdfService.getPageText(pageNum);
      if (!pageText) continue;

      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex   = new RegExp(escaped, 'gi');
      let match: RegExpExecArray | null;

      const rects = await this.pdfService.getPageTextMatchRects(pageNum, term);
      let rectIndex = 0;

      while ((match = regex.exec(pageText)) !== null) {
        const ctxStart = Math.max(0, match.index - 40);
        const ctxEnd   = Math.min(pageText.length, match.index + term.length + 40);
        const rawCtx   = pageText.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
        const context  = (ctxStart > 0 ? '…' : '') + rawCtx + (ctxEnd < pageText.length ? '…' : '');

        matches.push({ page: pageNum, context, term, rect: rects[rectIndex] ?? rects[0] });
        rectIndex = (rectIndex + 1) % Math.max(rects.length, 1);
      }
    }

    return matches;
  }

  private async runOcrSearch(term: string): Promise<OcrMatch[]> {
    const pdfJsDoc = this.pdfService.getPdfJsDoc();
    if (!pdfJsDoc) return [];

    try {
      const results = await this.ocrService.findInImages(
        pdfJsDoc,
        term,
        this.pdfService.totalPages,
        (page, total) => {
          this.ocrProgress.set({ page, total });
          this.updateBar(page, total);
          this.cdr.markForCheck();
        },
      );
      this.completeBar();
      return results;
    } catch (err) {
      this.resetBar();
      throw err;
    }
  }

  // ── Highlight service sync ─────────────────────────────────────────────────
  private pushHighlights(): void {
    const highlights: PageHighlight[] = [];
    let globalIndex = 0;

    for (const m of this.textMatches()) {
      if (m.rect) {
        highlights.push({ pageNum: m.page, rect: m.rect, type: 'text', globalIndex });
      }
      globalIndex++;
    }

    for (const m of this.ocrMatches()) {
      highlights.push({ pageNum: m.page, rect: m.rect, type: 'ocr', globalIndex });
      globalIndex++;
    }

    this.highlightService.setHighlights(highlights);
  }

  // ── Match focus ────────────────────────────────────────────────────────────
  focusTextMatch(index: number): void {
    this.highlightService.setFocused({ type: 'text', globalIndex: index });
    this.highlightService.setActivePage(this.textMatches()[index].page);
  }

  focusOcrMatch(globalIndex: number, pageNum: number): void {
    this.highlightService.setFocused({ type: 'ocr', globalIndex });
    this.highlightService.setActivePage(pageNum);
  }

  // ── OCR match toggles ──────────────────────────────────────────────────────
  toggleOcrMatch(index: number, checked: boolean): void {
    const matches = this.ocrMatches().slice();
    matches[index] = { ...matches[index], checked };
    this.ocrMatches.set(matches);
  }

  toggleAllOcr(checked: boolean): void {
    this.ocrMatches.set(this.ocrMatches().map(m => ({ ...m, checked })));
  }

  // ── Redact (search results) ────────────────────────────────────────────────
  async onRedact(): Promise<void> {
    const term  = this.searchTerm();
    const bytes = this.pdfService.currentBytes();
    if (!term || !bytes) return;

    const includeText = this.includeTextMatches() && this.textMatchCount() > 0;
    const ocrRects    = this.ocrMatches()
      .filter(m => m.checked)
      .map(m => ({ pageIndex: m.page - 1, rect: m.rect }));

    customLogger.log('[Redaction] OCR rects sent to MuPDF:', JSON.stringify(ocrRects));

    if (!includeText && ocrRects.length === 0) return;

    await this.executeRedaction(bytes, { terms: includeText ? [term] : [], ocrRects });

    if (!this.errorMessage()) {
      this.textMatches.set([]);
      this.ocrMatches.set([]);
      this.hasSearched.set(false);
    }
  }

  // ── Redact (drawn regions) ─────────────────────────────────────────────────
  async onRedactDrawn(): Promise<void> {
    const bytes = this.pdfService.currentBytes();
    if (!bytes || !this.drawService.hasRects()) return;

    const ocrRects = this.drawService.toRedactionRects();
    customLogger.log('[Redaction] Drawn rects sent to MuPDF:', JSON.stringify(ocrRects));

    await this.executeRedaction(bytes, { terms: [], ocrRects });

    if (!this.errorMessage()) {
      this.drawService.clear();
    }
  }

  // ── Shared redaction execution ─────────────────────────────────────────────
  private async executeRedaction(
    bytes: Uint8Array,
    payload: { terms: string[]; ocrRects: Array<{ pageIndex: number; rect: [number, number, number, number] }> },
  ): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.isRedacting.set(true);
    this.redactedBytes.set(null);
    this.redactionProgress.set(null);
    this.highlightService.clear();
    this.cdr.markForCheck();

    const progress$ = new Subject<{ page: number; total: number }>();
    this.progressSub = progress$.subscribe(p => {
      this.redactionProgress.set(p);
      this.cdr.markForCheck();
    });

    try {
      const result = await this.redactionService.redact(
        bytes.slice(),
        { ...payload, fillColor: [0, 0, 0], clearMetadata: true },
        progress$,
      );

      await this.pdfService.commitBytes(result.bytes);
      this.redactedBytes.set(result.bytes);
      this.redactedFilename.set(this.buildRedactedFilename(this.pdfService.filename()));
      this.successMessage.set(
        `Done — ${result.matchCount} occurrence(s) on ${result.pagesAffected} page(s) redacted.`,
      );
    } catch (err: any) {
      this.errorMessage.set('Redaction failed: ' + (err?.message ?? String(err)));
    } finally {
      this.isRedacting.set(false);
      this.redactionProgress.set(null);
      this.progressSub?.unsubscribe();
      this.cdr.markForCheck();
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────
  onDownload(): void {
    const bytes = this.redactedBytes();
    if (bytes) this.redactionService.downloadPDF(bytes, this.redactedFilename());
  }

  // ── Clear (search) ────────────────────────────────────────────────────────
  onClear(): void {
    this.searchInput = '';
    this.searchTerm.set('');
    this.textMatches.set([]);
    this.ocrMatches.set([]);
    this.hasSearched.set(false);
    this.errorMessage.set('');
    this.successMessage.set('');
    this.redactedBytes.set(null);
    this.ocrProgress.set(null);
    this.includeTextMatches.set(true);
    this.highlightService.clear();
    this.resetBar();
    this.cdr.markForCheck();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  textMatchesByPage(): Array<{ page: number; matches: Array<SearchMatch & { index: number }> }> {
    const map = new Map<number, Array<SearchMatch & { index: number }>>();
    this.textMatches().forEach((m, index) => {
      const arr = map.get(m.page) ?? [];
      arr.push({ ...m, index });
      map.set(m.page, arr);
    });
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, matches]) => ({ page, matches }));
  }

  ocrMatchesByPage(): Array<{ page: number; matches: Array<OcrMatch & { index: number; globalIndex: number }> }> {
    const map = new Map<number, Array<OcrMatch & { index: number; globalIndex: number }>>();
    const textCount = this.textMatchCount();
    this.ocrMatches().forEach((m, index) => {
      const arr = map.get(m.page) ?? [];
      arr.push({ ...m, index, globalIndex: textCount + index });
      map.set(m.page, arr);
    });
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, matches]) => ({ page, matches }));
  }

  drawnRectsByPage() {
    return this.drawService.rectsByPage();
  }

  highlightTerm(context: string, term: string): string {
    const safe    = this.escapeHtml(context);
    if (!term) return safe;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private buildRedactedFilename(original: string): string {
    const dot = original.lastIndexOf('.');
    return dot !== -1
      ? original.slice(0, dot) + '_redacted' + original.slice(dot)
      : original + '_redacted.pdf';
  }

  ngOnDestroy(): void {
    this.progressSub?.unsubscribe();
    this.resetBar();
    this.highlightService.clear();
    this.drawService.disableDrawMode();
  }
}