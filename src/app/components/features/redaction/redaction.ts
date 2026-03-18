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
import { SearchMatch } from './redaction.types';

@Component({
  selector: 'app-redaction',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatTooltipModule],
  templateUrl: './redaction.html',
  styleUrl: './redaction.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RedactionComponent implements OnDestroy {
  private pdfService = inject(PdfService);
  private redactionService = inject(RedactionService);
  private cdr = inject(ChangeDetectorRef);

  // ── State signals ─────────────────────────────────────────────
  searchTerm = signal('');
  isSearching = signal(false);
  isRedacting = signal(false);
  searchMatches = signal<SearchMatch[]>([]);
  hasSearched = signal(false);
  errorMessage = signal('');
  successMessage = signal('');
  redactionProgress = signal<{ page: number; total: number } | null>(null);
  redactedBytes = signal<Uint8Array | null>(null);
  redactedFilename = signal('');

  // Derived
  readonly matchCount = computed(() => this.searchMatches().length);
  readonly uniquePages = computed(() =>
    [...new Set(this.searchMatches().map(m => m.page))].sort((a, b) => a - b)
  );
  readonly pdfIsLoaded = computed(() => this.pdfService.isLoaded());
  readonly canRedact = computed(() =>
    this.matchCount() > 0 && !this.isRedacting() && !this.isSearching()
  );

  // Two-way bound to the search <input>
  searchInput = '';

  private progressSub?: Subscription;

  // ── Search ────────────────────────────────────────────────────
  async onSearch(): Promise<void> {
    const term = this.searchInput.trim();
    if (!term) { this.errorMessage.set('Please enter a search term.'); return; }
    if (!this.pdfIsLoaded()) { this.errorMessage.set('No PDF loaded.'); return; }

    this.errorMessage.set('');
    this.successMessage.set('');
    this.isSearching.set(true);
    this.hasSearched.set(false);
    this.searchMatches.set([]);
    this.redactedBytes.set(null);
    this.searchTerm.set(term);
    this.cdr.markForCheck();

    const matches: SearchMatch[] = [];
    const total = this.pdfService.totalPages;

    try {
      for (let pageNum = 1; pageNum <= total; pageNum++) {
        const pageText = await this.pdfService.getPageText(pageNum);
        if (!pageText) continue;

        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(pageText)) !== null) {
          const ctxStart = Math.max(0, match.index - 40);
          const ctxEnd = Math.min(pageText.length, match.index + term.length + 40);
          const rawCtx = pageText.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
          const context = (ctxStart > 0 ? '…' : '') + rawCtx + (ctxEnd < pageText.length ? '…' : '');

          matches.push({ page: pageNum, context, term });
        }
      }
    } catch (err: any) {
      this.errorMessage.set('Search failed: ' + (err?.message ?? String(err)));
    } finally {
      this.searchMatches.set(matches);
      this.hasSearched.set(true);
      this.isSearching.set(false);
      this.cdr.markForCheck();
    }
  }

  // ── Redact ────────────────────────────────────────────────────
  async onRedact(): Promise<void> {
    const term = this.searchTerm();
    const bytes = this.pdfService.currentBytes();
    console.log(bytes);
    if (!term || !bytes) return;

    this.errorMessage.set('');
    this.successMessage.set('');
    this.isRedacting.set(true);
    this.redactedBytes.set(null);
    this.redactionProgress.set(null);
    this.cdr.markForCheck();

    const progress$ = new Subject<{ page: number; total: number }>();
    this.progressSub = progress$.subscribe(p => {
      this.redactionProgress.set(p);
      this.cdr.markForCheck();
    });

    try {
      const result = await this.redactionService.redact(
        bytes.slice(),
        { terms: [term], caseSensitive: false, fillColor: [0, 0, 0], clearMetadata: true },
        progress$,
      );

      await this.pdfService.commitBytes(result.bytes);

      this.redactedBytes.set(result.bytes);
      this.redactedFilename.set(this.buildRedactedFilename(this.pdfService.filename()));
      this.successMessage.set(
        `Done — ${result.matchCount} occurrence(s) on ${result.pagesAffected} page(s) redacted.`,
      );
      this.searchMatches.set([]);
      this.hasSearched.set(false);
    } catch (err: any) {
      this.errorMessage.set('Redaction failed: ' + (err?.message ?? String(err)));
    } finally {
      this.isRedacting.set(false);
      this.redactionProgress.set(null);
      this.progressSub?.unsubscribe();
      this.cdr.markForCheck();
    }
  }

  // ── Download ──────────────────────────────────────────────────
  onDownload(): void {
    const bytes = this.redactedBytes();
    if (bytes) this.redactionService.downloadPDF(bytes, this.redactedFilename());
  }

  // ── Clear ─────────────────────────────────────────────────────
  onClear(): void {
    this.searchInput = '';
    this.searchTerm.set('');
    this.searchMatches.set([]);
    this.hasSearched.set(false);
    this.errorMessage.set('');
    this.successMessage.set('');
    this.redactedBytes.set(null);
    this.cdr.markForCheck();
  }

  // ── Helpers ───────────────────────────────────────────────────
  matchesByPage(): Array<{ page: number; matches: SearchMatch[] }> {
    const map = new Map<number, SearchMatch[]>();
    for (const m of this.searchMatches()) {
      const arr = map.get(m.page) ?? [];
      arr.push(m);
      map.set(m.page, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, matches]) => ({ page, matches }));
  }

  highlightTerm(context: string, term: string): string {
    const safe = this.escapeHtml(context);
    if (!term) return safe;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private buildRedactedFilename(original: string): string {
    const dot = original.lastIndexOf('.');
    return dot !== -1
      ? original.slice(0, dot) + '_redacted' + original.slice(dot)
      : original + '_redacted.pdf';
  }

  ngOnDestroy(): void {
    this.progressSub?.unsubscribe();
  }
}