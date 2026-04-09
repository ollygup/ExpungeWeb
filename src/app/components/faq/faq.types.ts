export type Tab = 'casual' | 'nerd';

export interface FaqItem {
  q: string;
  a: string;
  open?: boolean;
}