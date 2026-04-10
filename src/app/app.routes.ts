import { Routes } from '@angular/router';
import { HomeComponent } from './components/home/home';
import { FaqComponent } from './components/faq/faq';
import { LandingComponent } from './components/landing/landing';

export const routes: Routes = [
  { path: '', component: LandingComponent },
  { path: 'workspace', component: HomeComponent },
  { path: 'faq', component: FaqComponent }
];
