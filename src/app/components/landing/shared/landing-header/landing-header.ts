import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-landing-header',
  imports: [RouterLink],
  templateUrl: './landing-header.html',
  styleUrl: './landing-header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingHeaderComponent {
  menuOpen = false;
}
