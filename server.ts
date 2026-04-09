import { bootstrapApplication, type BootstrapContext } from '@angular/platform-browser';
import { App } from './src/app/app';
import { config } from './src/app/app.config.server';

export default (context: BootstrapContext) =>
    bootstrapApplication(App, config, context);