// copy-assets.mjs

For WASM, instead of letting angular.json handle the copying to the public 
directory, it is done via scripts/copy-assets.mjs. This is due to a limitation 
of ng serve, which ignores angular.json asset copying.


// When to bump service-worker.js version

- Updating vercel.json headers
- Updating/replacing any stable-named files: WASM binaries, worker scripts 
  (e.g. tessworker.js, mupdf.js), or any asset not processed by Angular's 
  build pipeline

Note: Angular-compiled JS and CSS bundles use output hashing (main.abc123.js),
so their filenames change automatically on every build — the SW will treat them 
as new files and fetch them fresh without needing a bump. The bump is needed for
files whose names never change between deployments.

// Why this matters

Everything requested over the network gets captured by the SW's runtime caching
— on first request, the response is stored in cache and served from there on 
every subsequent request. If a stable-named file changes but the SW version 
isn't bumped, users will keep receiving the old cached version instead of 
fetching the updated one from the network.



// PRODUCTION
add NG_APP_ENV to your env, value = production

