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

// Why updating vercel.json header requires bumping
- on first load all the static files are cached, including wasm, which comes from the network
which includes CSP headers and so on. On next load, all will be served from cached
which uses the same old header. To apply vercel.json changes, a SW bump is required


// PRODUCTION
add NG_APP_ENV to your env, value = production





// SCRIPT TO CONVERT PADDLEPADDLE into ONNX
# Cell 1 — Install
!pip install paddlepaddle paddlex -q

# Cell 2 — Download PP-OCRv5 mobile models (paddle3.0 format)
!wget -q https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_infer.tar
!tar xf PP-OCRv5_mobile_det_infer.tar

!wget -q https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_infer.tar
!tar xf PP-OCRv5_mobile_rec_infer.tar

# Cell 3 — Install paddle2onnx plugin via PaddleX, then convert
!paddlex --install paddle2onnx

!paddlex --paddle2onnx --paddle_model_dir ./PP-OCRv5_mobile_det_infer --onnx_model_dir ./det_onnx
!paddlex --paddle2onnx --paddle_model_dir ./PP-OCRv5_mobile_rec_infer --onnx_model_dir ./rec_onnx

# Cell 4 — Verify outputs
import os
print("det:", os.listdir("./det_onnx"))
print("rec:", os.listdir("./rec_onnx"))

