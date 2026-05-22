import { BOTS } from './registry.js';
import { createLiveMatch } from './match.js';
import { draw, arenaPixelSize, legendData } from './renderer.js';
import { whenBackgroundReady } from './background.js';
import { CONFIG, TPS } from './config.js';
import { CARDS } from './cards.js';
import { crownsFor } from './state.js';

const TILE = 22;
const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

(function sizeCanvas() {
  const { w, h } = arenaPixelSize({ config: CONFIG }, TILE);
  cv.width = w;
  cv.height = h;
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

function newMatch() {
  const seed = parseInt($('seed').value, 10) || 1;
  match = createLiveMatch(BOTS[$('bot0').value], BOTS[$('bot1').value], seed);
  running = false;
  acc = 0;
  $('play').textContent = '▶ Play';
  $('winner').textContent = '';
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
  render();
}

$('play').onclick = () => {
  if (!match || match.state.ended) newMatch();
  running = !running;
  last = 0;
  if (running) hasStarted = true;
  $('play').textContent = running ? '⏸ Pause' : '▶ Play';
};
$('step').onclick = () => {
  if (!match || match.state.ended) newMatch();
  running = false;
  $('play').textContent = '▶ Play';
  match.stepOnce();
  render();
};
$('restart').onclick = newMatch;
$('tgt').onchange = render;
for (const id of ['bot0', 'bot1', 'seed']) $(id).onchange = newMatch;

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
