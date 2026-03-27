import { Type } from '@angular/core';

export interface ToolEntry {
  id: string;
  label: string;
  icon: string;
  component: () => Promise<Type<unknown>>;
  comingSoon?: boolean;
  dividerAfter?: boolean;
}

export const FEATURES_REGISTRY: ToolEntry[] = [
  {
    id: 'redaction',
    label: 'Redaction',
    icon: 'auto_fix_high',
    component: () =>
      import('../features/redaction/redaction').then(m => m.RedactionComponent),
  },
  {
    id: 'data-manager',
    label: 'Data Management',
    icon: 'storage',
    component: () =>
      import('../data-manager/data-manager').then(m => m.DataManagerComponent),
  },
  {
    id: 'watermark',
    label: 'Watermark',
    icon: 'watermark',
    component: () =>
      import('../features/watermark/watermark').then(m => m.WatermarkComponent),
  },
  {
    id: 'text-editor',
    label: 'Text editing',
    icon: 'edit',
    component: () =>
      import('../features/redaction/redaction').then(m => m.RedactionComponent),
    comingSoon: true,
  },
];