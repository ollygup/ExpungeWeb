import { Component, signal } from '@angular/core';
import { HeaderComponent } from '../../shared/header/header';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-faq',
  imports: [HeaderComponent, RouterLink],
  templateUrl: './faq.html',
  styleUrl: './faq.scss',
})
export class FaqComponent {
  readonly activeTab = signal<Tab>('casual');

  setTab(tab: Tab): void { this.activeTab.set(tab); }

  toggleItem(items: FaqItem[], index: number): void {
    items[index].open = !items[index].open;
  }

  readonly casualFaqs: FaqItem[] = [
    {
      q: 'Is my document safe?',
      a: 'Your file never leaves your device. Everything happens inside your browser — no uploads, no servers, no one on the other end reading your stuff. Not even us (there is no us, there is only you).',
    },
    {
      q: 'Do I need an account?',
      a: 'Nope. No account, no email, no "sign up to continue". Just open the page and go.',
    },
    {
      q: 'Why is my PDF still here when I come back?',
      a: 'We save a copy in your browser\'s local storage so you can pick up where you left off. It never goes anywhere else, and other websites can\'t access it either — only you can, and only on this device.',
    },
    {
      q: 'Does it work without internet?',
      a: 'After your first visit, yes. Feel free to go airplane mode — the app doesn\'t need the internet to run. It is made for this exact purpose so you can modify your sensitive documents in peace.',
    },
    {
      q: 'What does "redact" actually mean?',
      a: 'It permanently removes the text from the document — not just paints a black box over it. The words are gone. If you select the redacted area and nothing shows up when you paste it, you are good to go.',
    },
  ];

  readonly nerdFaqs: FaqItem[] = [
    {
      q: 'How is this private & secure?',
      a: 'There is no backend, no server, no database, no cookies, no tracking, no analytics. The app is a pure static site: HTML, CSS, JavaScript, and a WASM binary. Everything runs inside your browser using WebAssembly (MuPDF) and Web Workers. This project is also open source btw.',
    },
    {
      q: 'Why can I use this offline after the first visit?',
      a: 'A Service Worker acts as a middleware proxy between your browser and the network — it intercepts all outgoing requests before they hit the network. On first load the SW isn\'t installed yet, so that initial visit still needs the network. Once registered, every subsequent request gets intercepted by the SW first. It fires off the actual network request, and when the response comes back, it sends the data to the browser and caches a copy locally — HTML, JS bundles, the WASM binary, fonts, the lot. From then on, those requests never reach the network at all, they\'re served straight from the cache.',
    },
    {
      q: 'Isn\'t WASM heavy and resource intensive — won\'t it freeze the page?',
      a: 'WASM is heavy, yes. So instead of running it on the main thread and freezing your UI, it runs inside a Web Worker — which uses a completely separate thread. Your website is effectively multithreading.',
    },
    {
      q: 'Why does my PDF stay on the page even after I close and reopen it?',
      a: 'IndexedDB. Both the original and the working copy of your PDF are stored as raw bytes in a local IDB store scoped to this origin. Only this site can access it, it never leaves your device, and it survives browser restarts. Lets you pick up where you left off without re-uploading — and without us ever seeing the file. You can inspect it yourself in DevTools → Application → IndexedDB. You\'ll also notice a separate "keyval" store there — that one belongs to Scribe OCR, which caches its Tesseract language model locally so it doesn\'t have to re-download it every time you use OCR.',
    },
    {
      q: 'If the page is cached, how do you push updates?',
      a: 'The Service Worker is versioned. When you load the page, the browser fetches the SW script and compares it against the installed version. If anything changed, the new SW installs in the background, re-runs the cache logic, and takes over. Only the app files are replaced — your PDFs and imported fonts in IndexedDB are never touched.',
    },
    {
      q: 'How does redaction actually work?',
      a: 'For normal text, it uses text-based searching directly against the PDF content streams — MuPDF (compiled to WASM, running in a Web Worker) finds the matching text spans and removes those operators from the stream entirely. For images, it uses PaddleOCR (ONNX, running in a Web Worker via ONNX Runtime Web) to detect text within the image and redact the region. This split is intentional for performance, since OCR can be significantly slower and isn\'t needed for standard text. Which results in a true redaction — not a visual overlay, not a black box on top. The content is gone from the file structure. Try selecting or copy-pasting the redacted area yourself, nothing there? Good, that\'s the point :) Works on most standard PDFs (Word, Google Docs, LibreOffice exports). Heavily encoded or scanned-only PDFs may vary though.',
    },
  ];

}
