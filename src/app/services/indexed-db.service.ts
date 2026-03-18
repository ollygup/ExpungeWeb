import { Injectable } from '@angular/core';

const DB_NAME = 'expunge-db';
const DB_VERSION = 1;
const STORE = 'documents';

export interface StoredDocument {
    id: 'current';
    filename: string;
    originalBytes: Uint8Array;   // Never overwritten after initial upload
    currentBytes: Uint8Array;   // Updated after each redaction operation
    uploadedAt: number;
    modifiedAt: number;
}

@Injectable({ providedIn: 'root' })
export class IndexedDbService {
    private db: IDBDatabase | null = null;

    // ── Init ──────────────────────────────────────────────────────
    async open(): Promise<void> {
        if (this.db) return;
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);

            req.onupgradeneeded = (e) => {
                const db = (e.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };

            req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
            req.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
        });
    }

    // ── Save (initial upload) ─────────────────────────────────────
    // Persists both originalBytes and currentBytes as the same initial payload.
    // originalBytes is NEVER overwritten by subsequent calls — it is the source
    // of truth for the "revert to original" feature.
    async saveDocument(filename: string, bytes: Uint8Array): Promise<void> {
        await this.open();
        const doc: StoredDocument = {
            id: 'current',
            filename,
            originalBytes: bytes.slice(), // defensive copy
            currentBytes: bytes.slice(),
            uploadedAt: Date.now(),
            modifiedAt: Date.now(),
        };
        await this.put(doc);
    }

    // ── Update current bytes (after redaction / annotation) ───────
    // Only currentBytes and modifiedAt are updated; originalBytes stays intact.
    async updateCurrentBytes(bytes: Uint8Array): Promise<void> {
        await this.open();
        const existing = await this.load();
        if (!existing) return;

        await this.put({
            ...existing,
            currentBytes: bytes.slice(), // defensive copy
            modifiedAt: Date.now(),
        });
    }

    // ── Revert: restore currentBytes to originalBytes ─────────────
    async revertToOriginal(): Promise<Uint8Array | null> {
        await this.open();
        const existing = await this.load();
        if (!existing) return null;

        const reverted: StoredDocument = {
            ...existing,
            currentBytes: existing.originalBytes.slice(),
            modifiedAt: Date.now(),
        };
        await this.put(reverted);
        return reverted.currentBytes;
    }

    // ── Load existing document ────────────────────────────────────
    async load(): Promise<StoredDocument | null> {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get('current');
            req.onsuccess = (e) => resolve((e.target as IDBRequest<StoredDocument>).result ?? null);
            req.onerror = (e) => reject((e.target as IDBRequest).error);
        });
    }

    // ── Clear all stored documents ────────────────────────────────
    async clear(): Promise<void> {
        await this.open();
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).clear();
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject((e.target as IDBRequest).error);
        });
    }

    // ── Internal put ──────────────────────────────────────────────
    private put(doc: StoredDocument): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction(STORE, 'readwrite');
            const req = tx.objectStore(STORE).put(doc);
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject((e.target as IDBRequest).error);
        });
    }
}