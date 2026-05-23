// Bake the animated SVG scene into a seamless PNG loop the viewer can blit.
// Run: node tools/bake-bg.js   (re-run whenever bg-scene.js changes)

import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSvg, geometry } from './bg-scene.js';

const FRAMES = 48;
const FPS = 12;

// Bake render scale. The browser viewer fits its canvas vertically to the
// window (~2160px tall on a 4K monitor) while the natural canvas is only 828
// CSS pixels tall — a 2.6× CSS up-scale. Baking the SVG at 3× the natural
// pixel grid gives the canvas a sharp source image to downsample from (3× >
// the worst-case 2.6× display blow-up), so masonry seams + cartoon outlines
// stay crisp at 4K instead of going soft.
//
// `src/main.js` must keep its canvas backing at the SAME multiplier so the
// rendered sprites match this density. If you change RENDER_SCALE, also bump
// `RENDER_SCALE` in main.js (see canvas init there).
const RENDER_SCALE = 3;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'assets', 'bg');
fs.mkdirSync(outDir, { recursive: true });

const { CW, CH } = geometry();
const PW = CW * RENDER_SCALE, PH = CH * RENDER_SCALE;
console.log(
  `Baking ${FRAMES} frames @ ${PW}x${PH} (${RENDER_SCALE}× of ${CW}x${CH}, ${FPS}fps, ${(FRAMES / FPS).toFixed(1)}s loop)`
);

let bytes = 0;
for (let f = 0; f < FRAMES; f++) {
  const svg = buildSvg(f, FRAMES);
  const r = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: RENDER_SCALE },
    background: '#070d0b',
    shapeRendering: 2, // geometricPrecision — keeps the ink outlines crisp at 3×
  });
  const png = r.render().asPng();
  const file = path.join(outDir, `frame_${String(f).padStart(2, '0')}.png`);
  fs.writeFileSync(file, png);
  bytes += png.length;
  process.stdout.write(`\r  frame ${f + 1}/${FRAMES}  (${(bytes / 1024).toFixed(0)} KB)`);
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify({ frames: FRAMES, fps: FPS, w: CW, h: CH, renderScale: RENDER_SCALE, pw: PW, ph: PH }, null, 2)
);
console.log(`\nDone -> assets/bg/  (${(bytes / 1024 / 1024).toFixed(2)} MB total)`);
