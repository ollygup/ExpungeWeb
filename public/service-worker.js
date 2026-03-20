'use strict';

// ── VERSION ──────────────────────────────────────────────────
// Bump this string on every production build to invalidate caches.
// A build script (or manually) should replace this before deploy.
const VERSION    = '1.0.1';
const CACHE_NAME = `expunge-v${VERSION}`;

// ── PRECACHE ASSETS  ──────────────────────────────────────────
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/pdf.worker.min.mjs',
  '/assets/mupdf/mupdf.js',
  '/assets/mupdf/mupdf-wasm.js',
  '/assets/mupdf/mupdf-wasm.wasm',
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log(`[SW ${VERSION}] Installing…`);

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => {
        console.log(`[SW ${VERSION}] Pre-cache complete.`);
        // Do NOT call skipWaiting() here — let the app decide via postMessage.
        // This prevents jarring mid-session updates.
      })
      .catch((err) => {
        console.warn(`[SW ${VERSION}] Pre-cache failed (non-fatal):`, err);
      })
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log(`[SW ${VERSION}] Activating — removing stale caches…`);

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        const deletePromises = cacheNames
          .filter((name) => name.startsWith('expunge-') && name !== CACHE_NAME)
          .map((oldCache) => {
            console.log(`[SW ${VERSION}] Deleting old cache: ${oldCache}`);
            return caches.delete(oldCache);
          });
        return Promise.all(deletePromises);
      })
      .then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ───────────────────────────────────────────
// Strategy by request type:
//   • Navigation (HTML) → Network-first with cache fallback
//   • Same-origin static assets → Cache-first with network fallback
//   • Cross-origin / APIs → Network only
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignore non-GET and non-http(s) requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // Cross-origin: network only (fonts, CDN assets, APIs)
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(request));
});

// ── Cache-first strategy ──────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ── Network-first strategy ────────────────────────────────────
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Fallback to cached index.html for SPA navigation
    const fallback = await caches.match('/index.html');
    return fallback || new Response('Offline', { status: 503 });
  }
}

// ── Message Handler ───────────────────────────────────────────
// Receives { type: 'SKIP_WAITING' } from SwUpdateService.activateUpdate()
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log(`[SW ${VERSION}] Skip waiting — activating new version.`);
    self.skipWaiting();
  }
});