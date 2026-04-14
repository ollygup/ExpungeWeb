// json-ld.service.ts
import { inject, Injectable } from '@angular/core';
import { DOCUMENT } from '@angular/common';

@Injectable({ providedIn: 'root' })
export class JsonLdService {
  private readonly doc = inject(DOCUMENT);
  private readonly SCRIPT_ID = 'page-ld-json';

  set(schema: Record<string, unknown> | Record<string, unknown>[]): void {
    this.remove();
    const script = this.doc.createElement('script');
    script.id = this.SCRIPT_ID;
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(schema);
    this.doc.head.appendChild(script);
  }

  remove(): void {
    this.doc.getElementById(this.SCRIPT_ID)?.remove();
  }
}