// Plays the baked arena background as a seamless image-sequence loop, on real
// wall-clock time (independent of sim speed / pause). The frames are produced
// by `node tools/bake-bg.js`; keep FRAMES/FPS in sync with that script.

const FRAMES = 48;
const FPS = 12;
const FALLBACK = '#0b1410';

let imgs = null;
let ready = 0;

// Lazy init so this module is safe to import in Node contexts (the bake tool's
// import chain). Images are only created the first time drawBackground runs,
// which is necessarily in the browser.
function init() {
  imgs = [];
  for (let i = 0; i < FRAMES; i++) {
    const im = new Image();
    im.onload = () => { ready++; };
    im.src = `./assets/bg/frame_${String(i).padStart(2, '0')}.png`;
    imgs.push(im);
  }
}

// Blit the current background frame to fill the whole canvas. Falls back to a
// flat colour until the first frames have decoded (no blank flash).
export function drawBackground(ctx, cw, ch) {
  if (!imgs) init();
  const idx = Math.floor(performance.now() / (1000 / FPS)) % FRAMES;
  const im = imgs[idx];
  if (ready > 0 && im && im.complete && im.naturalWidth) {
    ctx.drawImage(im, 0, 0, cw, ch);
  } else {
    ctx.fillStyle = FALLBACK;
    ctx.fillRect(0, 0, cw, ch);
  }
}
