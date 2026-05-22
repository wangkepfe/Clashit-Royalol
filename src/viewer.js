// Character Asset Viewer
// -----------------------------------------------------------------------------
// Standalone tool: opens viewer.html and renders every drawable asset
// (characters, towers, cannon, projectiles, spell effects, death poofs) in
// every relevant view × state combination so each frame of art can be
// inspected without running a full match.
//
// All cells are driven by a single requestAnimationFrame loop. Time advances
// continuously, so animations (gait, breath, attack swings, spawn ring-up,
// hit flash, projectile rotation, poof shards) play forever.
//
// We bypass getAnim() entirely and feed each draw function a freshly-built
// mock `p` object based on (view, face, state, t). This keeps cells fully
// decoupled — none of them share rig state.

import {
  beginFrame,
  drawKnight,
  drawGiant,
  drawArcher, drawArrow,
  drawGoblin,
  drawMinion, drawMinionSpit,
  drawMusketeer, drawMusketBullet,
  drawCannon, drawCannonball,
  drawFireballProjectile, drawFireballImpact,
  drawArrowsProjectile, drawArrowsImpact,
  drawTower,
} from './sprites.js';

// ─────────────────────────────────────────────────────────────────────────────
// Asset registry: how to render each character, including how tall the canvas
// should be so the figure (anchored at the feet) doesn't clip its hat or plume.
//
//   draw      : (ctx, gx, gy, tile, p) → void                — sprite renderer
//   mark      : (id) → void                                  — registers the unit so death-poofs
//                                                              know which rig to shatter
//   feetUp    : tiles above gy occupied by the figure's body+hat (governs
//               canvas height + ground line)
//   feetDown  : tiles below gy (for shadow + foot-plant dust)
//   period    : seconds per attack swing-and-rest loop (idle pause length is
//               picked per-asset so the rest gap feels right)
// ─────────────────────────────────────────────────────────────────────────────
const CHARACTERS = {
  Knight:    { draw: drawKnight,    feetUp: 2.8, feetDown: 0.6, period: 0.85 },
  Giant:     { draw: drawGiant,     feetUp: 3.6, feetDown: 0.6, period: 1.20 },
  Archer:    { draw: drawArcher,    feetUp: 2.6, feetDown: 0.6, period: 0.80 },
  Goblin:    { draw: drawGoblin,    feetUp: 2.2, feetDown: 0.6, period: 0.70 },
  Minion:    { draw: drawMinion,    feetUp: 2.6, feetDown: 0.6, period: 0.65 },
  Musketeer: { draw: drawMusketeer, feetUp: 3.0, feetDown: 0.6, period: 0.90 },
};

// Animation timing constants — must match sprites.js exactly so the mock `p`
// values land in the same 0..1 ranges the sprites were designed against.
const SWING = 0.30;
const FLASH = 0.14;

// All 5 states × 4 views shown in the character grid.
const STATES = ['idle', 'walking', 'attacking', 'spawning', 'hurt'];
const VIEWS = [
  { id: 'sideR', view: 'side',  face: +1, label: 'Side ▶' },
  { id: 'sideL', view: 'side',  face: -1, label: 'Side ◀' },
  { id: 'front', view: 'front', face: +1, label: 'Front' },
  { id: 'back',  view: 'back',  face: +1, label: 'Back' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Build a stub rig (`p`) for a given (view, face, state, t). t is a global
// seconds counter; we never reset per-cell — each cell just samples it.
// ─────────────────────────────────────────────────────────────────────────────
function buildP({ view, face, state, t, owner, period, phase }) {
  let moving = 0, atk = 0, spawnF = 1, flash = 0, lean = 0;
  let hpFrac = 1;
  // Gait advances continuously at ~1.2 cycles/s so the walking pose visibly
  // strides. Idle gait is parked at 0 so the breath bob takes over.
  let gait = 0;

  if (state === 'idle') {
    // pure standing — let breath/phase wobble do the work
  } else if (state === 'walking') {
    moving = 1;
    gait = (t * 1.2) % 1;
    lean = view === 'side' ? face * 0.18 : 0;
  } else if (state === 'attacking') {
    // ACTIVE phase: atk runs 1 → 0 over SWING.
    // REST  phase: atk = 0 for (period - SWING) so attack is visibly cyclic.
    const tMod = t % period;
    if (tMod < SWING) atk = 1 - (tMod / SWING);
    else              atk = 0;
    // Continue light gait so the unit doesn't feel frozen between swings.
    gait = (t * 0.4) % 1;
  } else if (state === 'spawning') {
    // 1.0 s spawn-in, then 0.6 s hold at full, then repeat from 0.
    const spawnDur = 1.0;
    const hold = 0.6;
    const cycle = spawnDur + hold;
    const tMod = t % cycle;
    spawnF = Math.min(1, tMod / spawnDur);
  } else if (state === 'hurt') {
    // FLASH pulse every 1.2 s, hp pinned low so HP-driven tint reads.
    const cycle = 1.2;
    const tMod = t % cycle;
    flash = tMod < FLASH ? 1 - (tMod / FLASH) : 0;
    hpFrac = 0.4;
  }

  return {
    owner,
    face,
    view,
    lean,
    gait,
    moving,
    atk,
    spawnF,
    flash,
    hpFrac,
    t,
    phase: phase || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page DOM wiring
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const assetSel = $('asset');
for (const name of Object.keys(CHARACTERS)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  assetSel.appendChild(opt);
}
assetSel.value = 'Musketeer';

const ui = {
  asset: 'Musketeer',
  owner: 0,
  tile: 28,
  bg: 'canvas',
  paused: false,
};
assetSel.onchange = () => { ui.asset = assetSel.value; rebuildCharacterGrid(); };
$('owner').onchange = (e) => { ui.owner = parseInt(e.target.value, 10); };
const tileSlider = $('tile');
const tileVal = $('tileVal');
tileSlider.oninput = () => {
  ui.tile = parseInt(tileSlider.value, 10);
  tileVal.textContent = String(ui.tile);
  rebuildCharacterGrid();
  rebuildTowerStrip();
  rebuildCannonStrip();
  rebuildProjStrip();
};
$('bg').onchange = (e) => { ui.bg = e.target.value; };
$('pause').onclick = (e) => {
  ui.paused = !ui.paused;
  e.target.textContent = ui.paused ? 'Resume' : 'Pause';
};
$('reset').onclick = () => { tBase = perfNow(); };

// ─────────────────────────────────────────────────────────────────────────────
// Background fill helper shared by every cell.
// ─────────────────────────────────────────────────────────────────────────────
function paintBg(ctx, w, h) {
  if (ui.bg === 'canvas') {
    ctx.fillStyle = '#22344a';
    ctx.fillRect(0, 0, w, h);
  } else if (ui.bg === 'dark') {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);
  } else if (ui.bg === 'white') {
    ctx.fillStyle = '#dadada';
    ctx.fillRect(0, 0, w, h);
  } else { // checker
    const sz = 10;
    for (let y = 0; y < h; y += sz) {
      for (let x = 0; x < w; x += sz) {
        ctx.fillStyle = (((x / sz) ^ (y / sz)) & 1) ? '#1f2c3b' : '#16202b';
        ctx.fillRect(x, y, sz, sz);
      }
    }
  }
}

function perfNow() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}
let tBase = perfNow();
let lastT = tBase;
let nowT = tBase;

// ─────────────────────────────────────────────────────────────────────────────
// CHARACTER GRID  (5 states × 4 views)
// ─────────────────────────────────────────────────────────────────────────────
const characterCells = []; // [{view, face, state, canvas, ctx, w, h, gx, gy}]

function rebuildCharacterGrid() {
  const root = $('characterGrid');
  root.innerHTML = '';
  characterCells.length = 0;

  const def = CHARACTERS[ui.asset];
  if (!def) return;

  const tile = ui.tile;
  const cellW = Math.round(tile * 6.0);
  const cellH = Math.round(tile * (def.feetUp + def.feetDown + 0.6));

  // Header row
  root.appendChild(elem('div', 'head', ''));
  for (const v of VIEWS) root.appendChild(elem('div', 'head', v.label));

  // One row per state.
  for (const state of STATES) {
    root.appendChild(elem('div', 'row-label', state));
    for (const v of VIEWS) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const cv = document.createElement('canvas');
      cv.width = cellW; cv.height = cellH;
      cell.appendChild(cv);
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = v.label;
      cell.appendChild(tag);
      root.appendChild(cell);
      characterCells.push({
        view: v.view, face: v.face, state, canvas: cv, ctx: cv.getContext('2d'),
        w: cellW, h: cellH,
        gx: cellW / 2,
        gy: cellH - tile * def.feetDown,
        // Each cell gets a different random phase so the breath/idle wobble
        // looks distinct (not 20 figures synced like a kickline).
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  // Update CSS grid columns so cells match the canvas count.
  root.style.gridTemplateColumns = `90px repeat(${VIEWS.length}, 1fr)`;
}

function paintCharacterCells() {
  const def = CHARACTERS[ui.asset];
  if (!def) return;
  for (const c of characterCells) {
    paintBg(c.ctx, c.w, c.h);
    const p = buildP({
      view: c.view, face: c.face, state: c.state,
      t: nowT, owner: ui.owner,
      period: def.period,
      phase: c.phase,
    });
    def.draw(c.ctx, c.gx, c.gy, ui.tile, p);
    // Subtle ground line for visual reference.
    c.ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    c.ctx.beginPath();
    c.ctx.moveTo(0, c.gy);
    c.ctx.lineTo(c.w, c.gy);
    c.ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOWER STRIP  (archer alive, archer dead, king dormant, king awake, ×2 owners)
// ─────────────────────────────────────────────────────────────────────────────
const towerCells = []; // [{ctx, cv, w, h, label, build}]

function rebuildTowerStrip() {
  const root = $('towerStrip');
  root.innerHTML = '';
  towerCells.length = 0;
  const tile = ui.tile;
  const variants = [
    { label: 'Archer alive',   kind: 'archer', alive: true,  hp: 1400, maxHp: 1400 },
    { label: 'Archer damaged', kind: 'archer', alive: true,  hp: 400,  maxHp: 1400 },
    { label: 'Archer dead',    kind: 'archer', alive: false, hp: 0,    maxHp: 1400 },
    { label: 'King dormant',   kind: 'king',   alive: true,  hp: 2400, maxHp: 2400, dormant: true },
    { label: 'King awake',     kind: 'king',   alive: true,  hp: 1500, maxHp: 2400 },
    { label: 'King dead',      kind: 'king',   alive: false, hp: 0,    maxHp: 2400 },
  ];

  // Both owners shown for each variant.
  for (const owner of [0, 1]) {
    for (const v of variants) {
      const cellW = Math.round(tile * 7);
      const cellH = Math.round(tile * 7);
      const cell = document.createElement('div');
      cell.className = 'cell';
      const cv = document.createElement('canvas');
      cv.width = cellW; cv.height = cellH;
      cell.appendChild(cv);
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = `${v.label} (P${owner})`;
      cell.appendChild(label);
      root.appendChild(cell);
      // Tower objects need a stable id (used as a per-tower random seed).
      const id = (owner * 100) + variants.indexOf(v);
      const t = { id, kind: v.kind, owner, alive: v.alive, hp: v.hp, maxHp: v.maxHp,
                  x: 0, y: 0, side: 'left', dormant: !!v.dormant };
      towerCells.push({ cv, ctx: cv.getContext('2d'), w: cellW, h: cellH,
                        cx: cellW / 2, cy: cellH / 2, t });
    }
  }
}

function paintTowerCells() {
  for (const c of towerCells) {
    paintBg(c.ctx, c.w, c.h);
    drawTower(c.ctx, c.cx, c.cy, ui.tile, c.t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANNON STRIP — defensive building, multi-state aim + lifetime warning.
// drawCannon owns its own per-unit rig (cannonRig in sprites.js) keyed by u.id,
// so we create stable mock unit objects with deterministic ids.
// ─────────────────────────────────────────────────────────────────────────────
const cannonCells = []; // [{cv, ctx, w, h, u, target, period}]

function rebuildCannonStrip() {
  const root = $('cannonStrip');
  root.innerHTML = '';
  cannonCells.length = 0;
  const tile = ui.tile;
  const cellW = Math.round(tile * 8);
  const cellH = Math.round(tile * 8);

  // Build a few states. Each cell drives a different mock unit so they don't
  // share rig state in the cannonRig map.
  let nextId = 9000;
  const variants = [
    { label: 'Idle (full HP)', hp: 824, lifetime: 30, attacking: false },
    { label: 'Firing',         hp: 824, lifetime: 30, attacking: true  },
    { label: 'Damaged',        hp: 200, lifetime: 18, attacking: true  },
    { label: 'Almost expired', hp: 824, lifetime: 4.5,attacking: false },
    { label: 'Damaged + expiring', hp: 120, lifetime: 3, attacking: true },
  ];

  for (const owner of [0, 1]) {
    for (const v of variants) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const cv = document.createElement('canvas');
      cv.width = cellW; cv.height = cellH;
      cell.appendChild(cv);
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = `${v.label} (P${owner})`;
      cell.appendChild(label);
      root.appendChild(cell);
      const u = {
        id: nextId++,
        owner,
        card: 'Cannon',
        x: 0, y: 0,
        hp: v.hp, maxHp: 824,
        cooldown: 0,
        deployTimer: 0,
        _building: true,
        lifetime: v.lifetime,
        maxLifetime: 30,
        aimAngle: 0,
      };
      cannonCells.push({
        cv, ctx: cv.getContext('2d'), w: cellW, h: cellH,
        gx: cellW / 2, gy: cellH - tile * 2.0,
        u,
        attacking: v.attacking,
        // Each cell varies cooldown over time to keep aiming/firing visibly active.
        nextFire: 0,
      });
    }
  }
}

function paintCannonCells(dtReal) {
  for (const c of cannonCells) {
    paintBg(c.ctx, c.w, c.h);
    // Drift target around in a slow circle so the barrel tracks visibly.
    const ang = nowT * 0.6 + (c.u.id * 0.31);
    const targetSc = {
      x: c.gx + Math.cos(ang) * ui.tile * 3.5,
      y: c.gy - ui.tile * 1.0 + Math.sin(ang) * ui.tile * 1.5,
    };
    // Rising-edge attack: nudge u.cooldown up periodically so the rig detects
    // a "fire" and runs the recoil + muzzle flash animation. drawCannon
    // expects u.cooldown to grow on hit, then decrements externally; here we
    // emulate by setting cooldown briefly higher.
    if (c.attacking) {
      c.nextFire -= dtReal;
      if (c.nextFire <= 0) {
        c.u.cooldown = 1.0; // any positive bump > lastCd registers as a swing
        c.nextFire = 1.0;   // fire once per second
      } else if (c.u.cooldown > 0) {
        c.u.cooldown = Math.max(0, c.u.cooldown - dtReal);
      }
    }
    drawCannon(c.ctx, c.gx, c.gy, ui.tile, c.u, targetSc, dtReal);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTILES + SPELL EFFECTS strip
// ─────────────────────────────────────────────────────────────────────────────
const projCells = []; // [{cv, ctx, w, h, kind}]

function rebuildProjStrip() {
  const root = $('projStrip');
  root.innerHTML = '';
  projCells.length = 0;
  const tile = ui.tile;
  const cellW = Math.round(tile * 7);
  const cellH = Math.round(tile * 5);
  const entries = [
    { label: 'Arrow (Archer)',       kind: 'arrow' },
    { label: 'Bullet (Musketeer)',   kind: 'bullet' },
    { label: 'Cannonball',           kind: 'cannonball' },
    { label: 'Minion spit',          kind: 'spit' },
    { label: 'Fireball (in flight)', kind: 'fireballProj' },
    { label: 'Fireball impact',      kind: 'fireballHit' },
    { label: 'Arrows (in flight)',   kind: 'arrowsProj' },
    { label: 'Arrows impact',        kind: 'arrowsHit' },
  ];
  for (const e of entries) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const cv = document.createElement('canvas');
    cv.width = cellW; cv.height = cellH;
    cell.appendChild(cv);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = e.label;
    cell.appendChild(label);
    root.appendChild(cell);
    projCells.push({ cv, ctx: cv.getContext('2d'), w: cellW, h: cellH,
                     cx: cellW / 2, cy: cellH / 2, kind: e.kind });
  }
}

function paintProjCells() {
  for (const c of projCells) {
    paintBg(c.ctx, c.w, c.h);
    // Rotate the projectile slowly so the user can see it from any angle.
    const ang = (nowT * 0.6) % (Math.PI * 2);
    const tT = nowT;
    if (c.kind === 'arrow') {
      drawArrow(c.ctx, c.cx, c.cy, ang, ui.tile, { motion: true });
    } else if (c.kind === 'bullet') {
      drawMusketBullet(c.ctx, c.cx, c.cy, ang, ui.tile, {});
    } else if (c.kind === 'cannonball') {
      drawCannonball(c.ctx, c.cx, c.cy, ang, ui.tile, { motion: true });
    } else if (c.kind === 'spit') {
      drawMinionSpit(c.ctx, c.cx, c.cy, ang, ui.tile, {});
    } else if (c.kind === 'fireballProj') {
      drawFireballProjectile(c.ctx, c.cx, c.cy, ang, ui.tile, tT, {});
    } else if (c.kind === 'fireballHit') {
      // Effect lasts ~0.35s. Loop the age 0→1 every 0.8s with rest.
      const cyc = 0.8;
      const tm = nowT % cyc;
      const age = Math.min(1, tm / 0.35);
      drawFireballImpact(c.ctx, c.cx, c.cy, ui.tile, age, 2.5, tT);
    } else if (c.kind === 'arrowsProj') {
      drawArrowsProjectile(c.ctx, c.cx, c.cy, ang, ui.tile, tT, {});
    } else if (c.kind === 'arrowsHit') {
      const cyc = 0.8;
      const tm = nowT % cyc;
      const age = Math.min(1, tm / 0.35);
      drawArrowsImpact(c.ctx, c.cx, c.cy, ui.tile, age, 3.5, tT);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot + main loop
// ─────────────────────────────────────────────────────────────────────────────
function elem(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

rebuildCharacterGrid();
rebuildTowerStrip();
rebuildCannonStrip();
rebuildProjStrip();

function tick() {
  requestAnimationFrame(tick);
  // beginFrame() is called even when paused so the internal _lastNow clock
  // stays sane and we don't get a giant dt when the user resumes.
  beginFrame();
  const now = perfNow();
  let dtReal = Math.min(0.05, now - lastT);
  lastT = now;
  if (ui.paused) dtReal = 0;
  else nowT += dtReal;
  paintCharacterCells();
  paintTowerCells();
  paintCannonCells(dtReal);
  paintProjCells();
}
requestAnimationFrame(tick);
