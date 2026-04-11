import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { PdfService } from '../../../services/pdf.service';
import { RedactionService } from './redaction.service';
import { OcrService } from './ocr.service';
import { HighlightService, PageHighlight } from '../../../services/highlight.service';
import { SearchMatch, OcrMatch } from './redaction.types';
import { customLogger } from '../../../../utils/custom-logger';
import { DrawService } from '../../../services/draw.service';
import { Subscription } from 'rxjs';

export type RedactionTab = 'search' | 'draw';

type ProgressCallback = (p: { page: number; total: number }) => void;

@Component({
  selector: 'app-redaction',
  imports: [FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './redaction.html',
  styleUrl: './redaction.scss',
})
export class RedactionComponent implements OnInit, OnDestroy {
  private pdfService         = inject(PdfService);
  private redactionService   = inject(RedactionService);
  private ocrService         = inject(OcrService);
  protected highlightService = inject(HighlightService);
  protected drawService      = inject(DrawService);

  // ── Tab ────────────────────────────────────────────────────────────────────
  readonly activeTab = signal<RedactionTab>('search');

  onTabChange(tab: RedactionTab): void {
    this.activeTab.set(tab);
  }

  // ── State signals ──────────────────────────────────────────────────────────
  readonly searchTerm         = signal('');
  readonly isSearching        = signal(false);
  readonly isOcrSearching     = signal(false);
  readonly isRedacting        = signal(false);
  readonly isExtracting       = signal(false);
  readonly hasSearched        = signal(false);
  readonly errorMessage       = signal('');
  readonly successMessage     = signal('');
  readonly textMatches        = signal<SearchMatch[]>([]);
  readonly includeTextMatches = signal(true);
  readonly ocrMatches         = signal<OcrMatch[]>([]);
  readonly ocrEnabled         = signal(true);
  readonly redactionProgress  = signal<{ page: number; total: number } | null>(null);
  readonly ocrProgress        = signal<{ page: number; total: number } | null>(null);
  readonly redactedBytes      = signal<Uint8Array | null>(null);
  readonly redactedFilename   = signal('');
  readonly redactionMode      = signal<'redact' | 'blendIn'>('redact');

  // ── Progress bar ───────────────────────────────────────────────────────────
  readonly barWidth   = signal(0);
  readonly barVisible = signal(false);

  private startBar():                      void { this.barWidth.set(8); this.barVisible.set(true); }
  private updateBar(p: number, t: number): void { const n = 8 + (p / t) * 85; if (n > this.barWidth()) this.barWidth.set(n); }
  private completeBar():                   void { this.barWidth.set(100); setTimeout(() => { this.barVisible.set(false); this.barWidth.set(0); }, 600); }
  private resetBar():                      void { this.barWidth.set(0); this.barVisible.set(false); }

  private subs = new Subscription();

  ngOnInit(): void {
    this.subs.add(
      this.pdfService.renderTrigger$.subscribe(() => {
        this.onClear();
        this.drawService.clear();
      }),
    );

    // Handle draw popup actions
    this.subs.add(
      this.drawService.action$.subscribe(({ id, action }) => {
        if (action === 'extract') this.handleExtractRegion(id);
        if (action === 'redact')  this.activeTab.set('draw'); // navigate to show the queue
      }),
    );
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
    !this.isRedacting() && this.drawService.redactRects().length > 0,
  );

  readonly selectedCount = computed(() => {
    const textCount = (this.includeTextMatches() && this.textMatchCount() > 0)
      ? this.textMatchCount() : 0;
    return textCount + this.ocrMatches().filter(m => m.checked).length;
  });

  readonly textMatchesByPage = computed(() => {
    const map = new Map<number, Array<SearchMatch & { index: number }>>();
    this.textMatches().forEach((m, index) => {
      const arr = map.get(m.page) ?? [];
      arr.push({ ...m, index });
      map.set(m.page, arr);
    });
    return [...map.entries()].sort(([a], [b]) => a - b).map(([page, matches]) => ({ page, matches }));
  });

  readonly ocrMatchesByPage = computed(() => {
    const map = new Map<number, Array<OcrMatch & { index: number; globalIndex: number }>>();
    const textCount = this.textMatchCount();
    this.ocrMatches().forEach((m, index) => {
      const arr = map.get(m.page) ?? [];
      arr.push({ ...m, index, globalIndex: textCount + index });
      map.set(m.page, arr);
    });
    return [...map.entries()].sort(([a], [b]) => a - b).map(([page, matches]) => ({ page, matches }));
  });

  searchInput = '';

  // ── Extract region → populate search ──────────────────────────────────────
  /**
   * OCRs a single drawn region.
   * On success: sets rect purpose to 'extract', populates searchInput,
   *             switches to Search tab, runs search.
   * On failure: removes the pending rect, shows error.
   */
  async handleExtractRegion(id: string): Promise<void> {
    const rect = this.drawService.drawnRects().find(r => r.id === id);
    if (!rect) return;

    const pdfJsDoc = this.pdfService.getPdfJsDoc();
    if (!pdfJsDoc) return;

    this.isExtracting.set(true);
    this.errorMessage.set('');
    this.activeTab.set('search'); // navigate immediately so user sees feedback

    try {
      const result = await this.ocrService.extractTextFromRegion(
        pdfJsDoc,
        rect.pageNum,
        rect.rect,
      );

      this.drawService.setPurpose(id, 'extract', {
        extractedText: result.text,
        confidence:    result.confidence,
      });

      const text = result.text.trim();
      if (text) {
        this.searchInput = text;
        await this.onSearch();
      } else {
        this.errorMessage.set('No text found in selected region.');
        this.drawService.removeRect(id);
      }
    } catch (err: unknown) {
      this.errorMessage.set('Region OCR failed: ' + (err instanceof Error ? err.message : String(err)));
      this.drawService.removeRect(id);
    } finally {
      this.isExtracting.set(false);
    }
  }

  /**
   * Re-runs a search from an extract-purpose rect already in the regions list.
   * Called from the Regions tab "Re-search" button.
   */
  async reSearchFromRect(extractedText: string): Promise<void> {
    this.searchInput = extractedText;
    this.activeTab.set('search');
    await this.onSearch();
  }

  /**
   * Promotes a drawn rect straight to redact from the Regions tab action buttons
   * (works for any purpose, including 'extract').
   */
  promoteToRedact(id: string): void {
    this.drawService.setPurpose(id, 'redact');
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  async onSearch(): Promise<void> {
    const term = this.searchInput.trim();
    if (!term)               { this.errorMessage.set('Please enter a search term.'); return; }
    if (!this.pdfIsLoaded()) { this.errorMessage.set('No PDF loaded.');              return; }

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
        },
      );
      this.completeBar();
      return results;
    } catch (err) {
      this.resetBar();
      throw err;
    }
  }

  // ── Highlight sync ─────────────────────────────────────────────────────────
  private pushHighlights(): void {
    const highlights: PageHighlight[] = [];
    let globalIndex = 0;

    for (const m of this.textMatches()) {
      if (m.rect) highlights.push({ pageNum: m.page, rect: m.rect, type: 'text', globalIndex });
      globalIndex++;
    }
    for (const m of this.ocrMatches()) {
      highlights.push({ pageNum: m.page, rect: m.rect, type: 'ocr', globalIndex });
      globalIndex++;
    }

    this.highlightService.setHighlights(highlights);
  }

  // ── Focus ──────────────────────────────────────────────────────────────────
  focusTextMatch(index: number): void {
    this.highlightService.setFocused({ type: 'text', globalIndex: index });
    this.highlightService.setActivePage(this.textMatches()[index].page);
  }

  focusOcrMatch(globalIndex: number, pageNum: number): void {
    this.highlightService.setFocused({ type: 'ocr', globalIndex });
    this.highlightService.setActivePage(pageNum);
  }

  // ── OCR toggles ────────────────────────────────────────────────────────────
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

    if (!includeText && ocrRects.length === 0) return;
    await this.executeRedaction(bytes, { terms: includeText ? [term] : [], ocrRects });

    if (!this.errorMessage()) {
      this.textMatches.set([]);
      this.ocrMatches.set([]);
      this.hasSearched.set(false);
    }
  }

  // ── Redact (drawn redact-purpose regions) ──────────────────────────────────
  async onRedactDrawn(): Promise<void> {
    const bytes = this.pdfService.currentBytes();
    if (!bytes || !this.drawService.redactRects().length) return;

    const ocrRects = this.drawService.toRedactionRects();
    customLogger.log('[Redaction] Drawn rects →', JSON.stringify(ocrRects));

    await this.executeRedaction(bytes, { terms: [], ocrRects });
    if (!this.errorMessage()) this.drawService.clear();
  }

  // ── Shared redaction execution ─────────────────────────────────────────────
  private async executeRedaction(
    bytes:   Uint8Array,
    payload: { terms: string[]; ocrRects: Array<{ pageIndex: number; rect: [number, number, number, number] }> },
  ): Promise<void> {
    this.errorMessage.set('');
    this.successMessage.set('');
    this.isRedacting.set(true);
    this.redactedBytes.set(null);
    this.redactionProgress.set(null);
    this.highlightService.clear();

    const onProgress: ProgressCallback = p => this.redactionProgress.set(p);

    try {
      const result = await this.redactionService.redact(
        bytes.slice(),
        { ...payload, fillColor: [0, 0, 0], clearMetadata: true, redactionMode: this.redactionMode() },
        onProgress,
      );

      await this.pdfService.commitBytes(result.bytes);
      this.redactedBytes.set(result.bytes);
      this.redactedFilename.set(this.buildRedactedFilename(this.pdfService.filename()));
      this.successMessage.set(
        `Done — ${result.matchCount} occurrence(s) on ${result.pagesAffected} page(s) redacted.`,
      );
    } catch (err: unknown) {
      this.errorMessage.set('Redaction failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.isRedacting.set(false);
      this.redactionProgress.set(null);
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────
  onDownload(): void {
    const bytes = this.redactedBytes();
    if (bytes) this.redactionService.downloadPDF(bytes, this.redactedFilename());
  }

  // ── Clear ──────────────────────────────────────────────────────────────────
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
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  highlightTerm(context: string, term: string): string {
    const safe = this.escapeHtml(context);
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
    this.subs.unsubscribe();
    this.resetBar();
    this.highlightService.clear();
  }
}