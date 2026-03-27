import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
    { src: 'node_modules/@techstark/opencv-js/dist/opencv.js', dest: 'public/assets/opencv' },
];

for (const { src, dest } of dirs) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`Copied dir  ${src} → ${dest}`);
}

for (const { src, dest } of files) {
    mkdirSync(dest, { recursive: true });
    cpSync(src, `${dest}/${basename(src)}`);
    console.log(`Copied file ${src} → ${dest}/${basename(src)}`);

    // Patch OpenCV.js for module worker compatibility
    if (basename(src) === 'opencv.js') {
        const filePath = `${dest}/${basename(src)}`;
        let content = readFileSync(filePath, 'utf8');
        content = content.replace(/root\.cv\s*=\s*factory\(\);/g, 'self.cv = factory();');
        writeFileSync(filePath, content, 'utf8');
        console.log(`Patched OpenCV.js for module worker at ${filePath}`);
    }
}