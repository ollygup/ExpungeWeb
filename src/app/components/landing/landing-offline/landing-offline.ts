import { Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { LandingFooterComponent } from '../shared/landing-footer/landing-footer';
import { LandingHeaderComponent } from "../shared/landing-header/landing-header";
import { JsonLdService } from '../../../services/json-ld.service';

@Component({
  selector: 'app-landing-offline',
  standalone: true,
  imports: [LandingFooterComponent, LandingHeaderComponent],
  templateUrl: './landing-offline.html',
  styleUrl: './landing-offline.scss',
})
export class LandingOfflineComponent {
  private readonly titleSvc = inject(Title);
  private readonly meta = inject(Meta);
  private jsonLd = inject(JsonLdService);

  constructor() {
    this.titleSvc.setTitle('Offline PDF Redaction — Files Never Leave Your Browser | Expunge');

    this.meta.updateTag({
      name: 'description',
      content: '100% client-side PDF redaction. Expunge processes documents entirely in your browser with no server, no cloud, and zero data exposure. GDPR and HIPAA-friendly.'
    });

    this.meta.updateTag({
      name: 'keywords',
      content: 'offline pdf redaction, redact pdf without uploading, local pdf redaction, private pdf redaction, pdf redaction no cloud, GDPR pdf redaction, HIPAA pdf redaction'
    });

    this.meta.updateTag({
      property: 'og:title',
      content: 'Offline PDF Redaction — Zero Data Exposure | Expunge'
    });

    this.meta.updateTag({
      property: 'og:description',
      content: 'Your files never leave your device. Expunge runs entirely in your browser — no server, no cloud, no risk.'
    });

    this.meta.updateTag({ property: 'og:type', content: 'website' });

    this.meta.updateTag({ name: 'robots', content: 'index, follow' });

    this.meta.updateTag({ name: 'canonical', content: 'https://expunge.vercel.app/offline-pdf-redaction' });

    this.jsonLd.set({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: this.titleSvc.getTitle(),
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Does Expunge upload my PDF to a server?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Expunge is a fully client-side Progressive Web App. Your PDF is loaded into browser memory and processed there entirely. No file data is transmitted over the network at any point."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use Expunge offline without internet?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. After the initial page load, Expunge caches all required assets including the MuPDF WASM binary and OCR models via its service worker. Subsequent sessions work without any internet connection."
          }
        },
        {
          "@type": "Question",
          "name": "Is Expunge suitable for GDPR compliance workflows?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Expunge processes data entirely on your device with no data transfers to third parties. This makes it compatible with GDPR data minimisation and storage limitation principles. Always confirm suitability with your Data Protection Officer for specific use cases."
          }
        },
        {
          "@type": "Question",
          "name": "How can I verify that Expunge is not sending my files anywhere?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Expunge is fully open source. You can review the complete source code on GitHub, inspect network traffic in your browser's DevTools while using the app, or self-host the application on your own infrastructure."
          }
        }
      ]
    });
  }
}