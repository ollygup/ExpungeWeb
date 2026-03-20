import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { customLogger } from '../utils/custom-logger';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes)
  ]
};

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
 
  try {
    await navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
    });
    customLogger.log('[SW] Service worker registered successfully.');
  } catch (err) {
    customLogger.warn('[SW] Registration failed:', err);
  }
}
 