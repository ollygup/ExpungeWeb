import { Injectable, signal, computed } from '@angular/core';

export interface PageHighlight {
    pageNum: number;
    rect: [number, number, number, number]; // PDF-space coords (points, bottom-left origin)
    type: 'text' | 'ocr';
    globalIndex: number; // flat index across all highlights, for focus tracking
}

export interface FocusedHighlight {
    type: 'text' | 'ocr';
    globalIndex: number;
}

@Injectable({ providedIn: 'root' })
export class HighlightService {

    private _highlights = signal<PageHighlight[]>([]);
    private _focused = signal<FocusedHighlight | null>(null);
    private _activePage = signal<number>(1);

    readonly highlights = this._highlights.asReadonly();
    readonly focused = this._focused.asReadonly();
    readonly activePage = this._activePage.asReadonly();

    /** Highlights on the currently viewed page only. */
    readonly pageHighlights = computed(() => {
        const page = this._activePage();
        return this._highlights().filter(h => h.pageNum === page);
    });

    // ── Setters ────────────────────────────────────────────────────────────────

    setHighlights(highlights: PageHighlight[]): void {
        this._highlights.set(highlights);
        this._focused.set(null);
    }

    setFocused(focus: FocusedHighlight | null): void {
        this._focused.set(focus);
    }

    setActivePage(page: number): void {
        this._activePage.set(page);
    }

    clear(): void {
        this._highlights.set([]);
        this._focused.set(null);
    }

    /** Returns true if the given highlight is currently focused. */
    isFocused(h: PageHighlight): boolean {
        const f = this._focused();
        return f !== null && f.type === h.type && f.globalIndex === h.globalIndex;
    }
}