import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes, RenderMode, ServerRoute } from '@angular/ssr';
import { appConfig } from './app.config';

const serverRoutes: ServerRoute[] = [
  { path: '',    renderMode: RenderMode.Prerender },
  { path: 'redact-pdf-free', renderMode: RenderMode.Prerender },
  { path: 'offline-pdf-redaction', renderMode: RenderMode.Prerender },
  { path: 'permanent-pdf-redaction', renderMode: RenderMode.Prerender },

  { path: 'faq', renderMode: RenderMode.Prerender },
  { path: 'workspace', renderMode: RenderMode.Client },
  { path: '**', renderMode: RenderMode.Client }
];

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes))
  ]
};

export const config = mergeApplicationConfig(appConfig, serverConfig);