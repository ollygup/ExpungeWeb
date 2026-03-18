import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes)
  ]
};

export async function registerServiceWorker(): Promise<void> {
  if (isDevMode()) return;
  if (!('serviceWorker' in navigator)) return;
 
  try {
    await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
    });
    console.log('[SW] Service worker registered successfully.');
  } catch (err) {
    console.warn('[SW] Registration failed:', err);
  }
}
 