import { Component } from '@angular/core';
import { LandingFooterComponent } from '../shared/landing-footer/landing-footer';
import { LandingHeaderComponent } from '../shared/landing-header/landing-header';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [LandingHeaderComponent, LandingFooterComponent],
  templateUrl: './landing-main.html',
  styleUrl: './landing-main.scss',
})
export class LandingComponent {
}