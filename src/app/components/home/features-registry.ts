import { Type } from '@angular/core';
import { RedactionComponent } from '../features/redaction/redaction';
import { DataManagerComponent } from '../data-manager/data-manager';
export interface ToolEntry {
  id: string;
  label: string;
  icon: string;
  component: Type<unknown>;
  comingSoon?: boolean;
  dividerAfter?: boolean;
}

export const FEATURES_REGISTRY: ToolEntry[] = [
  {
    id: 'redaction',
    label: 'Redaction',
    icon: 'auto_fix_high',
    component: RedactionComponent,
  },
  {
    id: 'data-manager',
    label: 'Data Management',
    icon: 'storage',
    component: DataManagerComponent,
  },
  {
    id: 'text-editor',
    label: 'Text editing',
    icon: 'edit',
    component: RedactionComponent,
    comingSoon: true,
  },
  {
    id: 'watermark',
    label: 'Watermark',
    icon: 'watermark',
    component: RedactionComponent,
    comingSoon: true,
  },
  // add more here, nothing else changes
];