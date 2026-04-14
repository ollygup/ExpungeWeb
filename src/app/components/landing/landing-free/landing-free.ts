import { Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { LandingFooterComponent } from '../shared/landing-footer/landing-footer';
import { LandingHeaderComponent } from "../shared/landing-header/landing-header";
import { JsonLdService } from '../../../services/json-ld.service';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-landing-free',
  standalone: true,
  imports: [RouterLink, LandingFooterComponent, LandingHeaderComponent],
  templateUrl: './landing-free.html',
  styleUrl: './landing-free.scss',
})
export class LandingFreeComponent {
  private readonly titleSvc = inject(Title);
  private readonly meta     = inject(Meta);
  private jsonLd = inject(JsonLdService);

  constructor() {
    this.titleSvc.setTitle('Free PDF Redaction Tool — No Account, No Upload | Expunge');

    this.meta.updateTag({ name: 'description',
      content: 'Redact PDFs completely free — no account, no file uploads, no data collection. Permanently remove sensitive text and images directly in your browser with Expunge.' });

    this.meta.updateTag({ name: 'keywords',
      content: 'free pdf redaction, redact pdf online free, free pdf redaction tool, pdf redaction no account, remove text from pdf free' });

    this.meta.updateTag({ property: 'og:title',
      content: 'Free PDF Redaction Tool — No Account Required | Expunge' });

    this.meta.updateTag({ property: 'og:description',
      content: 'Permanently redact PDFs at zero cost. No sign-up, no uploads, no tracking. Your files never leave your browser.' });

    this.meta.updateTag({ property: 'og:type', content: 'website' });

    this.meta.updateTag({ name: 'robots', content: 'index, follow' });

    this.meta.updateTag({ name: 'canonical', content: 'https://expunge.vercel.app/redact-pdf-free' });

    this.jsonLd.set({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: this.titleSvc.getTitle(),
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is Expunge really free to use?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Expunge is completely free. There are no paid tiers, no feature paywalls, and no account required. The full redaction suite — text search, draw-to-redact, and OCR-based redaction — is available at no cost."
          }
        },
        {
          "@type": "Question",
          "name": "Do I need to create an account to redact a PDF for free?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Expunge requires no account, no email, and no login. Open the app and start redacting immediately."
          }
        },
        {
          "@type": "Question",
          "name": "Are free online PDF redaction tools safe?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Many free tools upload your files to a remote server, which creates a privacy risk. Expunge processes everything locally in your browser — files are never transmitted or stored externally."
          }
        },
        {
          "@type": "Question",
          "name": "Does free PDF redaction actually remove the text permanently?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Expunge uses MuPDF compiled to WebAssembly to perform true content-stream redaction. Unlike tools that simply draw a black box over text, Expunge removes the underlying characters from the PDF data, making recovery impossible."
          }
        }
      ]
    });
  }
}