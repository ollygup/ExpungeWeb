import { Component, computed, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { WatermarkService } from './watermark.service';
import { PdfService } from '../../../services/pdf.service';
import { customLogger } from '../../../../utils/custom-logger';
import type { WatermarkParams } from './watermark.types';

@Component({
  selector: 'app-watermark',
  imports: [MatIconModule, MatSliderModule],
  templateUrl: './watermark.html',
  styleUrl: './watermark.scss',
})
export class WatermarkComponent {
  private readonly svc        = inject(WatermarkService);
  private readonly pdfService = inject(PdfService);

  readonly pdfIsLoaded = computed(() => !!this.pdfService.currentBytes());

  readonly text     = signal('CONFIDENTIAL');
  readonly angleDeg = signal(45);
  readonly density  = signal(3);
  readonly opacity  = signal(0.12);
  readonly fontSize = signal(36);
  readonly colorHex = signal('#7c6cf4');
  readonly applying = signal(false);
  readonly applied  = signal(false);
  readonly error    = signal<string | null>(null);

  readonly densityLabel = computed(() =>
    (['Sparse', 'Light', 'Normal', 'Dense', 'Heavy'] as const)[this.density() - 1]
  );

  onTextInput(e: Event): void {
    this.text.set((e.target as HTMLInputElement).value);
    this.applied.set(false);
  }

  onColorInput(e: Event): void {
    this.colorHex.set((e.target as HTMLInputElement).value);
    this.applied.set(false);
  }

  private hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  async applyWatermark(): Promise<void> {
    if (this.applying()) return;
    this.applying.set(true);
    this.error.set(null);
    this.applied.set(false);
    try {
      const params: WatermarkParams = {
        text:     this.text().trim() || 'CONFIDENTIAL',
        angleDeg: this.angleDeg(),
        density:  this.density(),
        opacity:  this.opacity(),
        fontSize: this.fontSize(),
        color:    this.hexToRgb(this.colorHex()),
      };
      await this.svc.apply(params);
      this.applied.set(true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      customLogger.error('[WatermarkComponent]', e);
    } finally {
      this.applying.set(false);
    }
  }

  downloadWatermarked(): void {
    const bytes = this.pdfService.currentBytes();
    if (!bytes) return;
    const transferable = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([transferable], { type: 'application/pdf' }));
    const a   = Object.assign(document.createElement('a'), { href: url, download: 'watermarked.pdf' });
    a.click();
    URL.revokeObjectURL(url);
  }

  onHexTextInput(e: Event): void {
    const val = (e.target as HTMLInputElement).value;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      this.colorHex.set(val);
      this.applied.set(false);
    }
  }
}