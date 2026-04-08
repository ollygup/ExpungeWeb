import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

// Directories — copy entire folder recursively
const dirs = [];

// Individual files — dest is the folder, filename is preserved from src
const files = [
    { src: 'node_modules/mupdf/dist/mupdf-wasm.js', dest: 'public/assets/mupdf' },
    { src: 'node_modules/mupdf/dist/mupdf-wasm.wasm', dest: 'public/assets/mupdf' },
    { src: 'node_modules/mupdf/dist/mupdf.js', dest: 'public/assets/mupdf' },
];

// ORT WASM files — glob all ort-wasm*.wasm from onnxruntime-web/dist/
const ortSrcDir = 'node_modules/onnxruntime-web/dist';
const ortDest = 'public/assets/ort';
try {
    const ortFiles = readdirSync(ortSrcDir).filter( f => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs')) );
    for (const f of ortFiles) {
        files.push({ src: join(ortSrcDir, f), dest: ortDest });
    }
} catch {
    console.warn('onnxruntime-web not found — skipping ORT WASM copy');
}

for (const { src, dest } of dirs) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`Copied dir  ${src} → ${dest}`);
}

for (const { src, dest } of files) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, `${dest}/${basename(src)}`);
    console.log(`Copied file ${src} → ${dest}/${basename(src)}`);

    if (basename(src) === 'opencv.js') {
        const filePath = `${dest}/${basename(src)}`;
        let content = readFileSync(filePath, 'utf8');
        content = content.replace(/root\.cv\s*=\s*factory\(\);/g, 'self.cv = factory();');
        writeFileSync(filePath, content, 'utf8');
        console.log(`Patched OpenCV.js for module worker at ${filePath}`);
    }
}