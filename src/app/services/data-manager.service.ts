import { Injectable, inject, signal } from '@angular/core';
import { IndexedDbService } from './indexed-db.service';
import { PdfService } from './pdf.service';

export interface DocumentSummary {
    filename: string;
    originalSize: number;
    currentSize: number;
    uploadedAt: number;
    modifiedAt: number;
}

@Injectable({ providedIn: 'root' })
export class DataManagerService {
    private readonly indexedDbService = inject(IndexedDbService);
    private readonly pdfService = inject(PdfService);

    readonly document = signal<DocumentSummary | null>(null);
    readonly loading = signal(false);
    readonly error = signal<string | null>(null);

    // ── Refresh all storage layers ────────────────────────────────
    async refresh(): Promise<void> {
        this.loading.set(true);
        this.error.set(null);
        try {
            const doc = await this.indexedDbService.load();
            this.document.set(
                doc
                    ? {
                        filename: doc.filename,
                        originalSize: doc.originalBytes.byteLength,
                        currentSize: doc.currentBytes.byteLength,
                        uploadedAt: doc.uploadedAt,
                        modifiedAt: doc.modifiedAt,
                    }
                    : null
            );
        } catch (e) {
            this.error.set('Failed to read storage.');
            console.error('[DataManagerService] refresh error:', e);
        } finally {
            this.loading.set(false);
        }
    }

    // ── Clear document ────────────────────────────────────────────
    async clearDocument(): Promise<void> {
        await this.indexedDbService.clear();
        this.document.set(null);
        this.pdfService.clear();
    }

    // ── Revert to original bytes ──────────────────────────────────
    async revertToOriginal(): Promise<void> {
        await this.pdfService.revertToOriginal();
        await this.refresh();
    }

    // ── Formatting helpers ────────────────────────────────────────
    formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        if (bytes < 1_024) return `${bytes} B`;
        if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
        return `${(bytes / 1_048_576).toFixed(2)} MB`;
    }

    formatDate(timestamp: number): string {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(timestamp));
    }
}