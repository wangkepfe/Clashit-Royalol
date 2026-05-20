// Bake the animated SVG scene into a seamless PNG loop the viewer can blit.
// Run: node tools/bake-bg.js   (re-run whenever bg-scene.js changes)

import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, geometry } from './bg-scene.js';

const FRAMES = 48;
const FPS = 12;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets', 'bg');
fs.mkdirSync(outDir, { recursive: true });

const { CW, CH } = geometry();
console.log(`Baking ${FRAMES} frames @ ${CW}x${CH} (${FPS}fps, ${(FRAMES / FPS).toFixed(1)}s loop)`);

let bytes = 0;
for (let f = 0; f < FRAMES; f++) {
  const svg = buildSvg(f, FRAMES);
  const r = new Resvg(svg, {
    fitTo: { mode: 'original' },
    background: '#070d0b',
  });
  const png = r.render().asPng();
  const file = path.join(outDir, `frame_${String(f).padStart(2, '0')}.png`);
  fs.writeFileSync(file, png);
  bytes += png.length;
  process.stdout.write(`\r  frame ${f + 1}/${FRAMES}  (${(bytes / 1024).toFixed(0)} KB)`);
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({ frames: FRAMES, fps: FPS, w: CW, h: CH }, null, 2)
);
console.log(`\nDone -> assets/bg/  (${(bytes / 1024 / 1024).toFixed(2)} MB total)`);
