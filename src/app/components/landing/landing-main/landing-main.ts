import { Component } from '@angular/core';
import { LandingFooterComponent } from '../shared/landing-footer/landing-footer';
import { LandingHeaderComponent } from '../shared/landing-header/landing-header';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, LandingHeaderComponent, LandingFooterComponent],
  templateUrl: './landing-main.html',
  styleUrl: './landing-main.scss',
})
export class LandingComponent {
}