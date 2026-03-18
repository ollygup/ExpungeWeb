import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

type Theme = 'dark' | 'light';
const STORAGE_KEY = 'expunge-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private _isDark = new BehaviorSubject<boolean>(true);
  readonly isDark$ = this._isDark.asObservable();

  // Called once from AppComponent.ngOnInit
  init(): void {
    const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;

    // Respect saved preference; fall back to OS preference; default to dark
    const isDark = saved
      ? saved === 'dark'
      : !window.matchMedia('(prefers-color-scheme: light)').matches;

    this.apply(isDark ? 'dark' : 'light');

    // Watch OS preference changes (only if user hasn't saved a preference)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        this.apply(e.matches ? 'dark' : 'light');
      }
    });
  }

  toggle(): void {
    const next: Theme = this._isDark.value ? 'light' : 'dark';
    this.apply(next);
    localStorage.setItem(STORAGE_KEY, next);
  }

  private apply(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
    this._isDark.next(theme === 'dark');
  }
}