import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  ElementRef,
  Type,
  OnDestroy,
} from '@angular/core';
import { AsyncPipe, NgComponentOutlet } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PdfService } from '../../services/pdf.service';
import { ThemeService } from '../../services/theme.service';
import { ToolEntry } from '../home/features-registry';

type MobileTab = 'document' | 'tools';

@Component({
  selector: 'app-layout',
  imports: [AsyncPipe, NgComponentOutlet, MatIconModule, MatTooltipModule],
  templateUrl: './layout.html',
  styleUrl: './layout.scss',
})
export class LayoutComponent implements OnDestroy {
  // ── Injections ───────────────────────────────────────────────
  readonly pdfService = inject(PdfService);
  readonly themeService = inject(ThemeService);

  // ── Inputs / Outputs ─────────────────────────────────────────
  readonly tools = input<ToolEntry[]>([]);
  readonly activeTool = input<string>('');
  readonly toolChange = output<string>();

  // ── Template refs ────────────────────────────────────────────
  readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  // ── Computed ─────────────────────────────────────────────────
  readonly activeToolEntry = computed(() =>
    this.tools().find(t => t.id === this.activeTool())
  );

  readonly activeToolComponent = computed<Type<unknown> | null>(() =>
    this.activeToolEntry()?.component ?? null
  );

  // ── Observables (still fine to use with AsyncPipe) ───────────
  readonly filename = this.pdfService.filename$;
  readonly pdfLoaded = this.pdfService.pdfLoaded$;
  readonly isDark = this.themeService.isDark$;

  // ── State ────────────────────────────────────────────────────
  readonly activeTab = signal<MobileTab>('document');
  readonly isDraggingOver = signal(false);

  // ── Resize ───────────────────────────────────────────────────
  private isResizing = false;
  private resizeStartX = 0;
  private startWidth = 0;
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  private readonly mouseMoveRef = (e: MouseEvent) => this.doResize(e);
  private readonly mouseUpRef = () => this.stopResize();

  constructor() {
    document.addEventListener('mousemove', this.mouseMoveRef);
    document.addEventListener('mouseup', this.mouseUpRef);
  }

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.mouseMoveRef);
    document.removeEventListener('mouseup', this.mouseUpRef);
  }

  // ── Mobile tabs ──────────────────────────────────────────────
  setTab(tab: MobileTab): void { this.activeTab.set(tab); }

  // ── File upload ──────────────────────────────────────────────
  triggerUpload(): void { this.fileInput().nativeElement.click(); }

  async onFileChange(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file?.type === 'application/pdf') await this.pdfService.loadFromFile(file);
    (event.target as HTMLInputElement).value = '';
  }

  // ── Drag & drop ──────────────────────────────────────────────
  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.isDraggingOver.set(true);
  }

  onDragLeave(): void { this.isDraggingOver.set(false); }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.isDraggingOver.set(false);
    const file = e.dataTransfer?.files[0];
    if (file?.type === 'application/pdf') await this.pdfService.loadFromFile(file);
  }

  // ── Panel resize ─────────────────────────────────────────────
  startResize(e: MouseEvent): void {
    this.isResizing = true;
    this.resizeStartX = e.clientX;
    const left = document.querySelector('.panel-doc') as HTMLElement;
    this.startWidth = left?.offsetWidth ?? 0;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  private doResize(e: MouseEvent): void {
    if (!this.isResizing) return;
    const container = document.querySelector('.layout-main') as HTMLElement;
    if (!container) return;
    const delta = e.clientX - this.resizeStartX;
    const total = container.offsetWidth;
    const newW = Math.min(Math.max(this.startWidth + delta, total * 0.28), total * 0.72);
    this.hostRef.nativeElement.style.setProperty('--doc-panel-w', `${(newW / total) * 100}%`);
  }

  private stopResize(): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
}