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
  effect,
} from '@angular/core';
import { AsyncPipe, NgComponentOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PdfService } from '../../services/pdf.service';
import { ThemeService } from '../../services/theme.service';
import { ToolEntry } from '../home/features-registry';
import { DataManagerService } from '../../services/data-manager.service';
import { Subscription } from 'rxjs';
import { DrawService } from '../../services/draw.service';

type MobileTab = 'document' | 'tools';

@Component({
  selector: 'app-layout',
  imports: [AsyncPipe, NgComponentOutlet, MatIconModule, MatTooltipModule, RouterLink],
  templateUrl: './layout.html',
  styleUrl: './layout.scss',
})
export class LayoutComponent implements OnDestroy {
  // ── Injections ───────────────────────────────────────────────
  readonly pdfService = inject(PdfService);
  readonly themeService = inject(ThemeService);
  readonly dataManagerService = inject(DataManagerService);
  readonly drawService = inject(DrawService);

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

  readonly activeToolComponent = signal<Type<unknown> | null>(null);

  // ── Observables ──────────────────────────────────────────────
  readonly filename = this.pdfService.filename$;
  readonly pdfLoaded = this.pdfService.pdfLoaded$;
  readonly isDark = this.themeService.isDark$;

  // ── State ────────────────────────────────────────────────────
  readonly activeTab = signal<MobileTab>('document');
  readonly isDraggingOver = signal(false);
  readonly overflowOpen = signal(false);

  // ── Subscriptions ───────────────────────────────────────────────
  private subs = new Subscription();

  // ── Resize ───────────────────────────────────────────────────
  private isResizing = false;
  private resizeStartX = 0;
  private startWidth = 0;
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  private readonly mouseMoveRef = (e: MouseEvent) => this.doResize(e);
  private readonly mouseUpRef = () => this.stopResize();
  private readonly clickOutsideRef = (e: MouseEvent) => this.onClickOutside(e);

  constructor() {
    effect(() => {
      const entry = this.activeToolEntry();
      if (!entry) return;
      entry.component().then(comp => this.activeToolComponent.set(comp));
    });

    this.subs.add(
      this.drawService.changeMobileTab$.subscribe(() => {
        this.setTab('tools');})
    );

    document.addEventListener('mousemove', this.mouseMoveRef);
    document.addEventListener('mouseup', this.mouseUpRef);
    document.addEventListener('click', this.clickOutsideRef);
    document.addEventListener('dragover', this.docDragOverRef);
    document.addEventListener('drop', this.docDropRef);

  }

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.mouseMoveRef);
    document.removeEventListener('mouseup', this.mouseUpRef);
    document.removeEventListener('click', this.clickOutsideRef);
    document.removeEventListener('dragover', this.docDragOverRef);
    document.removeEventListener('drop', this.docDropRef);
  }

  // ── Overflow menu ────────────────────────────────────────────
  toggleOverflow(e: MouseEvent): void {
    e.stopPropagation(); // prevent clickOutside from immediately closing
    this.overflowOpen.update(v => !v);
  }

  closeOverflow(): void {
    this.overflowOpen.set(false);
  }

  private onClickOutside(e: MouseEvent): void {
    if (!this.overflowOpen()) return;
    const wrap = this.hostRef.nativeElement.querySelector('.overflow-wrap');
    if (wrap && !wrap.contains(e.target as Node)) {
      this.overflowOpen.set(false);
    }
  }

  // ── Mobile tabs ──────────────────────────────────────────────
  setTab(tab: MobileTab): void { this.activeTab.set(tab); }

  // ── File upload ──────────────────────────────────────────────
  triggerUpload(): void { this.fileInput().nativeElement.click(); }

  async onFileChange(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file?.type === 'application/pdf') {
      await this.pdfService.loadFromFile(file);
      await this.dataManagerService.refresh();
    }
    (event.target as HTMLInputElement).value = '';
  }




  // ── Drag & drop ──────────────────────────────────────────────
  private readonly docDragOverRef = (e: DragEvent) => e.preventDefault();
  private readonly docDropRef = (e: DragEvent) => e.preventDefault();

  onDragEnter(e: DragEvent): void {
    e.preventDefault();
    this.isDraggingOver.set(true);
  }

  onDragOver(e: DragEvent): void { e.preventDefault(); }

  onDragLeave(e: DragEvent): void {
    // Only hide overlay when cursor leaves the host element entirely,
    // not when crossing between child elements inside it.
    const related = e.relatedTarget as Node | null;
    if (!related || !this.hostRef.nativeElement.contains(related)) {
      this.isDraggingOver.set(false);
    }
  }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.isDraggingOver.set(false);
    const file = e.dataTransfer?.files[0];
    if (file?.type === 'application/pdf') {
      await this.pdfService.loadFromFile(file);
      await this.dataManagerService.refresh();
    }
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