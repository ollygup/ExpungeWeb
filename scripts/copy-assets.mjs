import { cpSync, mkdirSync } from 'fs';
import { basename } from 'path';

// Directories — copy entire folder recursively
const dirs = [
    { src: 'node_modules/scribe.js-ocr', dest: 'public/assets/scribe' },
];

// Individual files — dest is the folder, filename is preserved from src
const files = [
    { src: 'node_modules/mupdf/dist/mupdf-wasm.js', dest: 'public/assets/mupdf' },
    { src: 'node_modules/mupdf/dist/mupdf-wasm.wasm', dest: 'public/assets/mupdf' },
    { src: 'node_modules/mupdf/dist/mupdf.js', dest: 'public/assets/mupdf' },
];

for (const { src, dest } of dirs) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    logger.log(`Copied dir  ${src} → ${dest}`);
}

for (const { src, dest } of files) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, `${dest}/${basename(src)}`);
    logger.log(`Copied file ${src} → ${dest}/${basename(src)}`);
}