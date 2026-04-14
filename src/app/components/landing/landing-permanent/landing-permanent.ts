import { Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { LandingFooterComponent } from "../shared/landing-footer/landing-footer";
import { LandingHeaderComponent } from "../shared/landing-header/landing-header";
import { JsonLdService } from '../../../services/json-ld.service';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-landing-permanent',
  standalone: true,
  imports: [RouterLink, LandingFooterComponent, LandingHeaderComponent],
  templateUrl: './landing-permanent.html',
  styleUrl: './landing-permanent.scss',
})
export class LandingPermanentComponent {
  private readonly titleSvc = inject(Title);
  private readonly meta     = inject(Meta);
  private jsonLd = inject(JsonLdService);
  
  constructor() {
    this.titleSvc.setTitle('Permanently Remove Text From a PDF — True Redaction | Expunge');

    this.meta.updateTag({ name: 'description',
      content: 'Drawing a black box over text is not redaction — the words are still in the file. Expunge removes content from the PDF data itself. Copy-paste and text extractors find nothing.' });

    this.meta.updateTag({ name: 'keywords',
      content: 'permanently remove text from pdf, true pdf redaction, permanent pdf redaction, pdf redaction vs covering text, how to permanently redact pdf' });

    this.meta.updateTag({ property: 'og:title',
      content: 'Permanently Remove Text From a PDF | Expunge' });

    this.meta.updateTag({ property: 'og:description',
      content: 'Most tools just draw a black box. The text is still there. Expunge removes it from the file itself.' });

    this.meta.updateTag({ property: 'og:type', content: 'website' });

    this.meta.updateTag({ name: 'robots', content: 'index, follow' });

    this.meta.updateTag({ name: 'canonical', content: 'https://expunge.vercel.app/permanent-pdf-redaction' });

    this.jsonLd.set({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: this.titleSvc.getTitle(),
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Why does copy-paste still reveal text after redaction?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "If you can copy text from a supposedly redacted area, the tool only drew a shape on top of the text without removing it from the file. The text is still present in the PDF data. True redaction modifies the content of the file itself, not just its appearance."
          }
        },
        {
          "@type": "Question",
          "name": "What is the difference between covering text and redacting it?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Covering text with a black rectangle is a visual change — the shape is an annotation layer drawn over the page, but the underlying characters remain in the file. Redaction means removing those characters from the file's data. After proper redaction, the text is not present in the file."
          }
        },
        {
          "@type": "Question",
          "name": "Can redacted text be recovered from a PDF?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "If the redaction only covered the text visually, yes — removing or disabling the annotation layer reveals the original text. If the redaction removed the content from the file's data stream (as Expunge does), the original text is not present in the file and cannot be extracted."
          }
        },
        {
          "@type": "Question",
          "name": "How do I know if a PDF was properly redacted?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The simplest test: try to copy the text from a redacted area and paste it into a text editor. If text appears, the redaction was only visual. Another test: open the PDF in a text extraction tool and search for the redacted term. Properly redacted content will not appear."
          }
        }
      ]
    });
  }
}