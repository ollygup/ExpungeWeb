import { Component, inject, signal, effect, Type } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LayoutComponent } from '../layout/layout';
import { MatIconModule } from '@angular/material/icon';
import { PdfViewerComponent } from '../pdf-viewer/pdf-viewer';
import { FEATURES_REGISTRY } from './features-registry';
import { SwUpdateService } from '../../services/sw-update.service';

@Component({
  selector: 'app-home',
  imports: [CommonModule, MatIconModule, LayoutComponent, PdfViewerComponent],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomeComponent {
  readonly swUpdateService = inject(SwUpdateService);
  readonly tools = FEATURES_REGISTRY;
  readonly activeTool = signal(FEATURES_REGISTRY[0].id);
}