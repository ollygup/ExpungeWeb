import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig, registerServiceWorker } from './app/app.config';
import { App } from './app/app';
import { enableProdMode } from '@angular/core';
import { environment } from './environments/environment';
import { customLogger } from './utils/custom-logger';

if (environment.production) {
  enableProdMode();
}

bootstrapApplication(App, appConfig)
  .then(() => registerServiceWorker())
  .catch((err) => customLogger.error(err));