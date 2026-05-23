import { BOTS } from './registry.js';
import { createLiveMatch } from './match.js';
import { draw, arenaPixelSize, legendData } from './renderer.js';
import { whenBackgroundReady } from './background.js';
import { CONFIG, TPS } from './config.js';
import { CARDS } from './cards.js';
import { crownsFor } from './state.js';
import { audio, processEvents } from './audio.js';

const TILE = 22;
// Internal render multiplier for the arena canvas. The .wrap is CSS-scaled to
// fill the browser height, so on a 4K monitor (2160 vertical) the canvas's
// 828-px natural height is blown up ~2.6×; left at native that's a blurry up-
// sample. Backing the canvas at 3× the natural pixel grid (and ctx.scale-ing
// the renderer to draw in natural coords) gives the browser a sharp source to
// downsample from. MUST match `RENDER_SCALE` in `tools/bake-bg.js` so the
// baked background frames map 1:1 onto the backing buffer.
const RENDER_SCALE = 3;
const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

(function sizeCanvas() {
  const { w, h } = arenaPixelSize({ config: CONFIG }, TILE);
  // Backing buffer at RENDER_SCALE × natural; CSS box stays at natural size
  // so the existing flex layout + transform-fit code is unchanged.
  cv.width = w * RENDER_SCALE;
  cv.height = h * RENDER_SCALE;
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  // Pre-apply the scale once. No code path calls ctx.setTransform/
  // resetTransform; every drawing routine uses save/restore around its own
  // transforms, so this base scale persists across every requestAnimationFrame
  // frame and the renderer can keep drawing in "natural" (CSS-pixel) coords.
  ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
})();

// Uniformly scale the whole layout (canvas + side panels) to fit the browser
// height without distortion. Horizontal position stays centered via the body's
// flex layout combined with `transform-origin: top center` on `.wrap`.
(function setupFitToHeight() {
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  const fit = () => {
    wrap.style.transform = 'none';
    const naturalH = wrap.offsetHeight;
    if (!naturalH) return;
    const s = window.innerHeight / naturalH;
    wrap.style.transform = `scale(${s})`;
  };
  window.addEventListener('resize', fit);
  fit();
})();

const names = Object.keys(BOTS);
for (const sel of [$('bot0'), $('bot1')]) {
  sel.innerHTML = names.map((n) => `<option>${n}</option>`).join('');
}
$('bot0').value = names[0];
$('bot1').value = names[0];

// Legend
$('legend').innerHTML = legendData()
  .map((d) => `<div class="lg"><b>${d.label}</b> ${d.name} <span style="margin-left:auto">${d.cost}⚡ ${d.kind === 'spell' ? 'spell' : d.shape}</span></div>`)
  .join('');

let match = null;
let running = false;
let acc = 0;
let last = 0;
// Stays false until the user first hits Play. While false the arena background
// is pinned to frame 0 so the page loads on a still "pre-match" image instead
// of mid-animation.
let hasStarted = false;
// Cursor into match.state.events used by the audio engine to know which
// events it has already turned into SFX. Reset every new match.
let sfxCursor = 0;
// Which player the local viewer "roots for" — drives win/loss music at end.
// We pick P0 by default (bottom half is the human's traditional side).
const PERSPECTIVE = 0;
let startSfxFired = false;

function newMatch() {
  const raw = parseInt($('seed').value, 10);
  // -1 is a sticky "roll me a random seed every match" mode; the field is left
  // as-is so subsequent restarts/bot-changes keep rerolling. Use the 🎲 button
  // instead if you want the rolled seed materialised into the input.
  const seed = raw === -1 || !Number.isFinite(raw)
    ? Math.floor(Math.random() * 1_000_000_000)
    : raw;
  match = createLiveMatch(BOTS[$('bot0').value], BOTS[$('bot1').value], seed);
  running = false;
  acc = 0;
  sfxCursor = 0;
  startSfxFired = false;
  $('play').textContent = '▶ Play';
  $('winner').textContent = '';
  const wb = $('winBanner');
  wb.classList.remove('show', 'p0', 'p1', 'draw');
  $('winBannerText').textContent = '';
  $('winBannerSub').textContent = '';
  $('name0').textContent = 'P0 ' + $('bot0').value;
  $('name1').textContent = 'P1 ' + $('bot1').value;
  $('feed').innerHTML = '';
  render();
}

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pips(el, elixir) {
  let html = '';
  for (let i = 0; i < CONFIG.maxElixir; i++) {
    const f = Math.max(0, Math.min(1, elixir - i));
    html += `<div class="pip"><i style="width:${f * 100}%"></i></div>`;
  }
  el.innerHTML = html;
}

function towerBoard(el, st, owner) {
  const ts = st.towers.filter((t) => t.owner === owner);
  const ordered = ['left', 'center', 'right'].map((s) =>
    ts.find((t) => (t.kind === 'king' ? 'center' : t.side) === s)
  );
  el.innerHTML = ordered
    .map((t) => {
      const k = t.kind === 'king' ? ' k' : '';
      const cls = t.alive ? ` a${owner}` : ' dead';
      return `<div class="tw${k}${cls}" title="${t.side} ${t.kind}: ${Math.round(t.hp)}"></div>`;
    })
    .join('');
}

function cardChip(name, next) {
  return `<div class="card ${next ? 'next' : ''}">${name}<br><span class="c">${CARDS[name].cost}⚡</span></div>`;
}

const lane = (st, x) => (x < st.config.arena.width / 2 ? 'L' : 'R');

function feedLine(st, ev) {
  const t = `<span class="fmut">${String(Math.round(ev.t)).padStart(3)}s</span>`;
  const oc = ev.owner === 0 ? 'f0' : 'f1';
  if (ev.type === 'play')
    return `<div>${t} <span class="${oc}">P${ev.owner} ▸ ${ev.card}</span> <span class="fmut">${lane(st, ev.x)} ${ev.cost}⚡</span></div>`;
  if (ev.type === 'spell')
    return `<div>${t} <span class="${oc}">P${ev.owner} ✦ ${ev.card}</span> <span class="fmut">${lane(st, ev.x)} · ${ev.hits} hit</span></div>`;
  if (ev.type === 'towerDestroyed')
    return `<div>${t} <span class="fx">✖ P${ev.owner} ${ev.side} ${ev.kind}</span> <span class="fmut">→ P${ev.by}</span></div>`;
  if (ev.type === 'buildingDestroyed')
    return `<div>${t} <span class="${oc}">✖ P${ev.owner} ${ev.card}</span> <span class="fmut">→ P${ev.by}</span></div>`;
  if (ev.type === 'buildingExpired')
    return `<div>${t} <span class="${oc}">⌛ P${ev.owner} ${ev.card}</span> <span class="fmut">lifetime ended</span></div>`;
  if (ev.type === 'kingActivated')
    return `<div>${t} <span class="${oc}">P${ev.owner} King awake</span> <span class="fmut">${ev.cause}</span></div>`;
  if (ev.type === 'end')
    return `<div>${t} <span class="fx">▣ ${ev.winner === 'draw' ? 'DRAW' : 'P' + ev.winner + ' wins'}</span> <span class="fmut">${ev.reason}</span></div>`;
  return '';
}

function updateFeed(st) {
  const evs = st.events.filter((e) => e.type !== 'playFailed');
  $('feed').innerHTML = evs.slice(-60).reverse().map((e) => feedLine(st, e)).join('');
}

function updateHud() {
  const st = match.state;
  const remaining =
    st.phase === 'overtime' ? st.overtimeEnd - st.time : CONFIG.regulationTime - st.time;
  $('clock').textContent = fmtClock(remaining);
  const ph = $('phase');
  const mult = st.elixirMult || 1;
  ph.textContent =
    st.phase === 'overtime'
      ? 'OVERTIME — ×3 elixir'
      : st.phase === 'ended'
      ? 'match ended'
      : mult >= 2
      ? 'regulation — ×2 elixir'
      : 'regulation';
  ph.className = 'phase' + (st.phase === 'overtime' || mult >= 2 ? ' ot' : '');

  for (const pid of [0, 1]) {
    const p = st.players[pid];
    pips($('pips' + pid), p.elixir);
    $('hand' + pid).innerHTML =
      p.hand.map((c) => cardChip(c, false)).join('') + cardChip(p.cycle[0], true);
    towerBoard($('tw' + pid), st, pid);
    $('cr' + pid).textContent = crownsFor(st, pid);
  }
  updateFeed(st);

  if (st.ended) {
    const w = st.winner;
    $('winner').innerHTML =
      w === 'draw'
        ? '<b>DRAW</b>'
        : `<b style="color:${w === 0 ? 'var(--p0)' : 'var(--p1)'}">P${w} (${$('bot' + w).value}) wins</b><br><span class="fmut">${st.result.reason}</span>`;

    const wb = $('winBanner');
    wb.classList.remove('p0', 'p1', 'draw');
    if (w === 'draw') {
      $('winBannerText').textContent = 'DRAW';
      wb.classList.add('draw');
    } else {
      const botName = $('bot' + w).value;
      $('winBannerText').textContent = `${botName} WINS`;
      wb.classList.add(w === 0 ? 'p0' : 'p1');
    }
    $('winBannerSub').textContent = st.result && st.result.reason ? st.result.reason : '';
    wb.classList.add('show');
  }
}

function render() {
  const opts = { showTargets: $('tgt').checked };
  if (!hasStarted) opts.bgFrame = 0;
  draw(ctx, match.state, TILE, opts);
  updateHud();
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (!running || !match || match.state.ended) {
    if (match && match.state.ended && running) {
      running = false;
      $('play').textContent = '▶ Play';
      // Flush any pending end-of-match events through the SFX tap.
      sfxCursor = processEvents(match.state, sfxCursor, PERSPECTIVE);
      audio.fadeOutBgm(true);
      render();
    }
    return;
  }
  if (!last) last = ts;
  const dtReal = Math.min(0.25, (ts - last) / 1000);
  last = ts;
  acc += dtReal * TPS * parseFloat($('speed').value);
  let budget = 1200;
  while (acc >= 1 && budget-- > 0 && !match.state.ended) {
    match.stepOnce();
    acc -= 1;
  }
  sfxCursor = processEvents(match.state, sfxCursor, PERSPECTIVE);
  audio.tickLaunches(match.state);
  audio.tickHits(match.state);
  audio.tickDeaths(match.state);
  audio.tickFootsteps(match.state);
  render();
}

$('play').onclick = async () => {
  if (!match || match.state.ended) newMatch();
  running = !running;
  last = 0;
  if (running) hasStarted = true;
  $('play').textContent = running ? '⏸ Pause' : '▶ Play';
  if (running) {
    await audio.startBgm();
    if (!startSfxFired) {
      audio.matchStart();
      startSfxFired = true;
    }
  } else {
    audio.fadeOutBgm(true);
  }
};
$('step').onclick = () => {
  if (!match || match.state.ended) newMatch();
  running = false;
  $('play').textContent = '▶ Play';
  match.stepOnce();
  // Stepping is also a user gesture — fine to play SFX without starting BGM.
  audio.ensureReady().then(() => {
    sfxCursor = processEvents(match.state, sfxCursor, PERSPECTIVE);
    audio.tickLaunches(match.state);
    audio.tickHits(match.state);
    audio.tickDeaths(match.state);
    audio.tickFootsteps(match.state);
  });
  render();
};
$('restart').onclick = () => {
  audio.fadeOutBgm(true);
  newMatch();
};
$('tgt').onchange = render;
for (const id of ['bot0', 'bot1', 'seed']) $(id).onchange = newMatch;
$('randSeed').onclick = () => {
  // Bounded to a 32-bit-ish range so the input field stays readable.
  $('seed').value = Math.floor(Math.random() * 1_000_000_000);
  audio.fadeOutBgm(true);
  newMatch();
};

// ── audio controls ────────────────────────────────────────────────────────
const muteBtn = $('mute');
const musicVol = $('musicVol');
const sfxVol = $('sfxVol');
if (muteBtn) {
  let muted = false;
  muteBtn.onclick = () => {
    muted = !muted;
    audio.setMuted(muted);
    muteBtn.textContent = muted ? '🔇 muted' : '🔊 sound';
  };
}
if (musicVol) {
  audio.musicVolume = parseFloat(musicVol.value);
  musicVol.oninput = () => audio.setMusicVolume(parseFloat(musicVol.value));
}
if (sfxVol) {
  audio.sfxVolume = parseFloat(sfxVol.value);
  sfxVol.oninput = () => audio.setSfxVolume(parseFloat(sfxVol.value));
}

window.CR = {
  get match() { return match; },
  render,
  step(n = 1) { for (let i = 0; i < n && !match.state.ended; i++) match.stepOnce(); render(); },
};

newMatch();
// Repaint once frame 0 of the baked background has decoded so the first
// visible frame is the pre-game still instead of the fallback fill colour.
whenBackgroundReady().then(() => { if (!hasStarted) render(); });
requestAnimationFrame(frame);
