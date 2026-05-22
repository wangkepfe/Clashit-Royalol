// Plays the baked arena background as a seamless image-sequence loop, on real
// wall-clock time (independent of sim speed / pause). The frames are produced
// by `node tools/bake-bg.js`; keep FRAMES/FPS in sync with that script.

const FRAMES = 48;
const FPS = 12;
const FALLBACK = '#0b1410';

let imgs = null;
let ready = 0;
// Promise that resolves when frame 0 (the "pre-game" still) has decoded so
// callers can wait before the very first paint and avoid a fallback-colour
// flash on the initial page load.
let firstFrameReadyResolve = null;
const firstFrameReady = new Promise((res) => { firstFrameReadyResolve = res; });

// Lazy init so this module is safe to import in Node contexts (the bake tool's
// import chain). Images are only created the first time drawBackground runs,
// which is necessarily in the browser.
function init() {
  imgs = [];
  for (let i = 0; i < FRAMES; i++) {
    const im = new Image();
    im.onload = () => {
      ready++;
      if (i === 0 && firstFrameReadyResolve) firstFrameReadyResolve();
    };
    im.src = `./assets/bg/frame_${String(i).padStart(2, '0')}.png`;
    imgs.push(im);
  }
}

// Resolves once frame 0 has decoded. Triggers lazy image loading on first
// call, mirroring drawBackground so callers can `await` before the first
// paint without having to render once first.
export function whenBackgroundReady() {
  if (!imgs) init();
  return firstFrameReady;
}

// Blit a background frame to fill the whole canvas. When `frameIndex` is
// given that specific frame is drawn (used for the pre-game still on load);
// otherwise the current frame of the wall-clock loop is shown. Falls back
// to a flat colour until images have decoded (no blank flash).
export function drawBackground(ctx, cw, ch, frameIndex) {
  if (!imgs) init();
  const idx = Number.isInteger(frameIndex)
    ? ((frameIndex % FRAMES) + FRAMES) % FRAMES
    : Math.floor(performance.now() / (1000 / FPS)) % FRAMES;
  const im = imgs[idx];
  if (im && im.complete && im.naturalWidth) {
    ctx.drawImage(im, 0, 0, cw, ch);
  } else {
    ctx.fillStyle = FALLBACK;
    ctx.fillRect(0, 0, cw, ch);
  }
}
