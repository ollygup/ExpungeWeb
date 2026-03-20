import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class SwUpdateService implements OnDestroy {

  private readonly _updateAvailable$ = new BehaviorSubject<boolean>(false);
  readonly updateAvailable$ = this._updateAvailable$.asObservable();

  private waitingWorker: ServiceWorker | null = null;

  constructor() {
    if (!('serviceWorker' in navigator)) return;
    this.init();
  }

  private async init(): Promise<void> {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;

      // A new SW is already waiting (e.g. page was refreshed after install)
      if (registration.waiting) {
        this.waitingWorker = registration.waiting;
        this._updateAvailable$.next(true);
      }

      // A new SW finishes installing and moves to waiting
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            this.waitingWorker = newWorker;
            this._updateAvailable$.next(true);
          }
        });
      });

      // After skipWaiting, the new SW takes control — reload to apply
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });

    } catch (err) {
      console.warn('[SwUpdateService] Init failed:', err);
    }
  }

  activateUpdate(): void {
    if (!this.waitingWorker) return;
    this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }

  dismissUpdate(): void {
    this._updateAvailable$.next(false);
  }

  ngOnDestroy(): void {
    this._updateAvailable$.complete();
  }
}