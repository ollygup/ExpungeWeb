  'use strict';

  // ── VERSION ──────────────────────────────────────────────────
  const VERSION    = '1.1.9';
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
    // '/assets/opencv/opencv.js',
    '/assets/ort/ort-wasm-simd-threaded.wasm',
    '/assets/ort/ort-wasm-simd-threaded.jsep.wasm',
    '/assets/ort/ort-wasm-simd-threaded.jspi.wasm',
    '/assets/ort/ort-wasm-simd-threaded.asyncify.wasm',

    '/assets/ort/ort-wasm-simd-threaded.mjs',
    '/assets/ort/ort-wasm-simd-threaded.jsep.mjs',
    '/assets/ort/ort-wasm-simd-threaded.jspi.mjs',
    '/assets/ort/ort-wasm-simd-threaded.asyncify.mjs',

  
    '/assets/paddle/det.onnx',
    '/assets/paddle/rec.onnx',
  ];
  // ── Install ──────────────────────────────────────────────────
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then((cache) => cache.addAll(PRECACHE_ASSETS))
    );
  });

  // ── Activate ─────────────────────────────────────────────────
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((cacheNames) => {
          const deletePromises = cacheNames
            .filter((name) => name.startsWith('expunge-') && name !== CACHE_NAME)
            .map((oldCache) => caches.delete(oldCache));
          return Promise.all(deletePromises);
        })
        .then(() => self.clients.claim())
    );
  });

  // ── Fetch ─────────────────────────────────────────────────────
  self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(request));
      return;
    }

    event.respondWith(cacheFirst(request));
  });

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
      const fallback = await caches.match('/index.html');
      return fallback || new Response('Offline', { status: 503 });
    }
  }

  // ── Message Handler ───────────────────────────────────────────
  self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
      self.skipWaiting();
    }
  });