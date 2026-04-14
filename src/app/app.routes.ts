import { Routes } from '@angular/router';
import { HomeComponent } from './components/home/home';
import { FaqComponent } from './components/faq/faq';
import { LandingComponent } from './components/landing/landing-main/landing-main';
import { LandingFreeComponent } from './components/landing/landing-free/landing-free';
import { LandingOfflineComponent } from './components/landing/landing-offline/landing-offline';
import { LandingPermanentComponent } from './components/landing/landing-permanent/landing-permanent';

export const routes: Routes = [
  // App Pages
  { path: 'workspace', component: HomeComponent },
  { path: 'faq', component: FaqComponent },

  // Landing Pages
  { path: 'redact-pdf-free', component: LandingFreeComponent },
  { path: 'offline-pdf-redaction', component: LandingOfflineComponent },
  { path: 'permanent-pdf-redaction', component: LandingPermanentComponent },

  { path: '', component: LandingComponent, pathMatch: 'full' },
];
