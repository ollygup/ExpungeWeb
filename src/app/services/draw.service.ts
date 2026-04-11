import { Injectable, signal, computed } from '@angular/core';
import { Subject } from 'rxjs';

export type DrawSubMode       = 'single' | 'multi';
export type DrawnRectPurpose  = 'pending' | 'extract' | 'redact';

export interface DrawnRect {
  id:             string;
  pageNum:        number;
  rect:           [number, number, number, number]; // PDF space [x0, y0, x1, y1]
  purpose:        DrawnRectPurpose;
  extractedText?: string;
  confidence?:    number;
}

export interface DrawPopupAction {
  id:     string;
  action: 'extract' | 'redact' | 'dismiss';
}

@Injectable({ providedIn: 'root' })
export class DrawService {

  // ── State ──────────────────────────────────────────────────────────────────
  private _rects      = signal<DrawnRect[]>([]);
  private _isDrawMode = signal(false);
  private _subMode    = signal<DrawSubMode>('single');
  private _focusedId  = signal<string | null>(null);
  private _pendingId  = signal<string | null>(null);
  private _popupPos   = signal<{ x: number; y: number } | null>(null);

  readonly drawnRects    = this._rects.asReadonly();
  readonly isDrawMode    = this._isDrawMode.asReadonly();
  readonly subMode       = this._subMode.asReadonly();
  readonly focusedRectId = this._focusedId.asReadonly();
  readonly pendingId     = this._pendingId.asReadonly();
  readonly popupPos      = this._popupPos.asReadonly();

  /** Fires when user picks an action from the single-mode popup. */
  readonly action$ = new Subject<DrawPopupAction>();

  // ── Computed ───────────────────────────────────────────────────────────────
  readonly hasRects    = computed(() => this._rects().length > 0);
  readonly rectCount   = computed(() => this._rects().length);
  readonly redactRects = computed(() => this._rects().filter(r => r.purpose === 'redact'));
  readonly extractRects = computed(() => this._rects().filter(r => r.purpose === 'extract'));

  readonly rectsByPage = computed(() => {
    const map = new Map<number, DrawnRect[]>();
    for (const r of this._rects()) {
      const arr = map.get(r.pageNum) ?? [];
      arr.push(r);
      map.set(r.pageNum, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, rects]) => ({ page, rects }));
  });

  // ── Draw mode ──────────────────────────────────────────────────────────────
  toggleDrawMode(): void  { this._isDrawMode.update(v => !v); }
  enableDrawMode(): void  { this._isDrawMode.set(true); }
  disableDrawMode(): void { this._isDrawMode.set(false); }
  setSubMode(m: DrawSubMode): void { this._subMode.set(m); }

  // ── Focus ──────────────────────────────────────────────────────────────────
  setFocused(id: string): void {
    this._focusedId.set(this._focusedId() === id ? null : id);
  }
  clearFocused(): void { this._focusedId.set(null); }

  // ── Rect lifecycle ─────────────────────────────────────────────────────────

  /**
   * Called by PdfViewerComponent after a drag completes.
   * - single mode → rect is 'pending', popup shown at popupPos
   * - multi mode  → rect goes straight to 'redact', no popup
   */
  addRect(
    pageNum:  number,
    rect:     [number, number, number, number],
    popupPos: { x: number; y: number },
  ): string {
    const id      = `draw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const purpose = this._subMode() === 'multi' ? 'redact' : 'pending';
    this._rects.update(rs => [...rs, { id, pageNum, rect, purpose }]);
    if (purpose === 'pending') {
      this._pendingId.set(id);
      this._popupPos.set(popupPos);
    }
    return id;
  }

  setPurpose(
    id:      string,
    purpose: DrawnRectPurpose,
    extras?: { extractedText?: string; confidence?: number },
  ): void {
    this._rects.update(rs =>
      rs.map(r => r.id === id ? { ...r, purpose, ...extras } : r),
    );
    if (this._pendingId() === id) {
      this._pendingId.set(null);
      this._popupPos.set(null);
    }
  }

  dismissPending(): void {
    const id = this._pendingId();
    if (id) this._rects.update(rs => rs.filter(r => r.id !== id));
    this._pendingId.set(null);
    this._popupPos.set(null);
  }

  removeRect(id: string): void {
    this._rects.update(rs => rs.filter(r => r.id !== id));
    if (this._focusedId() === id) this._focusedId.set(null);
    if (this._pendingId() === id) {
      this._pendingId.set(null);
      this._popupPos.set(null);
    }
  }

  clear(): void {
    this._rects.set([]);
    this._focusedId.set(null);
    this._pendingId.set(null);
    this._popupPos.set(null);
  }

  /**
   * - 'redact':  resolves pending rect as 'redact'
   * - 'dismiss': removes pending rect
   * - 'extract': leaves as 'pending'; RedactionComponent resolves after OCR
   */
  dispatchPopupAction(id: string, action: DrawPopupAction['action']): void {
    if (action === 'redact')  this.setPurpose(id, 'redact');
    if (action === 'dismiss') this.dismissPending();
    this.action$.next({ id, action });
  }

  // ── MuPDF payload ──────────────────────────────────────────────────────────
  toRedactionRects(): Array<{ pageIndex: number; rect: [number, number, number, number] }> {
    return this.redactRects().map(r => ({ pageIndex: r.pageNum - 1, rect: r.rect }));
  }
}