import { Injectable, signal, computed } from '@angular/core';

export interface DrawnRect {
  id: string;
  pageNum: number;
  rect: [number, number, number, number]; // PDF space [x0, y0, x1, y1]
}

@Injectable({ providedIn: 'root' })
export class DrawService {

  // ── State ──────────────────────────────────────────────────────────────────
  readonly drawnRects    = signal<DrawnRect[]>([]);
  readonly isDrawMode    = signal(false);
  readonly focusedRectId = signal<string | null>(null);

  readonly hasRects  = computed(() => this.drawnRects().length > 0);
  readonly rectCount = computed(() => this.drawnRects().length);

  // ── Draw mode ──────────────────────────────────────────────────────────────
  toggleDrawMode(): void  { this.isDrawMode.update(v => !v); }
  enableDrawMode(): void  { this.isDrawMode.set(true); }
  disableDrawMode(): void { this.isDrawMode.set(false); }

  // ── Focus ──────────────────────────────────────────────────────────────────
  setFocused(id: string): void {
    // clicking the same row again clears focus
    this.focusedRectId.set(this.focusedRectId() === id ? null : id);
  }

  clearFocused(): void {
    this.focusedRectId.set(null);
  }

  // ── Rect management ────────────────────────────────────────────────────────
  addRect(pageNum: number, rect: [number, number, number, number]): void {
    const id = `draw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.drawnRects.update(rects => [...rects, { id, pageNum, rect }]);
  }

  removeRect(id: string): void {
    if (this.focusedRectId() === id) this.focusedRectId.set(null);
    this.drawnRects.update(rects => rects.filter(r => r.id !== id));
  }

  clear(): void {
    this.drawnRects.set([]);
    this.focusedRectId.set(null);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  rectsByPage(): Array<{ page: number; rects: DrawnRect[] }> {
    const map = new Map<number, DrawnRect[]>();
    for (const r of this.drawnRects()) {
      const arr = map.get(r.pageNum) ?? [];
      arr.push(r);
      map.set(r.pageNum, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([page, rects]) => ({ page, rects }));
  }

  toRedactionRects(): Array<{ pageIndex: number; rect: [number, number, number, number] }> {
    return this.drawnRects().map(r => ({
      pageIndex: r.pageNum - 1,
      rect: r.rect,
    }));
  }
}