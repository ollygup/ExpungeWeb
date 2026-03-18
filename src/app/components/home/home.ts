import { CommonModule } from '@angular/common';
import { Component, signal } from '@angular/core';
import { LayoutComponent } from '../layout/layout';
import { MatIconModule } from '@angular/material/icon';
import { PdfViewerComponent } from '../pdf-viewer/pdf-viewer';
import { FEATURES_REGISTRY } from './features-registry';

@Component({
  selector: 'app-home',
  imports: [CommonModule, MatIconModule, LayoutComponent, PdfViewerComponent],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class HomeComponent {
  readonly tools = FEATURES_REGISTRY;
  readonly activeTool = signal(FEATURES_REGISTRY[0].id);
}