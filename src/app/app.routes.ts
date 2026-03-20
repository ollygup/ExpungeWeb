import { Routes } from '@angular/router';
import { HomeComponent } from './components/home/home';
import { FaqComponent } from './components/faq/faq';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'faq', component: FaqComponent }
];
