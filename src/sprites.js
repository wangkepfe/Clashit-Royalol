// 2.5D procedural sprite rig. Vertical slice: the Knight is fully animated;
// other cards still use the flat primitives in renderer.js. The "fake 3D" is
// done entirely in code — a ground-anchored figure that rises out of a cast
// shadow, bobs with its gait, and leans/lunges — i.e. a top-down statue lit
// from the upper-left, the Clash-Royale look without any image assets.
//
// All animation is DERIVED here (the engine stores no velocity/anim state):
//   facing/gait  <- frame-to-frame position delta (frame-rate independent)
//   view         <- horizontal vs vertical movement direction (side/front/back)
//   attack       <- rising edge of u.cooldown (engine sets it to hitSpeed on a swing)
//   spawn        <- u.deployTimer (troop is frozen 1.0s on deploy)
//   hit flash    <- per-unit hp delta
//   death poof   <- unit id vanished from state.units (engine sweeps dead units)

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const STRIDE = 0.85;   // world tiles per full leg cycle
const SWING = 0.30;    // seconds of an attack swing animation
const FLASH = 0.14;    // seconds of hit flash

const anim = new Map(); // unit id -> persistent rig state
const poofs = [];       // transient death effects
let _lastNow = 0;

// Call once at the top of every draw(): returns clamped real-time delta (s).
export function beginFrame() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  let dt = _lastNow ? now - _lastNow : 0;
  _lastNow = now;
  if (!(dt > 0)) dt = 0;
  return Math.min(dt, 0.05); // clamp so paused/stepped frames don't jump
}

// Update + fetch the rig state for one unit this frame.
// `target` (optional): the world-space entity (`{x, y}`) this unit is attacking.
// When the unit is stationary (or attacking), the rig faces the target instead
// of its movement direction, so ranged units pivot to aim and melee units don't
// keep facing the wrong way after they stop in front of an enemy.
export function getAnim(u, dt, target) {
  let a = anim.get(u.id);
  if (!a) {
    a = {
      lx: u.x, ly: u.y, face: u.owner === 0 ? 1 : -1, lean: 0,
      gait: Math.random(), moving: 0, atkT: 0, lastCd: u.cooldown,
      flashT: 0, lastHp: u.hp, seen: true,
      t: 0,
      phase: Math.random() * TAU,
    };
    anim.set(u.id, a);
  }
  a.seen = true;
  a.t += dt;

  const dx = u.x - a.lx, dy = u.y - a.ly;
  const moved = Math.hypot(dx, dy);
  a.lx = u.x; a.ly = u.y;

  // Gait advances by distance travelled -> looks right at any sim speed.
  a.gait = (a.gait + moved / STRIDE) % 1;

  // Smoothed "is walking" 0..1 (speed in tiles/s, deploy-frozen = standing).
  const spd = dt > 0 ? moved / dt : 0;
  const targetMv = u.deployTimer > 0 ? 0 : spd > 0.25 ? 1 : 0;
  a.moving = lerp(a.moving, targetMv, clamp01(dt * 12));

  // View pick: which way is the unit facing the camera?
  //   side   = facing mostly horizontally  -> profile, mirrored by face
  //   front  = facing the camera (game dy < 0, i.e. down the screen)
  //   back   = facing away from the camera (game dy > 0, i.e. up the screen)
  // Hysteresis (`* 1.15`) avoids view flicker on diagonal vectors.
  //
  // Priority for the facing vector:
  //   1) movement (when actually walking)
  //   2) attack target (when stationary but has a goal — pivot to aim)
  //   3) keep last-known facing
  let fx = 0, fy = 0;
  if (moved > 0.001) { fx = dx; fy = dy; }
  else if (target && (target.x !== u.x || target.y !== u.y)) {
    fx = target.x - u.x; fy = target.y - u.y;
  }
  if (fx !== 0 || fy !== 0) {
    const afx = Math.abs(fx), afy = Math.abs(fy);
    if (afx > afy * 1.15) {
      a.view = 'side';
      a.face = fx > 0 ? 1 : -1;
    } else if (afy > afx * 1.15) {
      a.view = fy > 0 ? 'back' : 'front';
      a.face = 1;
    }
  }
  if (!a.view) a.view = u.owner === 0 ? 'back' : 'front';

  // Lean only applies to the side profile.
  const leanTarget = a.view === 'side' ? clamp01(a.moving) * a.face * 0.18 : 0;
  a.lean = lerp(a.lean, leanTarget, clamp01(dt * 10));

  // Attack: engine resets cooldown to hitSpeed on a swing -> rising edge.
  if (u.cooldown > a.lastCd + 1e-6) a.atkT = SWING;
  a.lastCd = u.cooldown;
  if (a.atkT > 0) a.atkT = Math.max(0, a.atkT - dt);

  // Hit flash on hp loss.
  if (u.hp < a.lastHp - 0.5) a.flashT = FLASH;
  a.lastHp = u.hp;
  if (a.flashT > 0) a.flashT = Math.max(0, a.flashT - dt);

  const spawnF = u.deployTimer > 0
    ? clamp01(1 - u.deployTimer / 1.0)
    : 1;

  return {
    owner: u.owner,
    face: a.face,
    view: a.view,
    lean: a.lean,
    gait: a.gait,
    moving: clamp01(a.moving),
    atk: a.atkT > 0 ? a.atkT / SWING : 0,
    spawnF,
    flash: a.flashT > 0 ? a.flashT / FLASH : 0,
    hpFrac: clamp01(u.hp / u.maxHp),
    t: a.t,
    phase: a.phase,
  };
}

// Detect units that vanished (died) and turn the last Knight rig into a poof.
// Call once per frame, after the unit loop, then drawDeathPoofs().
export function sweepAnim(state, dt) {
  const alive = new Set();
  for (const u of state.units) alive.add(u.id);

  // ── Cannon rig sweep (separate map from troop anim) ─────────────────────
  // Cannons keep persistent aim/recoil state; when the unit dies (HP=0) or
  // the lifetime expires we emit a rubble + smoke poof and drop the rig.
  for (const [id, ar] of cannonRig) {
    if (alive.has(id) && ar.seen) { ar.seen = false; continue; }
    if (!alive.has(id)) {
      if (ar.wasCannon) {
        // Mixed shards: 4 broken-wood, 4 iron-band fragments, 3 brass bits,
        // ringed by 5 grey smoke puffs that linger longer than the shards.
        const shards = [];
        const N = 11;
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * TAU + (Math.random() - 0.5) * 0.55;
          shards.push({
            ang,
            speed: 0.80 + Math.random() * 0.65,
            rot0: Math.random() * TAU,
            spin: (Math.random() - 0.5) * 14,
            kind: i % 3,  // 0=wood, 1=iron, 2=brass
          });
        }
        const puffs = [];
        for (let i = 0; i < 5; i++) {
          const ang = (i / 5) * TAU + Math.random() * 0.4;
          puffs.push({
            ang,
            speed: 0.45 + Math.random() * 0.30,
            r0: 0.40 + Math.random() * 0.25,
            life: 0.65 + Math.random() * 0.25,
          });
        }
        poofs.push({
          x: ar.lx, y: ar.ly,
          owner: ar.owner, face: 1,
          t: 1,
          dur: 0.62,
          scale: 1.05,
          cannon: true,
          shards,
          puffs,
        });
      }
      cannonRig.delete(id);
    }
  }

  for (const [id, a] of anim) {
    if (alive.has(id) && a.seen) { a.seen = false; continue; }
    if (!alive.has(id)) {
      if (a.wasMusketeer) {
        // Musketeer poof: torn teal coat scraps with light-blue trim, white
        // gunpowder smoke puffs, brass-gold buttons, and broken navy musket
        // pieces with gold trim bands. Heroine-sized so use ~9 shards on a
        // medium-duration (0.55s) ring with a 0.78× scale.
        const shards = [];
        const N = 9;
        const kinds = 4;
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * TAU + (Math.random() - 0.5) * 0.55;
          shards.push({
            ang,
            speed: 0.85 + Math.random() * 0.65,
            rot0: Math.random() * TAU,
            spin: (Math.random() - 0.5) * 14,
            kind: i % kinds,
          });
        }
        poofs.push({
          x: a.lx, y: a.ly,
          owner: a.owner, face: a.face,
          t: 1,
          dur: 0.55,
          scale: 0.78,
          musketeer: true,
          shards,
        });
        anim.delete(id);
        continue;
      }
      if (a.wasKnight || a.wasGiant || a.wasArcher || a.wasGoblin || a.wasMinion) {
        // Per-kind poof params: Knights drop steel/gold armor shards (default),
        // Giants drop more numerous warm-toned wood/kilt scraps, Archers shed
        // cloth scraps, snapped arrow shafts and loose fletching, Goblins
        // burst into a small puff of sack-cloth, green skin, red bandana and
        // tiny dagger slivers, and Minions burst into wing-membrane scraps,
        // dark feathers, off-white bone slivers and tiny broken horn flakes.
        const isG  = !!a.wasGiant;
        const isA  = !!a.wasArcher;
        const isGo = !!a.wasGoblin;
        const isM  = !!a.wasMinion;
        const shards = [];
        const N     = isM ? 8 : (isGo ? 6  : (isG ? 14 : (isA ? 8 : 9)));
        const kinds = isM ? 4 : (isGo ? 4  : (isA ? 4 : (isG ? 4 : 3)));
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * TAU + (Math.random() - 0.5) * (isM ? 0.55 : (isGo ? 0.6 : 0.5));
          shards.push({
            ang,
            speed: (isM ? 0.80 : (isGo ? 0.70 : (isG ? 1.1 : (isA ? 0.75 : 0.9))))
                 + Math.random() * (isM ? 0.60 : (isGo ? 0.50 : (isG ? 0.9 : (isA ? 0.55 : 0.7)))),
            rot0: Math.random() * TAU,
            spin: (Math.random() - 0.5) * (isM ? 15 : (isGo ? 14 : (isG ? 18 : (isA ? 12 : 14)))),
            kind: i % kinds,
          });
        }
        poofs.push({
          x: a.lx, y: a.ly,
          owner: a.owner, face: a.face,
          t: 1,
          dur:   isM ? 0.48 : (isGo ? 0.40 : (isG ? 0.75 : (isA ? 0.42 : 0.55))),
          scale: isM ? 0.70 : (isGo ? 0.55 : (isG ? 1.7  : (isA ? 0.72 : 1))),
          archer: isA,
          goblin: isGo,
          minion: isM,
          shards,
        });
      }
      anim.delete(id);
    }
  }
  for (let i = poofs.length - 1; i >= 0; i--) {
    poofs[i].t -= dt / poofs[i].dur;
    if (poofs[i].t <= 0) poofs.splice(i, 1);
  }
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A capsule (rounded thick line) from (x0,y0) to (x1,y1).
function capsule(ctx, x0, y0, x1, y1, w) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const nx = Math.cos(a + Math.PI / 2) * w, ny = Math.sin(a + Math.PI / 2) * w;
  ctx.beginPath();
  ctx.moveTo(x0 + nx, y0 + ny);
  ctx.lineTo(x1 + nx, y1 + ny);
  ctx.arc(x1, y1, w, a + Math.PI / 2, a - Math.PI / 2);
  ctx.lineTo(x0 - nx, y0 - ny);
  ctx.arc(x0, y0, w, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

// ── Palette ─────────────────────────────────────────────────────────────────
// User-supplied core palette: ["#000000","#14213d","#fca311","#e5e5e5","#ffffff"]
// Steel/leather/gold derive from it; team colors are the two saturated entries
// (navy vs orange — a strong complementary pair).
const STEEL_HI  = '#ffffff';
const STEEL_MID = '#e5e5e5';
const STEEL_LO  = '#9aa0ad';
const STEEL_SH  = '#3a4256';
const OUTLINE   = '#000000';
const GOLD      = '#fca311';
const GOLD_HI   = '#fdd87a';
const GOLD_LO   = '#9c6b09';
const LEATHER   = '#1a1a1a';
const LEATHER_D = '#000000';
const NAVY      = '#14213d';
const NAVY_DK   = '#0a1428';
const NAVY_HI   = '#2a3a66';
const ORANGE_LO = '#9c6b09';

// Polished 2.5D Knight. (gx,gy) = ground point in screen px (feet anchor).
// View-aware: dispatches to side / front / back renderers based on p.view.
export function drawKnight(ctx, gx, gy, tile, p) {
  // Team palette — P0 = navy, P1 = orange (complementary).
  const team    = p.owner === 0 ? NAVY    : GOLD;
  const teamLo  = p.owner === 0 ? NAVY_DK : ORANGE_LO;
  const teamHi  = p.owner === 0 ? NAVY_HI : GOLD_HI;
  const teamRgb = p.owner === 0 ? '20,33,61' : '252,163,17';
  // Brighter, more luminous team-tinted color for the visor eyes — both teams
  // should pop against the near-black visor backdrop.
  const teamGlow = p.owner === 0 ? '160,180,255' : '255,210,120';

  const S = tile * 0.68;            // figure scale (bumped up another notch)
  const grow = lerp(0.6, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── kinematics ─────────────────────────────────────────────────────────
  const sw = Math.sin(p.gait * TAU);
  const bob = Math.abs(Math.sin(p.gait * TAU)) * p.moving;
  const breath = Math.sin((p.t + p.phase) * 2.0) * (1 - p.moving) * 0.015;
  const lift = (bob * 0.40 + breath) * sc;
  const headBob = Math.sin(p.gait * TAU * 2) * p.moving * 0.018 * sc;

  // Attack timeline (wind-up -> strike -> recovery).
  const s = 1 - p.atk;
  let swingPhase = 0, windPhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.18) windPhase = easeOut(s / 0.18);
    else if (s < 0.70) { windPhase = 1; swingPhase = easeOut((s - 0.18) / 0.52); }
    else { swingPhase = 1; recoverPhase = easeInOut((s - 0.70) / 0.30); }
  }
  const strikePop = clamp01(1 - Math.abs(s - 0.46) * 7);
  const lunge  = (windPhase * -0.10 + swingPhase * 0.65 + recoverPhase * -0.20) * sc * p.face;
  const recoil = p.flash * 0.16 * sc * -p.face;

  ctx.save();
  ctx.globalAlpha = lerp(0.25, 1, easeOut(p.spawnF));

  // Ground cast shadow (the 2.5D anchor).
  const shR = sc * (0.98 - bob * 0.20);
  ctx.fillStyle = `rgba(0,0,0,${0.50 * (1 - bob * 0.30)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.18, gy + sc * 0.05, shR, shR * 0.42, 0, 0, TAU);
  ctx.fill();

  // Spawn rune ring (team-tinted + gold cardinal sparkles).
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(${teamRgb},${0.9 * inv})`;
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.9 + sf * 0.9), sc * 0.36 * (0.9 + sf * 0.9), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * inv})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.7 + sf * 0.7), sc * 0.28 * (0.7 + sf * 0.7), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(253,216,122,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + sf * 0.6;
      const rx = sc * (0.85 + sf * 0.85), ry = sc * 0.32 * (0.85 + sf * 0.85);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.09 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter local space (feet anchor; +x = facing dir; -y = up the screen).
  ctx.translate(gx + lunge + recoil, gy);
  ctx.scale(p.face, 1);
  ctx.rotate(-p.lean * p.face * 0.55 + swingPhase * -0.16 + windPhase * 0.10);
  ctx.translate(0, -lift);

  // Proportions (knight-sized; no chibi).
  const baseY = 0;
  const hipY  = -1.10 * sc;
  const shoY  = -1.84 * sc;
  const headY = -2.26 * sc + headBob;

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = OUTLINE;
  const OW = 0.075 * sc;

  // Helper: T-visor + glowing team-color eye dots + breathing holes.
  // Used by side and front views (back view shows the helmet back, no face).
  const drawHelmFront = (hx) => {
    // T-visor: vertical slot + horizontal slit
    ctx.fillStyle = '#06101a';
    rr(ctx, hx - 0.045 * sc, headY + 0.04 * sc, 0.09 * sc, 0.32 * sc, 0.025 * sc);
    ctx.fill();
    rr(ctx, hx - 0.28 * sc, headY + 0.06 * sc, 0.56 * sc, 0.10 * sc, 0.03 * sc);
    ctx.fill();
    // luminous team-tinted eye dots (intensify on strike + on hit)
    const glow = 0.65 + strikePop * 0.35 + p.flash * 0.30;
    ctx.fillStyle = `rgba(${teamGlow},${glow})`;
    ctx.beginPath();
    ctx.arc(hx - 0.11 * sc, headY + 0.115 * sc, 0.042 * sc, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx + 0.11 * sc, headY + 0.115 * sc, 0.042 * sc, 0, TAU);
    ctx.fill();
    // tiny white catchlight inside each eye
    ctx.fillStyle = `rgba(255,255,255,${0.7 * glow})`;
    ctx.beginPath();
    ctx.arc(hx - 0.115 * sc, headY + 0.105 * sc, 0.014 * sc, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx + 0.105 * sc, headY + 0.105 * sc, 0.014 * sc, 0, TAU);
    ctx.fill();
    // breathing holes
    ctx.fillStyle = 'rgba(6,16,26,0.88)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(hx + i * 0.11 * sc, headY + 0.27 * sc, 0.028 * sc, 0, TAU);
      ctx.fill();
    }
  };

  // ── SIDE VIEW ──────────────────────────────────────────────────────────
  if (p.view === 'side') {

    // Back cape (drawn first so it sits behind everything else).
    {
      const tC = (p.t + p.phase) * 4.5;
      const flutter = (Math.sin(tC) * (0.06 + p.moving * 0.18) +
                       Math.sin(tC * 1.7) * 0.045) * sc;
      ctx.save();
      ctx.translate(-0.18 * sc, shoY + 0.12 * sc);
      ctx.rotate(0.05 + p.moving * 0.08);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-0.58 * sc, 0.55 * sc, -0.20 * sc + flutter, 1.12 * sc);
      ctx.quadraticCurveTo(0.10 * sc, 1.02 * sc, 0.22 * sc, 0);
      ctx.closePath();
      const capeG = ctx.createLinearGradient(0, 0, -0.45 * sc, 1.0 * sc);
      capeG.addColorStop(0, teamLo);
      capeG.addColorStop(1, '#000000');
      ctx.fillStyle = capeG;
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.strokeStyle = team;
      ctx.lineWidth = 0.05 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.06 * sc, 0.05 * sc);
      ctx.quadraticCurveTo(-0.24 * sc, 0.55 * sc, -0.06 * sc + flutter * 0.7, 1.00 * sc);
      ctx.stroke();
      ctx.restore();
    }

    // Legs (back leg first, front leg later over torso).
    const legSpread = 0.32 * sc;
    const legSwing  = sw * 0.36 * sc * p.moving;
    const drawSideLeg = (side, swingX, isBack) => {
      const hipX     = side * legSpread;
      const footX    = side * legSpread + swingX;
      const kneeBend = side * legSpread + swingX * 0.55;
      const kneeY    = (hipY + baseY) * 0.5 + Math.abs(swingX) * 0.10;
      // thigh
      ctx.fillStyle = isBack ? '#161616' : LEATHER;
      capsule(ctx, hipX, hipY, kneeBend, kneeY, 0.19 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // shin
      capsule(ctx, kneeBend, kneeY, footX, baseY - 0.02 * sc, 0.16 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // knee greave + gold rivet
      ctx.fillStyle = STEEL_MID;
      ctx.beginPath();
      ctx.arc(kneeBend, kneeY, 0.13 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(kneeBend, kneeY, 0.04 * sc, 0, TAU);
      ctx.fill();
      // boot
      ctx.fillStyle = LEATHER_D;
      rr(ctx, footX - 0.26 * sc, baseY - 0.22 * sc, 0.56 * sc, 0.24 * sc, 0.08 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = '#222';
      rr(ctx, footX - 0.24 * sc, baseY - 0.20 * sc, 0.22 * sc, 0.09 * sc, 0.03 * sc);
      ctx.fill();
      ctx.fillStyle = GOLD_LO;
      ctx.beginPath();
      ctx.arc(footX + 0.18 * sc, baseY - 0.10 * sc, 0.03 * sc, 0, TAU);
      ctx.fill();
      // foot-plant dust
      const plantA = Math.max(0, (isBack ? -sw : sw)) * p.moving;
      if (plantA > 0.15) {
        ctx.fillStyle = `rgba(160,160,160,${0.18 * plantA})`;
        ctx.beginPath();
        ctx.ellipse(footX - 0.10 * sc * (isBack ? -1 : 1), baseY + 0.02 * sc,
                    0.40 * sc * plantA, 0.11 * sc * plantA, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawSideLeg(-1, -legSwing, true);

    // Shield arm + shield (behind torso).
    const shieldX = -0.64 * sc - swingPhase * 0.10 * sc + windPhase * -0.06 * sc;
    const shieldY = (shoY + hipY) / 2 + bob * 0.05 * sc;
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, -0.48 * sc, shoY + 0.06 * sc,
                 shieldX + 0.06 * sc, shieldY - 0.28 * sc, 0.13 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // shield body
    ctx.save();
    ctx.translate(shieldX, shieldY);
    ctx.rotate(-0.13 - p.moving * 0.05);
    ctx.beginPath();
    ctx.moveTo(-0.48 * sc, -0.54 * sc);
    ctx.lineTo(0.48 * sc, -0.54 * sc);
    ctx.quadraticCurveTo(0.52 * sc, 0.22 * sc, 0, 0.74 * sc);
    ctx.quadraticCurveTo(-0.52 * sc, 0.22 * sc, -0.48 * sc, -0.54 * sc);
    ctx.closePath();
    const sg = ctx.createLinearGradient(-0.42 * sc, -0.42 * sc, 0.46 * sc, 0.58 * sc);
    sg.addColorStop(0, teamHi);
    sg.addColorStop(0.45, team);
    sg.addColorStop(1, teamLo);
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15; ctx.stroke();
    // gold trim
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 0.055 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.40 * sc, -0.46 * sc);
    ctx.lineTo(0.40 * sc, -0.46 * sc);
    ctx.quadraticCurveTo(0.43 * sc, 0.20 * sc, 0, 0.62 * sc);
    ctx.quadraticCurveTo(-0.43 * sc, 0.20 * sc, -0.40 * sc, -0.46 * sc);
    ctx.closePath();
    ctx.stroke();
    // embossed white cross
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fillRect(-0.075 * sc, -0.42 * sc, 0.15 * sc, 0.94 * sc);
    ctx.fillRect(-0.32 * sc, -0.08 * sc, 0.64 * sc, 0.16 * sc);
    // central gold boss
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.arc(0, 0, 0.13 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = GOLD_LO;
    ctx.lineWidth = 0.028 * sc;
    ctx.stroke();
    // corner rivets
    ctx.fillStyle = GOLD;
    for (const [rx, ry] of [[-0.34,-0.42],[0.34,-0.42],[-0.34,0.32],[0.34,0.32]]) {
      ctx.beginPath();
      ctx.arc(rx * sc, ry * sc, 0.04 * sc, 0, TAU);
      ctx.fill();
    }
    // specular streak
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.beginPath();
    ctx.moveTo(-0.32 * sc, -0.36 * sc);
    ctx.lineTo(-0.20 * sc, -0.36 * sc);
    ctx.lineTo(-0.04 * sc, 0.38 * sc);
    ctx.lineTo(-0.16 * sc, 0.38 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Torso (cel-shaded cuirass + tabard + belt + gorget + pauldron).
    ctx.beginPath();
    ctx.moveTo(-0.54 * sc, shoY);
    ctx.quadraticCurveTo(-0.66 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.66 * sc, (shoY + hipY) * 0.5, 0.54 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.26 * sc, -0.54 * sc, shoY);
    ctx.closePath();
    const tg = ctx.createLinearGradient(-0.5 * sc, shoY, 0.5 * sc, hipY);
    tg.addColorStop(0, STEEL_HI);
    tg.addColorStop(0.42, STEEL_MID);
    tg.addColorStop(1, STEEL_LO);
    ctx.fillStyle = tg;
    ctx.fill();
    // back-side shadow band (navy-tinted)
    ctx.fillStyle = 'rgba(20,33,61,0.45)';
    ctx.beginPath();
    ctx.moveTo(-0.54 * sc, shoY);
    ctx.quadraticCurveTo(-0.66 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(-0.20 * sc, hipY);
    ctx.lineTo(-0.12 * sc, shoY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    // bold outline
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15;
    ctx.beginPath();
    ctx.moveTo(-0.54 * sc, shoY);
    ctx.quadraticCurveTo(-0.66 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.66 * sc, (shoY + hipY) * 0.5, 0.54 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.26 * sc, -0.54 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // chest centerline ridge
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 0.035 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY - 0.04 * sc);
    ctx.lineTo(0, hipY);
    ctx.stroke();
    // tabard
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(-0.20 * sc, shoY + 0.06 * sc);
    ctx.lineTo(0.20 * sc, shoY + 0.06 * sc);
    ctx.lineTo(0.16 * sc, hipY + 0.22 * sc);
    ctx.lineTo(0, hipY + 0.32 * sc);
    ctx.lineTo(-0.16 * sc, hipY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 0.035 * sc; ctx.stroke();
    // gold heater emblem
    const tabMid = (shoY + hipY) * 0.5;
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(-0.11 * sc, tabMid - 0.06 * sc);
    ctx.lineTo(0.11 * sc, tabMid - 0.06 * sc);
    ctx.quadraticCurveTo(0.12 * sc, tabMid + 0.08 * sc, 0, tabMid + 0.16 * sc);
    ctx.quadraticCurveTo(-0.12 * sc, tabMid + 0.08 * sc, -0.11 * sc, tabMid - 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.arc(0, tabMid + 0.02 * sc, 0.035 * sc, 0, TAU);
    ctx.fill();
    // belt + buckle
    ctx.fillStyle = LEATHER_D;
    rr(ctx, -0.48 * sc, hipY - 0.05 * sc, 0.96 * sc, 0.14 * sc, 0.03 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    rr(ctx, -0.09 * sc, hipY - 0.07 * sc, 0.18 * sc, 0.18 * sc, 0.02 * sc);
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    // gorget
    ctx.fillStyle = STEEL_LO;
    rr(ctx, -0.18 * sc, shoY - 0.20 * sc, 0.36 * sc, 0.22 * sc, 0.07 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.fillRect(-0.18 * sc, shoY - 0.05 * sc, 0.36 * sc, 0.035 * sc);
    // front pauldron
    ctx.fillStyle = STEEL_MID;
    ctx.beginPath();
    ctx.arc(0.50 * sc, shoY + 0.02 * sc, 0.26 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.fillStyle = STEEL_HI;
    ctx.beginPath();
    ctx.arc(0.42 * sc, shoY - 0.06 * sc, 0.11 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(20,33,61,0.45)';
    ctx.beginPath();
    ctx.arc(0.54 * sc, shoY + 0.08 * sc, 0.20 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.arc(0.50 * sc, shoY + 0.02 * sc, 0.055 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.025 * sc; ctx.stroke();

    // Front leg (over torso/belt).
    drawSideLeg(1, legSwing, false);

    // Sword arm + sword — full anticipation + strike + recovery cycle.
    const restAng = -2.35, hitAng = 0.62, windAng = restAng - 0.42;
    let armAng;
    if (p.atk > 0) {
      if (s < 0.18) armAng = lerp(restAng, windAng, easeOut(s / 0.18));
      else if (s < 0.70) armAng = lerp(windAng, hitAng, easeOut((s - 0.18) / 0.52));
      else armAng = lerp(hitAng, restAng, easeInOut((s - 0.70) / 0.30));
    } else {
      armAng = restAng;
    }
    const shX  = 0.46 * sc, shYY = shoY + 0.06 * sc;
    const handX = shX + Math.cos(armAng) * 0.58 * sc;
    const handY = shYY + Math.sin(armAng) * 0.58 * sc;
    // motion smear (arc + ghost blades)
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAng, hitAng,
                              easeOut(Math.max(0, (s - 0.18) / 0.52 - 0.22)));
      ctx.strokeStyle = `rgba(255,255,255,${0.38 * swingPhase})`;
      ctx.lineWidth = 0.20 * sc;
      ctx.beginPath();
      ctx.arc(shX, shYY, 1.05 * sc, trailStart, armAng, false);
      ctx.stroke();
      for (let i = 1; i <= 2; i++) {
        const t2 = i / 3;
        const gAng = lerp(armAng, trailStart, t2);
        const gHX = shX + Math.cos(gAng) * 0.58 * sc;
        const gHY = shYY + Math.sin(gAng) * 0.58 * sc;
        ctx.save();
        ctx.translate(gHX, gHY);
        ctx.rotate(gAng + Math.PI / 2);
        ctx.fillStyle = `rgba(220,232,245,${0.28 * (1 - t2) * swingPhase})`;
        ctx.beginPath();
        ctx.moveTo(-0.09 * sc, 0);
        ctx.lineTo(0.09 * sc, 0);
        ctx.lineTo(0, -1.45 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // upper arm
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, shX, shYY, handX, handY, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // sword
    ctx.save();
    ctx.translate(handX, handY);
    ctx.rotate(armAng + Math.PI / 2);
    const blg = ctx.createLinearGradient(-0.1 * sc, 0, 0.1 * sc, 0);
    blg.addColorStop(0, '#ffffff');
    blg.addColorStop(0.45, '#dde5ed');
    blg.addColorStop(1, '#8b97a5');
    ctx.fillStyle = blg;
    ctx.beginPath();
    ctx.moveTo(-0.095 * sc, 0);
    ctx.lineTo(0.095 * sc, 0);
    ctx.lineTo(0.06 * sc, -1.32 * sc);
    ctx.lineTo(0, -1.52 * sc);
    ctx.lineTo(-0.06 * sc, -1.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.95; ctx.stroke();
    // fuller groove
    ctx.strokeStyle = 'rgba(60,70,90,0.85)';
    ctx.lineWidth = 0.028 * sc;
    ctx.beginPath();
    ctx.moveTo(0, -0.06 * sc);
    ctx.lineTo(0, -1.22 * sc);
    ctx.stroke();
    // edge streak
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.035 * sc, -0.10 * sc);
    ctx.lineTo(-0.035 * sc, -1.12 * sc);
    ctx.stroke();
    // gold crossguard with end gems
    ctx.fillStyle = GOLD;
    rr(ctx, -0.32 * sc, -0.04 * sc, 0.64 * sc, 0.12 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath(); ctx.arc(-0.32 * sc, 0.02 * sc, 0.035 * sc, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc( 0.32 * sc, 0.02 * sc, 0.035 * sc, 0, TAU); ctx.fill();
    // grip
    ctx.fillStyle = LEATHER;
    rr(ctx, -0.055 * sc, 0.08 * sc, 0.11 * sc, 0.30 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.strokeStyle = LEATHER_D;
    ctx.lineWidth = 0.02 * sc;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.055 * sc, 0.08 * sc + i * 0.075 * sc);
      ctx.lineTo(0.055 * sc, 0.08 * sc + i * 0.075 * sc);
      ctx.stroke();
    }
    // pommel
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.arc(0, 0.44 * sc, 0.085 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.arc(0, 0.44 * sc, 0.038 * sc, 0, TAU);
    ctx.fill();
    if (strikePop > 0.05) {
      ctx.fillStyle = `rgba(255,250,210,${0.9 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, -1.52 * sc, 0.22 * sc * strikePop, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.7 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, -1.52 * sc, 0.10 * sc * strikePop, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // gauntlet
    ctx.fillStyle = STEEL_HI;
    ctx.beginPath();
    ctx.arc(handX, handY, 0.14 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();

    // Head + helmet (side view).
    const hx = 0.04 * sc;
    // plume (three streamers)
    {
      const tP = (p.t + p.phase) * 6.0;
      ctx.save();
      ctx.translate(hx, headY);
      for (let i = 0; i < 3; i++) {
        const ph = tP + i * 0.7;
        const off = Math.sin(ph) * (0.06 + p.moving * 0.14) * sc;
        const tipX = 0.32 * sc + off;
        const baseDrop = -0.04 * sc + i * 0.06 * sc;
        ctx.beginPath();
        ctx.moveTo(-0.02 * sc, -0.42 * sc);
        ctx.quadraticCurveTo(tipX, -0.46 * sc, 0.22 * sc + off * 0.6, baseDrop);
        ctx.quadraticCurveTo(0.06 * sc, -0.22 * sc, -0.02 * sc, -0.42 * sc);
        ctx.closePath();
        ctx.fillStyle = i === 0 ? team : (i === 1 ? teamLo : '#000000');
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      }
      // plume root (gold ferrule)
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(0, -0.42 * sc, 0.075 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
      ctx.restore();
    }
    // helmet dome
    const hg = ctx.createLinearGradient(hx - 0.36 * sc, headY - 0.36 * sc,
                                        hx + 0.36 * sc, headY + 0.36 * sc);
    hg.addColorStop(0, STEEL_HI);
    hg.addColorStop(0.48, STEEL_MID);
    hg.addColorStop(1, STEEL_LO);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.arc(hx, headY, 0.40 * sc, Math.PI, TAU);
    ctx.lineTo(hx + 0.40 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.48 * sc, hx - 0.40 * sc, headY + 0.34 * sc);
    ctx.closePath();
    ctx.fill();
    // back-side shadow band
    ctx.fillStyle = 'rgba(20,33,61,0.50)';
    ctx.beginPath();
    ctx.arc(hx, headY, 0.40 * sc, Math.PI, Math.PI * 1.55);
    ctx.lineTo(hx - 0.40 * sc, headY + 0.34 * sc);
    ctx.lineTo(hx - 0.06 * sc, headY + 0.34 * sc);
    ctx.lineTo(hx - 0.06 * sc, headY - 0.30 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.25;
    ctx.beginPath();
    ctx.arc(hx, headY, 0.40 * sc, Math.PI, TAU);
    ctx.lineTo(hx + 0.40 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.48 * sc, hx - 0.40 * sc, headY + 0.34 * sc);
    ctx.closePath();
    ctx.stroke();
    // brow band + spike
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(hx - 0.38 * sc, headY + 0.02 * sc);
    ctx.lineTo(hx + 0.38 * sc, headY + 0.02 * sc);
    ctx.lineTo(hx + 0.38 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.12 * sc, hx - 0.38 * sc, headY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.moveTo(hx - 0.05 * sc, headY - 0.04 * sc);
    ctx.lineTo(hx + 0.05 * sc, headY - 0.04 * sc);
    ctx.lineTo(hx, headY - 0.20 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    drawHelmFront(hx);
    // helmet rim highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.05 * sc;
    ctx.beginPath();
    ctx.arc(hx, headY, 0.35 * sc, Math.PI * 1.06, Math.PI * 1.78);
    ctx.stroke();

  // ── FRONT VIEW ─────────────────────────────────────────────────────────
  } else if (p.view === 'front') {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    // Small cape flaps peeking out behind body on each side.
    {
      const tCape = (p.t + p.phase) * 4.5;
      const flR = Math.sin(tCape) * (0.05 + p.moving * 0.10) * sc;
      const flL = Math.cos(tCape * 1.1) * (0.05 + p.moving * 0.10) * sc;
      ctx.fillStyle = teamLo;
      ctx.beginPath();
      ctx.moveTo(-0.42 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(-0.60 * sc + flL, hipY + 0.20 * sc,
                           -0.36 * sc + flL * 0.5, hipY + 0.50 * sc);
      ctx.quadraticCurveTo(-0.30 * sc, hipY + 0.20 * sc,
                           -0.32 * sc, shoY + 0.18 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.42 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(0.60 * sc + flR, hipY + 0.20 * sc,
                           0.36 * sc + flR * 0.5, hipY + 0.50 * sc);
      ctx.quadraticCurveTo(0.30 * sc, hipY + 0.20 * sc,
                           0.32 * sc, shoY + 0.18 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    }

    // Alternating leg lifts (left/right take turns lifting off the ground).
    const legSpreadF = 0.26 * sc;
    const liftL = Math.max(0, sw)  * 0.22 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.22 * sc * p.moving;
    const drawFrontLeg = (side, footLift) => {
      const x = side * legSpreadF;
      const footPt = baseY - footLift;
      ctx.fillStyle = LEATHER;
      capsule(ctx, x, hipY, x, footPt - 0.02 * sc, 0.20 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // knee greave
      const kY = (hipY + footPt) * 0.5 - 0.04 * sc;
      ctx.fillStyle = STEEL_MID;
      ctx.beginPath();
      ctx.arc(x, kY, 0.15 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(x, kY, 0.05 * sc, 0, TAU);
      ctx.fill();
      // toe-on boot
      ctx.fillStyle = LEATHER_D;
      rr(ctx, x - 0.24 * sc, footPt - 0.18 * sc, 0.48 * sc, 0.22 * sc, 0.10 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = '#222';
      rr(ctx, x - 0.22 * sc, footPt - 0.16 * sc, 0.44 * sc, 0.09 * sc, 0.04 * sc);
      ctx.fill();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(x, footPt - 0.07 * sc, 0.035 * sc, 0, TAU);
      ctx.fill();
      if (footLift < 0.02 * sc && p.moving > 0.2) {
        ctx.fillStyle = `rgba(160,160,160,${0.18 * p.moving})`;
        ctx.beginPath();
        ctx.ellipse(x, baseY + 0.02 * sc, 0.30 * sc, 0.08 * sc, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawFrontLeg(-1, liftL);
    drawFrontLeg(1, liftR);

    // Cuirass — facing-camera egg shape.
    ctx.beginPath();
    ctx.moveTo(-0.50 * sc, shoY);
    ctx.quadraticCurveTo(-0.62 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.50 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.22 * sc, -0.50 * sc, shoY);
    ctx.closePath();
    const tgF = ctx.createLinearGradient(-0.50 * sc, shoY, 0.50 * sc, hipY);
    tgF.addColorStop(0, STEEL_HI);
    tgF.addColorStop(0.5, STEEL_MID);
    tgF.addColorStop(1, STEEL_LO);
    ctx.fillStyle = tgF;
    ctx.fill();
    // light right-side shadow
    ctx.fillStyle = 'rgba(20,33,61,0.32)';
    ctx.beginPath();
    ctx.moveTo(0.50 * sc, shoY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.46 * sc, hipY);
    ctx.lineTo(0.20 * sc, hipY);
    ctx.lineTo(0.12 * sc, shoY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15;
    ctx.beginPath();
    ctx.moveTo(-0.50 * sc, shoY);
    ctx.quadraticCurveTo(-0.62 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.50 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.22 * sc, -0.50 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 0.035 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY - 0.04 * sc);
    ctx.lineTo(0, hipY);
    ctx.stroke();
    // tabard
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.moveTo(-0.22 * sc, shoY + 0.06 * sc);
    ctx.lineTo(0.22 * sc, shoY + 0.06 * sc);
    ctx.lineTo(0.18 * sc, hipY + 0.22 * sc);
    ctx.lineTo(0, hipY + 0.34 * sc);
    ctx.lineTo(-0.18 * sc, hipY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 0.035 * sc; ctx.stroke();
    const tabMidF = (shoY + hipY) * 0.5;
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(-0.12 * sc, tabMidF - 0.06 * sc);
    ctx.lineTo(0.12 * sc, tabMidF - 0.06 * sc);
    ctx.quadraticCurveTo(0.13 * sc, tabMidF + 0.10 * sc, 0, tabMidF + 0.18 * sc);
    ctx.quadraticCurveTo(-0.13 * sc, tabMidF + 0.10 * sc, -0.12 * sc, tabMidF - 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.arc(0, tabMidF + 0.02 * sc, 0.038 * sc, 0, TAU);
    ctx.fill();
    // belt + buckle
    ctx.fillStyle = LEATHER_D;
    rr(ctx, -0.46 * sc, hipY - 0.05 * sc, 0.92 * sc, 0.14 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    rr(ctx, -0.10 * sc, hipY - 0.07 * sc, 0.20 * sc, 0.18 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    // gorget
    ctx.fillStyle = STEEL_LO;
    rr(ctx, -0.20 * sc, shoY - 0.20 * sc, 0.40 * sc, 0.22 * sc, 0.08 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.fillRect(-0.20 * sc, shoY - 0.05 * sc, 0.40 * sc, 0.035 * sc);
    // two pauldrons
    for (const sgn of [-1, 1]) {
      const pcx = sgn * 0.52 * sc;
      ctx.fillStyle = STEEL_MID;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.24 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = STEEL_HI;
      ctx.beginPath();
      ctx.arc(pcx - sgn * 0.06 * sc, shoY - 0.06 * sc, 0.10 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(20,33,61,0.40)';
      ctx.beginPath();
      ctx.arc(pcx + sgn * 0.05 * sc, shoY + 0.10 * sc, 0.18 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.05 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    }
    // Shield held in front, on viewer's left.
    {
      const shdX = -0.46 * sc - swingPhase * 0.04 * sc;
      const shdY = (shoY + hipY) * 0.5 + 0.04 * sc;
      ctx.save();
      ctx.translate(shdX, shdY);
      ctx.rotate(-0.06 - p.moving * 0.04);
      ctx.beginPath();
      ctx.moveTo(-0.34 * sc, -0.42 * sc);
      ctx.lineTo(0.34 * sc, -0.42 * sc);
      ctx.quadraticCurveTo(0.38 * sc, 0.18 * sc, 0, 0.58 * sc);
      ctx.quadraticCurveTo(-0.38 * sc, 0.18 * sc, -0.34 * sc, -0.42 * sc);
      ctx.closePath();
      const sgF = ctx.createLinearGradient(-0.3 * sc, -0.3 * sc, 0.3 * sc, 0.42 * sc);
      sgF.addColorStop(0, teamHi);
      sgF.addColorStop(0.5, team);
      sgF.addColorStop(1, teamLo);
      ctx.fillStyle = sgF;
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.strokeStyle = GOLD; ctx.lineWidth = 0.045 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.28 * sc, -0.36 * sc);
      ctx.lineTo(0.28 * sc, -0.36 * sc);
      ctx.quadraticCurveTo(0.30 * sc, 0.14 * sc, 0, 0.48 * sc);
      ctx.quadraticCurveTo(-0.30 * sc, 0.14 * sc, -0.28 * sc, -0.36 * sc);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(-0.06 * sc, -0.34 * sc, 0.12 * sc, 0.76 * sc);
      ctx.fillRect(-0.25 * sc, -0.07 * sc, 0.50 * sc, 0.14 * sc);
      ctx.fillStyle = GOLD_HI;
      ctx.beginPath();
      ctx.arc(0, 0, 0.11 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
      ctx.restore();
    }
    // Shield arm.
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, -0.44 * sc, shoY + 0.10 * sc,
                 -0.46 * sc, (shoY + hipY) * 0.5 - 0.05 * sc, 0.13 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();

    // Sword arm + sword — overhead chop animation.
    // Rest: sword over right shoulder pointing up-right.
    // Wind-up: rotate further right (cocking back), still up.
    // Strike: sweeps clockwise OVER THE HEAD down to lower-left across body.
    // Recovery: back to rest.
    const restAngF = -Math.PI / 2 + 0.30;
    const windAngF = -Math.PI / 2 + 0.70;
    const hitAngF  =  Math.PI / 2 + 0.40;
    let armAngF;
    if (p.atk > 0) {
      if (s < 0.18) armAngF = lerp(restAngF, windAngF, easeOut(s / 0.18));
      else if (s < 0.70) armAngF = lerp(windAngF, hitAngF, easeOut((s - 0.18) / 0.52));
      else armAngF = lerp(hitAngF, restAngF, easeInOut((s - 0.70) / 0.30));
    } else {
      armAngF = restAngF;
    }
    const swShXF = 0.44 * sc, swShYF = shoY + 0.10 * sc;
    const swHandX = swShXF + Math.cos(armAngF) * 0.52 * sc;
    const swHandY = swShYF + Math.sin(armAngF) * 0.52 * sc;
    // motion smear arc (clockwise around the right side)
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAngF, hitAngF,
                              easeOut(Math.max(0, (s - 0.18) / 0.52 - 0.22)));
      ctx.strokeStyle = `rgba(255,255,255,${0.38 * swingPhase})`;
      ctx.lineWidth = 0.20 * sc;
      ctx.beginPath();
      ctx.arc(swShXF, swShYF, 1.10 * sc, trailStart, armAngF, false);
      ctx.stroke();
      for (let i = 1; i <= 2; i++) {
        const t2 = i / 3;
        const gA = lerp(armAngF, trailStart, t2);
        const gHX = swShXF + Math.cos(gA) * 0.52 * sc;
        const gHY = swShYF + Math.sin(gA) * 0.52 * sc;
        ctx.save();
        ctx.translate(gHX, gHY);
        ctx.rotate(gA + Math.PI / 2);
        ctx.fillStyle = `rgba(220,232,245,${0.28 * (1 - t2) * swingPhase})`;
        ctx.beginPath();
        ctx.moveTo(-0.09 * sc, 0);
        ctx.lineTo(0.09 * sc, 0);
        ctx.lineTo(0, -1.45 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // upper arm
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, swShXF, swShYF, swHandX, swHandY, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // sword
    ctx.save();
    ctx.translate(swHandX, swHandY);
    ctx.rotate(armAngF + Math.PI / 2);
    const blgF = ctx.createLinearGradient(-0.1 * sc, 0, 0.1 * sc, 0);
    blgF.addColorStop(0, '#ffffff');
    blgF.addColorStop(0.45, '#dde5ed');
    blgF.addColorStop(1, '#8b97a5');
    ctx.fillStyle = blgF;
    ctx.beginPath();
    ctx.moveTo(-0.095 * sc, 0);
    ctx.lineTo(0.095 * sc, 0);
    ctx.lineTo(0.06 * sc, -1.32 * sc);
    ctx.lineTo(0, -1.52 * sc);
    ctx.lineTo(-0.06 * sc, -1.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.95; ctx.stroke();
    ctx.strokeStyle = 'rgba(60,70,90,0.85)';
    ctx.lineWidth = 0.028 * sc;
    ctx.beginPath();
    ctx.moveTo(0, -0.06 * sc);
    ctx.lineTo(0, -1.22 * sc);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.035 * sc, -0.10 * sc);
    ctx.lineTo(-0.035 * sc, -1.12 * sc);
    ctx.stroke();
    ctx.fillStyle = GOLD;
    rr(ctx, -0.32 * sc, -0.04 * sc, 0.64 * sc, 0.12 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath(); ctx.arc(-0.32 * sc, 0.02 * sc, 0.035 * sc, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc( 0.32 * sc, 0.02 * sc, 0.035 * sc, 0, TAU); ctx.fill();
    ctx.fillStyle = LEATHER;
    rr(ctx, -0.055 * sc, 0.08 * sc, 0.11 * sc, 0.30 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.strokeStyle = LEATHER_D;
    ctx.lineWidth = 0.02 * sc;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.055 * sc, 0.08 * sc + i * 0.075 * sc);
      ctx.lineTo(0.055 * sc, 0.08 * sc + i * 0.075 * sc);
      ctx.stroke();
    }
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.arc(0, 0.44 * sc, 0.085 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.arc(0, 0.44 * sc, 0.038 * sc, 0, TAU);
    ctx.fill();
    if (strikePop > 0.05) {
      ctx.fillStyle = `rgba(255,250,210,${0.9 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, -1.52 * sc, 0.22 * sc * strikePop, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.7 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, -1.52 * sc, 0.10 * sc * strikePop, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // gauntlet
    ctx.fillStyle = STEEL_HI;
    ctx.beginPath();
    ctx.arc(swHandX, swHandY, 0.14 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();

    // Head + helmet (front view, with face).
    const hxF = 0;
    {
      const tP = (p.t + p.phase) * 6.0;
      for (let i = 0; i < 3; i++) {
        const ph = tP + i * 0.7;
        const off = Math.sin(ph) * (0.05 + p.moving * 0.10) * sc;
        const sgn = (i - 1);
        ctx.beginPath();
        ctx.moveTo(hxF - 0.02 * sc + sgn * 0.04 * sc, headY - 0.42 * sc);
        ctx.quadraticCurveTo(hxF + sgn * 0.20 * sc + off, headY - 0.62 * sc + off,
                             hxF + sgn * 0.12 * sc + off * 0.5, headY - 0.22 * sc);
        ctx.quadraticCurveTo(hxF + sgn * 0.06 * sc, headY - 0.34 * sc,
                             hxF - 0.02 * sc + sgn * 0.04 * sc, headY - 0.42 * sc);
        ctx.closePath();
        ctx.fillStyle = i === 1 ? team : (i === 0 ? teamLo : '#000000');
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      }
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(hxF, headY - 0.40 * sc, 0.075 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    }
    const hgF = ctx.createLinearGradient(hxF - 0.40 * sc, headY - 0.36 * sc,
                                         hxF + 0.40 * sc, headY + 0.36 * sc);
    hgF.addColorStop(0, STEEL_HI);
    hgF.addColorStop(0.48, STEEL_MID);
    hgF.addColorStop(1, STEEL_LO);
    ctx.fillStyle = hgF;
    ctx.beginPath();
    ctx.arc(hxF, headY, 0.40 * sc, Math.PI, TAU);
    ctx.lineTo(hxF + 0.40 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hxF, headY + 0.48 * sc, hxF - 0.40 * sc, headY + 0.34 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(20,33,61,0.32)';
    ctx.beginPath();
    ctx.arc(hxF, headY, 0.40 * sc, Math.PI * 1.45, TAU);
    ctx.lineTo(hxF + 0.40 * sc, headY + 0.34 * sc);
    ctx.lineTo(hxF + 0.05 * sc, headY + 0.34 * sc);
    ctx.lineTo(hxF + 0.05 * sc, headY - 0.30 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.25;
    ctx.beginPath();
    ctx.arc(hxF, headY, 0.40 * sc, Math.PI, TAU);
    ctx.lineTo(hxF + 0.40 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hxF, headY + 0.48 * sc, hxF - 0.40 * sc, headY + 0.34 * sc);
    ctx.closePath();
    ctx.stroke();
    // brow band + spike
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(hxF - 0.38 * sc, headY + 0.02 * sc);
    ctx.lineTo(hxF + 0.38 * sc, headY + 0.02 * sc);
    ctx.lineTo(hxF + 0.38 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hxF, headY - 0.12 * sc, hxF - 0.38 * sc, headY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.moveTo(hxF - 0.05 * sc, headY - 0.04 * sc);
    ctx.lineTo(hxF + 0.05 * sc, headY - 0.04 * sc);
    ctx.lineTo(hxF, headY - 0.20 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    drawHelmFront(hxF);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.05 * sc;
    ctx.beginPath();
    ctx.arc(hxF, headY, 0.35 * sc, Math.PI * 1.06, Math.PI * 1.78);
    ctx.stroke();

  // ── BACK VIEW ──────────────────────────────────────────────────────────
  } else {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    // Alternating leg lifts.
    const legSpreadB = 0.26 * sc;
    const liftL = Math.max(0, sw)  * 0.20 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.20 * sc * p.moving;
    const drawBackLeg = (side, footLift) => {
      const x = side * legSpreadB;
      const footPt = baseY - footLift;
      ctx.fillStyle = '#161616';
      capsule(ctx, x, hipY, x, footPt - 0.02 * sc, 0.20 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      const kY = (hipY + footPt) * 0.5 - 0.04 * sc;
      ctx.fillStyle = STEEL_MID;
      ctx.beginPath();
      ctx.arc(x, kY, 0.15 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(x, kY, 0.05 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = LEATHER_D;
      rr(ctx, x - 0.22 * sc, footPt - 0.16 * sc, 0.44 * sc, 0.22 * sc, 0.10 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = '#222';
      rr(ctx, x - 0.20 * sc, footPt - 0.14 * sc, 0.40 * sc, 0.07 * sc, 0.04 * sc);
      ctx.fill();
    };
    drawBackLeg(-1, liftL);
    drawBackLeg(1, liftR);

    // Cuirass back (symmetric, no tabard).
    ctx.beginPath();
    ctx.moveTo(-0.50 * sc, shoY);
    ctx.quadraticCurveTo(-0.62 * sc, (shoY + hipY) * 0.5, -0.46 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.50 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.22 * sc, -0.50 * sc, shoY);
    ctx.closePath();
    const tgB = ctx.createLinearGradient(0, shoY, 0, hipY);
    tgB.addColorStop(0, STEEL_MID);
    tgB.addColorStop(1, STEEL_LO);
    ctx.fillStyle = tgB;
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15; ctx.stroke();
    // spine ridge
    ctx.strokeStyle = 'rgba(255,255,255,0.40)';
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY - 0.02 * sc);
    ctx.lineTo(0, hipY);
    ctx.stroke();
    // two pauldrons
    for (const sgn of [-1, 1]) {
      const pcx = sgn * 0.52 * sc;
      ctx.fillStyle = STEEL_MID;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.24 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = STEEL_HI;
      ctx.beginPath();
      ctx.arc(pcx + sgn * 0.05 * sc, shoY - 0.06 * sc, 0.10 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.05 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    }
    // Big cape covering most of the back.
    const tCape = (p.t + p.phase) * 4.5;
    const flutter = (Math.sin(tCape) * (0.06 + p.moving * 0.22) +
                     Math.sin(tCape * 1.7) * 0.045) * sc;
    ctx.beginPath();
    ctx.moveTo(-0.42 * sc, shoY + 0.04 * sc);
    ctx.lineTo(0.42 * sc, shoY + 0.04 * sc);
    ctx.quadraticCurveTo(0.50 * sc + flutter * 0.4, (shoY + hipY) * 0.5,
                         0.36 * sc + flutter * 0.6, hipY + 0.28 * sc);
    ctx.quadraticCurveTo(0.16 * sc + flutter, hipY + 0.52 * sc,
                         0 + flutter * 0.7, hipY + 0.62 * sc);
    ctx.quadraticCurveTo(-0.16 * sc + flutter, hipY + 0.52 * sc,
                         -0.36 * sc + flutter * 0.6, hipY + 0.28 * sc);
    ctx.quadraticCurveTo(-0.50 * sc + flutter * 0.4, (shoY + hipY) * 0.5,
                         -0.42 * sc, shoY + 0.04 * sc);
    ctx.closePath();
    const capeG = ctx.createLinearGradient(0, shoY, 0, hipY + 0.6 * sc);
    capeG.addColorStop(0, team);
    capeG.addColorStop(0.55, teamLo);
    capeG.addColorStop(1, '#000000');
    ctx.fillStyle = capeG;
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // gold top trim
    ctx.strokeStyle = GOLD; ctx.lineWidth = 0.045 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.42 * sc, shoY + 0.04 * sc);
    ctx.lineTo(0.42 * sc, shoY + 0.04 * sc);
    ctx.stroke();
    // bright center crease following the flutter
    ctx.strokeStyle = teamHi;
    ctx.lineWidth = 0.045 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY + 0.10 * sc);
    ctx.quadraticCurveTo(flutter * 0.3, (shoY + hipY) * 0.5,
                         flutter * 0.5, hipY + 0.50 * sc);
    ctx.stroke();
    // gold heater emblem on cape
    const emY = (shoY + hipY) * 0.5 + 0.05 * sc;
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(-0.12 * sc + flutter * 0.3, emY - 0.06 * sc);
    ctx.lineTo(0.12 * sc + flutter * 0.3, emY - 0.06 * sc);
    ctx.quadraticCurveTo(0.13 * sc + flutter * 0.3, emY + 0.10 * sc,
                         0 + flutter * 0.4, emY + 0.18 * sc);
    ctx.quadraticCurveTo(-0.13 * sc + flutter * 0.3, emY + 0.10 * sc,
                         -0.12 * sc + flutter * 0.3, emY - 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = team;
    ctx.beginPath();
    ctx.arc(flutter * 0.35, emY + 0.04 * sc, 0.04 * sc, 0, TAU);
    ctx.fill();

    // Sword arm + sword — overhead chop visible above the cape silhouette.
    // Same wind-up/strike pattern as the front view, but seen from behind.
    const restAngB = -Math.PI / 2 + 0.30;
    const windAngB = -Math.PI / 2 + 0.70;
    const hitAngB  =  Math.PI / 2 + 0.40;
    let armAngB;
    if (p.atk > 0) {
      if (s < 0.18) armAngB = lerp(restAngB, windAngB, easeOut(s / 0.18));
      else if (s < 0.70) armAngB = lerp(windAngB, hitAngB, easeOut((s - 0.18) / 0.52));
      else armAngB = lerp(hitAngB, restAngB, easeInOut((s - 0.70) / 0.30));
    } else {
      armAngB = restAngB;
    }
    const swShXB = 0.44 * sc, swShYB = shoY + 0.10 * sc;
    const swHandXB = swShXB + Math.cos(armAngB) * 0.52 * sc;
    const swHandYB = swShYB + Math.sin(armAngB) * 0.52 * sc;
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAngB, hitAngB,
                              easeOut(Math.max(0, (s - 0.18) / 0.52 - 0.22)));
      ctx.strokeStyle = `rgba(255,255,255,${0.32 * swingPhase})`;
      ctx.lineWidth = 0.20 * sc;
      ctx.beginPath();
      ctx.arc(swShXB, swShYB, 1.10 * sc, trailStart, armAngB, false);
      ctx.stroke();
    }
    // upper arm
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, swShXB, swShYB, swHandXB, swHandYB, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // sword — visible only when raised above shoulder, or during the swing.
    // Once it crosses below the shoulder the cape/body silhouette occludes it.
    if (swHandYB < swShYB + 0.05 * sc || (swingPhase > 0 && swingPhase < 1)) {
      ctx.save();
      ctx.translate(swHandXB, swHandYB);
      ctx.rotate(armAngB + Math.PI / 2);
      const blgB = ctx.createLinearGradient(-0.1 * sc, 0, 0.1 * sc, 0);
      blgB.addColorStop(0, '#ffffff');
      blgB.addColorStop(0.45, '#dde5ed');
      blgB.addColorStop(1, '#8b97a5');
      ctx.fillStyle = blgB;
      ctx.beginPath();
      ctx.moveTo(-0.095 * sc, 0);
      ctx.lineTo(0.095 * sc, 0);
      ctx.lineTo(0.06 * sc, -1.32 * sc);
      ctx.lineTo(0, -1.52 * sc);
      ctx.lineTo(-0.06 * sc, -1.32 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.95; ctx.stroke();
      ctx.fillStyle = GOLD;
      rr(ctx, -0.32 * sc, -0.04 * sc, 0.64 * sc, 0.12 * sc, 0.04 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      if (strikePop > 0.05) {
        ctx.fillStyle = `rgba(255,250,210,${0.9 * strikePop})`;
        ctx.beginPath();
        ctx.arc(0, -1.52 * sc, 0.22 * sc * strikePop, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    // gauntlet
    ctx.fillStyle = STEEL_HI;
    ctx.beginPath();
    ctx.arc(swHandXB, swHandYB, 0.14 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();

    // Shield arm (mostly behind cape, just a sliver of the shoulder shows).
    ctx.fillStyle = STEEL_MID;
    capsule(ctx, -0.44 * sc, shoY + 0.10 * sc,
                 -0.48 * sc, (shoY + hipY) * 0.5, 0.13 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();

    // Head + helmet back (no face).
    const hxB = 0;
    {
      const tP = (p.t + p.phase) * 6.0;
      for (let i = 0; i < 3; i++) {
        const ph = tP + i * 0.7;
        const off = Math.sin(ph) * (0.05 + p.moving * 0.10) * sc;
        const sgn = (i - 1);
        ctx.beginPath();
        ctx.moveTo(hxB + sgn * 0.04 * sc, headY - 0.42 * sc);
        ctx.quadraticCurveTo(hxB + sgn * 0.20 * sc + off, headY - 0.62 * sc + off,
                             hxB + sgn * 0.10 * sc + off * 0.5, headY - 0.22 * sc);
        ctx.quadraticCurveTo(hxB + sgn * 0.06 * sc, headY - 0.34 * sc,
                             hxB + sgn * 0.04 * sc, headY - 0.42 * sc);
        ctx.closePath();
        ctx.fillStyle = i === 1 ? team : (i === 0 ? teamLo : '#000000');
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      }
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(hxB, headY - 0.40 * sc, 0.075 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    }
    const hgB = ctx.createLinearGradient(hxB - 0.40 * sc, headY - 0.36 * sc,
                                         hxB + 0.40 * sc, headY + 0.36 * sc);
    hgB.addColorStop(0, STEEL_LO);
    hgB.addColorStop(0.45, STEEL_MID);
    hgB.addColorStop(1, STEEL_LO);
    ctx.fillStyle = hgB;
    ctx.beginPath();
    ctx.arc(hxB, headY, 0.40 * sc, Math.PI, TAU);
    ctx.lineTo(hxB + 0.40 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hxB, headY + 0.48 * sc, hxB - 0.40 * sc, headY + 0.34 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.25; ctx.stroke();
    // center spine
    ctx.strokeStyle = 'rgba(255,255,255,0.40)';
    ctx.lineWidth = 0.035 * sc;
    ctx.beginPath();
    ctx.moveTo(hxB, headY - 0.38 * sc);
    ctx.lineTo(hxB, headY + 0.34 * sc);
    ctx.stroke();
    // gold rear band + rivet caps
    ctx.fillStyle = GOLD;
    rr(ctx, hxB - 0.38 * sc, headY + 0.06 * sc, 0.76 * sc, 0.07 * sc, 0.02 * sc);
    ctx.fill();
    ctx.strokeStyle = GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = GOLD_HI;
    ctx.beginPath();
    ctx.arc(hxB - 0.32 * sc, headY + 0.095 * sc, 0.035 * sc, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hxB + 0.32 * sc, headY + 0.095 * sc, 0.035 * sc, 0, TAU);
    ctx.fill();
    // helmet rim highlight (top arc)
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.05 * sc;
    ctx.beginPath();
    ctx.arc(hxB, headY, 0.35 * sc, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }

  // Hit flash (white wash over the whole figure).
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.55 * p.flash})`;
    rr(ctx, -0.76 * sc, headY - 0.55 * sc,
        1.52 * sc, (baseY - headY) + 0.70 * sc, 0.30 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();

  // Mark this id as a Knight so sweepAnim() spawns a death poof.
  return true;
}

export function markKnight(id) {
  const a = anim.get(id);
  if (a) a.wasKnight = true;
}

// ── Giant palette ──────────────────────────────────────────────────────────
// Spec-supplied core five: deep teal #003049, deep red #d62828, warm orange
// #f77f00, gold yellow #fcbf49, cream #eae2b7. Everything below either is
// one of those or is a single shade lighter/darker for cel-shading.
const G_DARK   = '#003049';
const G_DARK_D = '#001a2a';
const G_RED    = '#d62828';
const G_RED_HI = '#ef4848';
const G_RED_LO = '#8a1818';
const G_SKIN   = '#f77f00';      // warm orange skin mid
const G_SKIN_HI= '#fcbf8a';      // peach highlight
const G_SKIN_SH= '#a04500';      // rust shadow
const G_GOLD   = '#fcbf49';      // beard / gold trim
const G_GOLD_HI= '#ffd97a';
const G_GOLD_LO= '#b8881f';
const G_CREAM  = '#eae2b7';
const G_WOOD   = '#a04500';      // club shaft (sun-baked wood)

// Polished 2.5D Giant — bare-chested barbarian with a knotted wooden club.
// 1.5× the Knight's silhouette. View-aware (side / front / back), with a
// three-phase overhead-slam attack: windup raises the club, strike slams it
// down with a ground-shock ring, recovery returns to rest. Idle breathing,
// beard flutter, foot-plant dust, spawn rune ring and hit flash all match the
// Knight's quality bar.
export function drawGiant(ctx, gx, gy, tile, p) {
  // Team accent: P0 = deep teal-blue, P1 = deep red. Used for war paint,
  // belt-buckle gem, pauldron stud and spawn ring so the two sides read
  // apart without breaking the spec palette.
  const TEAM    = p.owner === 0 ? G_DARK    : G_RED;
  const TEAM_HI = p.owner === 0 ? '#0a5a8c' : G_RED_HI;
  const TEAM_RGB= p.owner === 0 ? '0,48,73' : '214,40,40';

  const S = tile * 1.05;                  // ~1.5× the Knight's S=tile*0.68
  const grow = lerp(0.55, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── kinematics ─────────────────────────────────────────────────────────
  const sw = Math.sin(p.gait * TAU);
  const bob = Math.abs(Math.sin(p.gait * TAU)) * p.moving;
  // Idle breathing: slower frequency than the Knight; bigger chest = bigger
  // vertical amplitude so it reads from across the arena.
  const breath = Math.sin((p.t + p.phase) * 1.6) * (1 - p.moving) * 0.025;
  const lift = (bob * 0.32 + breath) * sc;
  const headBob = Math.sin(p.gait * TAU * 2) * p.moving * 0.020 * sc;
  // Beard flutter: small sinusoidal sway, amplified by movement.
  const beardSway = Math.sin(p.t * 5 + p.phase) * (0.025 + p.moving * 0.060) * sc;

  // Attack timeline — windup (raise) → strike (slam) → recovery.
  const s = 1 - p.atk;
  let windPhase = 0, swingPhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.22)      windPhase = easeOut(s / 0.22);
    else if (s < 0.62){ windPhase = 1; swingPhase = easeOut((s - 0.22) / 0.40); }
    else              { swingPhase = 1; recoverPhase = easeInOut((s - 0.62) / 0.38); }
  }
  // Strike pop peaks just as the club passes the bottom of the arc.
  const strikePop = clamp01(1 - Math.abs(s - 0.50) * 7);
  // Heavy lunge: lean BACK on windup, FORWARD on strike, settle on recovery.
  const lunge = (windPhase * -0.10 + swingPhase * 0.32 + recoverPhase * -0.08) * sc * p.face;
  const recoil = p.flash * 0.10 * sc * -p.face;

  ctx.save();
  ctx.globalAlpha = lerp(0.25, 1, easeOut(p.spawnF));

  // ── ground cast shadow (heavier than the Knight) ───────────────────────
  const shR = sc * (1.14 - bob * 0.20);
  ctx.fillStyle = `rgba(0,0,0,${0.55 * (1 - bob * 0.30)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.18, gy + sc * 0.06, shR, shR * 0.40, 0, 0, TAU);
  ctx.fill();

  // ── ground-shock ring at the strike moment ─────────────────────────────
  // Expanding rings on the ground out in front of the giant, where the club
  // head lands. Two stacked rings + a few tiny ejecta rocks.
  if (strikePop > 0.05) {
    const impactX = gx + sc * 1.20 * p.face;
    const impactY = gy + sc * 0.04;
    const fade = strikePop;
    const sr = sc * (0.55 + (1 - fade) * 2.4);
    ctx.strokeStyle = `rgba(180,150,110,${0.6 * fade})`;
    ctx.lineWidth = 5 * fade;
    ctx.beginPath();
    ctx.ellipse(impactX, impactY, sr, sr * 0.42, 0, 0, TAU);
    ctx.stroke();
    const sr2 = sr * 0.55;
    ctx.strokeStyle = `rgba(230,210,170,${0.55 * fade})`;
    ctx.lineWidth = 3 * fade;
    ctx.beginPath();
    ctx.ellipse(impactX, impactY, sr2, sr2 * 0.42, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(120,100,80,${0.85 * fade})`;
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * TAU + p.phase * 2;
      const rr2 = sr * (0.55 + 0.40 * Math.sin(ang * 3 + p.t));
      ctx.beginPath();
      ctx.arc(impactX + Math.cos(ang) * rr2,
              impactY + Math.sin(ang) * rr2 * 0.42, 0.07 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // ── spawn rune ring (bigger than Knight's) ─────────────────────────────
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(${TEAM_RGB},${0.9 * inv})`;
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (1.00 + sf * 1.00), sc * 0.40 * (1.00 + sf * 1.00), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * inv})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.78 + sf * 0.78), sc * 0.32 * (0.78 + sf * 0.78), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,217,122,${0.95 * inv})`;
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * TAU + sf * 0.7;
      const rx = sc * (0.92 + sf * 0.92), ry = sc * 0.36 * (0.92 + sf * 0.92);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.11 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter local space (feet anchor; +x = facing dir; -y = up the screen).
  ctx.translate(gx + lunge + recoil, gy);
  ctx.scale(p.face, 1);
  ctx.rotate(-p.lean * 0.45 + windPhase * 0.08 - swingPhase * 0.14);
  ctx.translate(0, -lift);

  // Proportions: thick torso, short stocky legs, big head/beard mass.
  const baseY = 0;
  const hipY  = -1.05 * sc;
  const shoY  = -2.00 * sc;
  const headY = -2.50 * sc + headBob;

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = G_DARK;
  const OW = 0.090 * sc;

  // ── club helper (drawn at the grip; shaft up local -y) ─────────────────
  // Reused by all three views & by the motion-smear ghost echoes.
  const drawClub = () => {
    const L = 1.55 * sc;
    const headR = 0.30 * sc;
    // shaft (tapered, knotted)
    const shaftG = ctx.createLinearGradient(-0.12 * sc, 0, 0.12 * sc, 0);
    shaftG.addColorStop(0, G_WOOD);
    shaftG.addColorStop(0.5, G_SKIN);   // warm orange mid
    shaftG.addColorStop(1, G_WOOD);
    ctx.fillStyle = shaftG;
    ctx.beginPath();
    ctx.moveTo(-0.085 * sc, 0.06 * sc);
    ctx.lineTo(-0.115 * sc, -L * 0.92);
    ctx.lineTo(0.115 * sc, -L * 0.92);
    ctx.lineTo(0.085 * sc, 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.95; ctx.stroke();
    // shaft highlight stripe (cream)
    ctx.strokeStyle = G_CREAM;
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.055 * sc, -0.05 * sc);
    ctx.lineTo(-0.082 * sc, -L * 0.88);
    ctx.stroke();
    // knot rings on the shaft (dark teal grooves)
    ctx.strokeStyle = G_DARK;
    ctx.lineWidth = 0.022 * sc;
    for (let i = 1; i <= 3; i++) {
      const ky = -L * i * 0.22;
      ctx.beginPath();
      ctx.ellipse(0, ky, 0.045 * sc, 0.020 * sc, 0, 0, TAU);
      ctx.stroke();
    }
    // head (big knob)
    const headPy = -L * 0.92 - headR * 0.4;
    ctx.fillStyle = G_SKIN;
    ctx.beginPath();
    ctx.ellipse(0, headPy, headR * 1.15, headR * 1.35, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.05; ctx.stroke();
    // head shading (deep teal)
    ctx.fillStyle = 'rgba(0,48,73,0.42)';
    ctx.beginPath();
    ctx.ellipse(0.10 * sc, headPy + 0.10 * sc, headR * 0.82, headR * 0.95, 0, 0, TAU);
    ctx.fill();
    // top cream sheen
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.ellipse(-0.08 * sc, headPy - 0.13 * sc, headR * 0.42, headR * 0.22, 0, 0, TAU);
    ctx.fill();
    // gold studs around the head (5 visible)
    ctx.fillStyle = G_GOLD;
    const studs = [
      [0, -headR * 0.95], [-headR * 0.85, -headR * 0.15],
      [headR * 0.85, -headR * 0.15], [-headR * 0.45, headR * 0.55],
      [headR * 0.45, headR * 0.55],
    ];
    for (const [sx_, sy_] of studs) {
      ctx.beginPath();
      ctx.arc(sx_, headPy + sy_, 0.060 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    }
    // iron rivet ring around the equator
    ctx.strokeStyle = 'rgba(0,48,73,0.85)';
    ctx.lineWidth = 0.028 * sc;
    ctx.beginPath();
    ctx.ellipse(0, headPy, headR * 0.95, headR * 0.30, 0, 0, TAU);
    ctx.stroke();
    // impact glow on the head at the strike moment
    if (strikePop > 0.05) {
      ctx.fillStyle = `rgba(255,250,210,${0.9 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, headPy, 0.42 * sc * strikePop, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.7 * strikePop})`;
      ctx.beginPath();
      ctx.arc(0, headPy, 0.18 * sc * strikePop, 0, TAU);
      ctx.fill();
    }
  };

  // ── beard helpers ──────────────────────────────────────────────────────
  // Big braided blond beard — central mass + braid grooves + gold rings.
  const drawBeardFront = (cx) => {
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.moveTo(cx - 0.34 * sc, headY + 0.18 * sc);
    ctx.quadraticCurveTo(cx - 0.46 * sc + beardSway * 0.4, headY + 0.50 * sc,
                         cx - 0.22 * sc + beardSway, headY + 0.84 * sc);
    ctx.quadraticCurveTo(cx + beardSway * 0.6, headY + 0.96 * sc,
                         cx + 0.22 * sc + beardSway, headY + 0.84 * sc);
    ctx.quadraticCurveTo(cx + 0.46 * sc + beardSway * 0.4, headY + 0.50 * sc,
                         cx + 0.34 * sc, headY + 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
    // braid grooves
    ctx.strokeStyle = G_GOLD_LO;
    ctx.lineWidth = 0.045 * sc;
    ctx.beginPath();
    ctx.moveTo(cx - 0.12 * sc + beardSway * 0.5, headY + 0.30 * sc);
    ctx.lineTo(cx - 0.09 * sc + beardSway, headY + 0.80 * sc);
    ctx.moveTo(cx + 0.12 * sc + beardSway * 0.5, headY + 0.30 * sc);
    ctx.lineTo(cx + 0.09 * sc + beardSway, headY + 0.80 * sc);
    ctx.stroke();
    // gold rings along the braids
    ctx.fillStyle = G_GOLD_HI;
    const rings = [[-0.10, 0.50], [-0.09, 0.70], [0.10, 0.50], [0.09, 0.70]];
    for (const [bx, by] of rings) {
      ctx.beginPath();
      ctx.arc(cx + bx * sc + beardSway * 0.6, headY + by * sc, 0.044 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.020 * sc; ctx.stroke();
    }
    // central ring (biggest)
    ctx.fillStyle = G_GOLD_HI;
    ctx.beginPath();
    ctx.arc(cx + beardSway * 0.4, headY + 0.62 * sc, 0.062 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
    // highlight strands
    ctx.strokeStyle = 'rgba(255,217,122,0.7)';
    ctx.lineWidth = 0.020 * sc;
    ctx.beginPath();
    ctx.moveTo(cx - 0.24 * sc, headY + 0.32 * sc);
    ctx.lineTo(cx - 0.12 * sc + beardSway, headY + 0.78 * sc);
    ctx.moveTo(cx + 0.24 * sc, headY + 0.32 * sc);
    ctx.lineTo(cx + 0.12 * sc + beardSway, headY + 0.78 * sc);
    ctx.stroke();
  };

  // Side-profile beard hangs forward off the chin.
  const drawBeardSide = () => {
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.moveTo(-0.06 * sc, headY + 0.18 * sc);
    ctx.quadraticCurveTo(0.22 * sc + beardSway * 0.7, headY + 0.42 * sc,
                         0.18 * sc + beardSway, headY + 0.82 * sc);
    ctx.quadraticCurveTo(0.06 * sc + beardSway, headY + 0.92 * sc,
                         -0.04 * sc + beardSway * 0.4, headY + 0.82 * sc);
    ctx.quadraticCurveTo(-0.12 * sc, headY + 0.50 * sc, -0.06 * sc, headY + 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
    // single braid groove
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.045 * sc;
    ctx.beginPath();
    ctx.moveTo(0.06 * sc + beardSway * 0.5, headY + 0.30 * sc);
    ctx.lineTo(0.08 * sc + beardSway, headY + 0.78 * sc);
    ctx.stroke();
    // stacked gold rings
    ctx.fillStyle = G_GOLD_HI;
    for (const by of [0.42, 0.60, 0.76]) {
      ctx.beginPath();
      ctx.arc(0.07 * sc + beardSway * 0.6, headY + by * sc, 0.046 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.020 * sc; ctx.stroke();
    }
  };

  // ── face features (heavy brow + open human eyes + broad nose) ──────────
  // Was: dark slit eyes (read as "ogre/brute"). Now: clear white sclera +
  // dark iris, heavy angled brows, broad nose — a beefy barbarian human.
  const drawFaceSide = () => {
    // brow ridge shadow
    ctx.fillStyle = G_SKIN_SH;
    ctx.beginPath();
    ctx.moveTo(-0.18 * sc, headY - 0.04 * sc);
    ctx.lineTo(0.24 * sc, headY - 0.04 * sc);
    ctx.lineTo(0.22 * sc, headY + 0.02 * sc);
    ctx.lineTo(-0.18 * sc, headY + 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    // eye — sclera + iris + catchlight
    const ex = 0.16 * sc, ey = headY + 0.10 * sc;
    ctx.fillStyle = '#f5eee8';
    ctx.beginPath();
    ctx.ellipse(ex, ey, 0.055 * sc, 0.030 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = 0.020 * sc; ctx.stroke();
    ctx.fillStyle = '#3a2410';
    ctx.beginPath();
    ctx.arc(ex + 0.010 * sc, ey + 0.005 * sc, 0.024 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.85 + strikePop * 0.15})`;
    ctx.beginPath();
    ctx.arc(ex + 0.020 * sc, ey - 0.004 * sc, 0.012 * sc, 0, TAU);
    ctx.fill();
    // angry brow above (downward-angled toward nose)
    ctx.strokeStyle = '#3a2410';
    ctx.lineWidth = 0.035 * sc;
    ctx.beginPath();
    ctx.moveTo(0.06 * sc, ey - 0.075 * sc);
    ctx.lineTo(0.24 * sc, ey - 0.040 * sc);
    ctx.stroke();
    // broad nose / cheekbone wedge
    ctx.fillStyle = G_SKIN_SH;
    ctx.beginPath();
    ctx.moveTo(0.30 * sc, headY + 0.13 * sc);
    ctx.lineTo(0.38 * sc, headY + 0.18 * sc);
    ctx.lineTo(0.30 * sc, headY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    // war-paint stripe across the cheek (team-tinted)
    ctx.fillStyle = TEAM;
    ctx.fillRect(0.02 * sc, headY + 0.18 * sc, 0.22 * sc, 0.030 * sc);
  };

  const drawFaceFront = (cx) => {
    // brow ridge shadow
    ctx.fillStyle = G_SKIN_SH;
    rr(ctx, cx - 0.28 * sc, headY - 0.02 * sc, 0.56 * sc, 0.050 * sc, 0.020 * sc);
    ctx.fill();
    // eyes — sclera + iris + catchlight, both sides
    for (const dx of [-0.15, 0.15]) {
      const ex = cx + dx * sc, ey = headY + 0.10 * sc;
      ctx.fillStyle = '#f5eee8';
      ctx.beginPath();
      ctx.ellipse(ex, ey, 0.050 * sc, 0.028 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = 0.018 * sc; ctx.stroke();
      ctx.fillStyle = '#3a2410';
      ctx.beginPath();
      ctx.arc(ex, ey + 0.005 * sc, 0.024 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.85 + strikePop * 0.15})`;
      ctx.beginPath();
      ctx.arc(ex + 0.010 * sc, ey - 0.004 * sc, 0.012 * sc, 0, TAU);
      ctx.fill();
    }
    // angry brows: angled down toward the nose (V-shape)
    ctx.strokeStyle = '#3a2410';
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(cx - 0.22 * sc, headY + 0.025 * sc);
    ctx.lineTo(cx - 0.08 * sc, headY + 0.060 * sc);
    ctx.moveTo(cx + 0.22 * sc, headY + 0.025 * sc);
    ctx.lineTo(cx + 0.08 * sc, headY + 0.060 * sc);
    ctx.stroke();
    // broad nose
    ctx.fillStyle = G_SKIN_SH;
    ctx.beginPath();
    ctx.moveTo(cx - 0.05 * sc, headY + 0.13 * sc);
    ctx.lineTo(cx + 0.05 * sc, headY + 0.13 * sc);
    ctx.lineTo(cx, headY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    // war-paint stripe across cheekbones (team-tinted)
    ctx.fillStyle = TEAM;
    ctx.fillRect(cx - 0.32 * sc, headY + 0.13 * sc, 0.64 * sc, 0.030 * sc);
  };

  // ── head dome (bald, with a tied top-knot of golden hair) ──────────────
  const drawHeadDome = (cx, isBack) => {
    const hg = ctx.createRadialGradient(cx - 0.10 * sc, headY - 0.12 * sc, 0.04 * sc,
                                        cx, headY, 0.42 * sc);
    hg.addColorStop(0, G_SKIN_HI);
    hg.addColorStop(0.65, G_SKIN);
    hg.addColorStop(1, G_SKIN_SH);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(cx, headY + 0.04 * sc, 0.38 * sc, 0.44 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15; ctx.stroke();
    // cream specular streak
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.ellipse(cx - 0.18 * sc, headY - 0.18 * sc, 0.12 * sc, 0.06 * sc, -0.4, 0, TAU);
    ctx.fill();
    // back-side shadow (team neutral, deep teal)
    ctx.fillStyle = 'rgba(0,48,73,0.30)';
    ctx.beginPath();
    ctx.ellipse(cx + (isBack ? 0 : 0.10 * sc), headY + 0.14 * sc, 0.30 * sc, 0.22 * sc, 0, 0, TAU);
    ctx.fill();
    // top-knot of blond hair tied with a gold band
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.ellipse(cx - 0.02 * sc, headY - 0.42 * sc, 0.13 * sc, 0.18 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.75; ctx.stroke();
    ctx.fillStyle = G_GOLD_LO;
    ctx.beginPath();
    ctx.ellipse(cx + 0.04 * sc, headY - 0.36 * sc, 0.07 * sc, 0.10 * sc, 0.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = G_GOLD_HI;
    rr(ctx, cx - 0.11 * sc, headY - 0.30 * sc, 0.18 * sc, 0.055 * sc, 0.018 * sc);
    ctx.fill();
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.020 * sc; ctx.stroke();
  };

  // Common arm angles for the overhead-slam. Side view uses a wider arc.
  const restAng_S = -Math.PI * 0.72;
  const windAng_S = -Math.PI * 0.53;
  const hitAng_S  =  Math.PI * 0.32;
  let armAng_S;
  if (p.atk > 0) {
    if (s < 0.22)      armAng_S = lerp(restAng_S, windAng_S, easeOut(s / 0.22));
    else if (s < 0.62) armAng_S = lerp(windAng_S, hitAng_S, easeOut((s - 0.22) / 0.40));
    else               armAng_S = lerp(hitAng_S, restAng_S, easeInOut((s - 0.62) / 0.38));
  } else {
    armAng_S = restAng_S;
  }

  // Front / back view arms swing OVER the head — chop straight down in front.
  const restAng_F = -Math.PI / 2 + 0.30;
  const windAng_F = -Math.PI / 2 - 0.30;
  const hitAng_F  =  Math.PI / 2 + 0.10;
  let armAng_F;
  if (p.atk > 0) {
    if (s < 0.22)      armAng_F = lerp(restAng_F, windAng_F, easeOut(s / 0.22));
    else if (s < 0.62) armAng_F = lerp(windAng_F, hitAng_F, easeOut((s - 0.22) / 0.40));
    else               armAng_F = lerp(hitAng_F, restAng_F, easeInOut((s - 0.62) / 0.38));
  } else {
    armAng_F = restAng_F;
  }

  // ── SIDE VIEW ──────────────────────────────────────────────────────────
  if (p.view === 'side') {
    const legSpread = 0.30 * sc;
    const legSwing  = sw * 0.34 * sc * p.moving;
    const drawSideLeg = (side, swingX, isBack) => {
      const hipX     = side * legSpread;
      const footX    = side * legSpread + swingX;
      const kneeBend = side * legSpread + swingX * 0.55;
      const kneeY    = (hipY + baseY) * 0.5 + Math.abs(swingX) * 0.10;
      // bare thigh (skin)
      ctx.fillStyle = isBack ? G_SKIN_SH : G_SKIN;
      capsule(ctx, hipX, hipY + 0.02 * sc, kneeBend, kneeY, 0.24 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // shin
      ctx.fillStyle = isBack ? G_SKIN_SH : G_SKIN;
      capsule(ctx, kneeBend, kneeY, footX, baseY - 0.02 * sc, 0.20 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // knee highlight
      if (!isBack) {
        ctx.fillStyle = G_SKIN_HI;
        ctx.beginPath();
        ctx.arc(kneeBend - 0.05 * sc, kneeY - 0.04 * sc, 0.07 * sc, 0, TAU);
        ctx.fill();
      }
      // calf shadow band (cel-shade)
      ctx.fillStyle = 'rgba(0,48,73,0.22)';
      capsule(ctx, kneeBend + 0.04 * sc, kneeY + 0.06 * sc,
                   footX + 0.04 * sc, baseY - 0.06 * sc, 0.10 * sc);
      ctx.fill();
      // sandal wrap (cream with dark cross-bindings)
      ctx.fillStyle = G_CREAM;
      rr(ctx, footX - 0.30 * sc, baseY - 0.20 * sc, 0.60 * sc, 0.20 * sc, 0.07 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.strokeStyle = OL; ctx.lineWidth = 0.024 * sc;
      ctx.beginPath();
      ctx.moveTo(footX - 0.20 * sc, baseY - 0.20 * sc);
      ctx.lineTo(footX + 0.06 * sc, baseY - 0.02 * sc);
      ctx.moveTo(footX + 0.12 * sc, baseY - 0.20 * sc);
      ctx.lineTo(footX - 0.12 * sc, baseY - 0.02 * sc);
      ctx.stroke();
      // foot-plant dust
      const plantA = Math.max(0, (isBack ? -sw : sw)) * p.moving;
      if (plantA > 0.15) {
        ctx.fillStyle = `rgba(170,150,120,${0.32 * plantA})`;
        ctx.beginPath();
        ctx.ellipse(footX - 0.12 * sc * (isBack ? -1 : 1), baseY + 0.02 * sc,
                    0.55 * sc * plantA, 0.14 * sc * plantA, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawSideLeg(-1, -legSwing, true);

    // Back kilt panel (behind front leg, draped lower).
    {
      const ky0 = hipY + 0.06 * sc;
      const kyB = baseY - 0.35 * sc;
      ctx.fillStyle = G_RED_LO;
      ctx.beginPath();
      ctx.moveTo(-0.42 * sc, ky0);
      ctx.lineTo(-0.46 * sc, kyB);
      ctx.quadraticCurveTo(-0.20 * sc, kyB + 0.04 * sc, 0.22 * sc, kyB);
      ctx.lineTo(0.42 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    }

    // Bare-chested torso (big slabs of muscle, cel-shaded skin).
    ctx.beginPath();
    ctx.moveTo(-0.46 * sc, shoY);
    ctx.quadraticCurveTo(-0.56 * sc, (shoY + hipY) * 0.5, -0.40 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.64 * sc, (shoY + hipY) * 0.5, 0.56 * sc, shoY);
    ctx.quadraticCurveTo(0.10 * sc, shoY - 0.24 * sc, -0.46 * sc, shoY);
    ctx.closePath();
    const tg = ctx.createLinearGradient(0, shoY, 0, hipY);
    tg.addColorStop(0, G_SKIN_HI);
    tg.addColorStop(0.5, G_SKIN);
    tg.addColorStop(1, G_SKIN_SH);
    ctx.fillStyle = tg;
    ctx.fill();
    // back-side shadow band
    ctx.fillStyle = 'rgba(0,48,73,0.30)';
    ctx.beginPath();
    ctx.moveTo(-0.46 * sc, shoY);
    ctx.quadraticCurveTo(-0.56 * sc, (shoY + hipY) * 0.5, -0.40 * sc, hipY);
    ctx.lineTo(-0.18 * sc, hipY);
    ctx.lineTo(-0.10 * sc, shoY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15;
    ctx.beginPath();
    ctx.moveTo(-0.46 * sc, shoY);
    ctx.quadraticCurveTo(-0.56 * sc, (shoY + hipY) * 0.5, -0.40 * sc, hipY);
    ctx.lineTo(0.46 * sc, hipY);
    ctx.quadraticCurveTo(0.64 * sc, (shoY + hipY) * 0.5, 0.56 * sc, shoY);
    ctx.quadraticCurveTo(0.10 * sc, shoY - 0.24 * sc, -0.46 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // pec centerline
    ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.036 * sc;
    ctx.beginPath();
    ctx.moveTo(0.12 * sc, shoY + 0.04 * sc);
    ctx.lineTo(0.06 * sc, hipY - 0.10 * sc);
    ctx.stroke();
    // ab cuts (three short arcs)
    for (let i = 0; i < 3; i++) {
      const ay = lerp(shoY + 0.55 * sc, hipY - 0.06 * sc, i / 2);
      ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.026 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.02 * sc, ay);
      ctx.quadraticCurveTo(0.04 * sc, ay - 0.02 * sc, 0.22 * sc, ay - 0.02 * sc);
      ctx.stroke();
    }
    // war-paint diagonal stripe across chest (team-tinted)
    ctx.fillStyle = TEAM;
    ctx.beginPath();
    ctx.moveTo(-0.34 * sc, shoY + 0.12 * sc);
    ctx.lineTo(0.42 * sc, shoY + 0.28 * sc);
    ctx.lineTo(0.42 * sc, shoY + 0.36 * sc);
    ctx.lineTo(-0.34 * sc, shoY + 0.20 * sc);
    ctx.closePath();
    ctx.fill();

    // Belt (dark teal-blue leather) + gold buckle with team gem.
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.48 * sc, hipY - 0.05 * sc, 0.96 * sc, 0.18 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    // belt stitching highlights
    ctx.strokeStyle = G_DARK_D; ctx.lineWidth = 0.018 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.46 * sc, hipY + 0.10 * sc);
    ctx.lineTo(0.46 * sc, hipY + 0.10 * sc);
    ctx.stroke();
    // buckle (gold square with team-tinted gem)
    ctx.fillStyle = G_GOLD;
    rr(ctx, 0.06 * sc, hipY - 0.07 * sc, 0.24 * sc, 0.22 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
    ctx.fillStyle = TEAM_HI;
    ctx.beginPath();
    ctx.arc(0.18 * sc, hipY + 0.04 * sc, 0.060 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = 0.020 * sc; ctx.stroke();

    // Front kilt panel (red, pleated, with gold trim & dark hem).
    {
      const ky0 = hipY + 0.06 * sc;
      const kyB = baseY - 0.35 * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-0.40 * sc, ky0);
      ctx.lineTo(-0.44 * sc, kyB);
      ctx.quadraticCurveTo(0, kyB + 0.06 * sc, 0.44 * sc, kyB);
      ctx.lineTo(0.40 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // bright pleat
      ctx.fillStyle = G_RED_HI;
      ctx.beginPath();
      ctx.moveTo(0.10 * sc, ky0 + 0.04 * sc);
      ctx.lineTo(0.08 * sc, kyB - 0.04 * sc);
      ctx.lineTo(0.28 * sc, kyB - 0.06 * sc);
      ctx.lineTo(0.32 * sc, ky0 + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      // shadow pleat
      ctx.fillStyle = G_RED_LO;
      ctx.beginPath();
      ctx.moveTo(-0.40 * sc, ky0 + 0.04 * sc);
      ctx.lineTo(-0.42 * sc, kyB - 0.04 * sc);
      ctx.lineTo(-0.20 * sc, kyB - 0.06 * sc);
      ctx.lineTo(-0.18 * sc, ky0 + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      // pleat lines (subtle dark divisions)
      ctx.strokeStyle = G_RED_LO; ctx.lineWidth = 0.026 * sc;
      for (let i = 0; i < 4; i++) {
        const px = lerp(-0.36, 0.36, i / 3) * sc;
        ctx.beginPath();
        ctx.moveTo(px, ky0 + 0.04 * sc);
        ctx.lineTo(px * 1.08, kyB - 0.04 * sc);
        ctx.stroke();
      }
      // gold trim at the waist
      ctx.fillStyle = G_GOLD;
      ctx.fillRect(-0.42 * sc, ky0 + 0.02 * sc, 0.84 * sc, 0.028 * sc);
      // dark hem (cracked leather)
      ctx.fillStyle = G_DARK;
      ctx.beginPath();
      ctx.moveTo(-0.44 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.44 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.44 * sc, kyB - 0.02 * sc);
      ctx.quadraticCurveTo(0, kyB + 0.04 * sc, -0.44 * sc, kyB - 0.02 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // Front (near) leg over the kilt.
    drawSideLeg(1, legSwing, false);

    // Back pauldron (gold-rimmed, smaller, behind shoulder).
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.arc(-0.44 * sc, shoY - 0.02 * sc, 0.24 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.fillStyle = G_GOLD_HI;
    ctx.beginPath();
    ctx.arc(-0.48 * sc, shoY - 0.10 * sc, 0.09 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,48,73,0.40)';
    ctx.beginPath();
    ctx.arc(-0.40 * sc, shoY + 0.06 * sc, 0.16 * sc, 0, TAU);
    ctx.fill();

    // Head (skin dome + top-knot) and beard.
    const hx = 0.14 * sc;
    drawHeadDome(hx, false);
    // ear
    ctx.fillStyle = G_SKIN_SH;
    ctx.beginPath();
    ctx.ellipse(-0.20 * sc, headY + 0.12 * sc, 0.06 * sc, 0.10 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    drawFaceSide();
    drawBeardSide();
    // idle breath puff at mouth
    if (p.moving < 0.05) {
      const bP = Math.sin(p.t * 1.3 + p.phase);
      if (bP > 0.80) {
        const bF = (bP - 0.80) / 0.20;
        ctx.fillStyle = `rgba(255,255,255,${0.55 * bF})`;
        ctx.beginPath();
        ctx.ellipse(0.36 * sc + bF * 0.10 * sc, headY + 0.22 * sc,
                    0.10 * sc * bF, 0.06 * sc * bF, 0, 0, TAU);
        ctx.fill();
      }
    }

    // ── near arm + two-handed club grip ──────────────────────────────────
    // Hand position is driven by armAng_S; the arm reaches up over shoulder
    // toward the club shaft. The far hand grips the shaft lower.
    const shX = 0.20 * sc, shYY = shoY + 0.20 * sc;
    const handR = 0.78 * sc;
    const handX = shX + Math.cos(armAng_S) * handR;
    const handY = shYY + Math.sin(armAng_S) * handR;
    const farShX = -0.12 * sc, farShYY = shoY + 0.22 * sc;
    const farHandX = handX - Math.cos(armAng_S) * 0.22 * sc;
    const farHandY = handY - Math.sin(armAng_S) * 0.22 * sc;

    // far upper arm (drawn behind, shadow side)
    ctx.fillStyle = G_SKIN_SH;
    capsule(ctx, farShX, farShYY, farHandX, farHandY, 0.18 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // far wrist wrap
    ctx.save();
    ctx.translate(farHandX, farHandY);
    ctx.rotate(armAng_S);
    ctx.fillStyle = G_CREAM;
    rr(ctx, -0.14 * sc, -0.10 * sc, 0.24 * sc, 0.20 * sc, 0.05 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.restore();

    // motion smear arc + ghost clubs on strike
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAng_S, hitAng_S,
                              easeOut(Math.max(0, (s - 0.22) / 0.40 - 0.25)));
      ctx.strokeStyle = `rgba(255,255,255,${0.42 * swingPhase})`;
      ctx.lineWidth = 0.26 * sc;
      ctx.beginPath();
      ctx.arc(shX, shYY, handR + 0.3 * sc, trailStart, armAng_S, false);
      ctx.stroke();
      for (let i = 1; i <= 2; i++) {
        const t2 = i / 3;
        const gAng = lerp(armAng_S, trailStart, t2);
        const gHX = shX + Math.cos(gAng) * handR;
        const gHY = shYY + Math.sin(gAng) * handR;
        ctx.save();
        ctx.translate(gHX, gHY);
        ctx.rotate(gAng + Math.PI / 2);
        ctx.globalAlpha = 0.28 * (1 - t2) * swingPhase;
        drawClub();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // near upper arm (skin)
    ctx.fillStyle = G_SKIN;
    capsule(ctx, shX, shYY, handX, handY, 0.20 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // bicep highlight
    ctx.fillStyle = G_SKIN_HI;
    ctx.save();
    ctx.translate((shX + handX) / 2, (shYY + handY) / 2);
    ctx.rotate(armAng_S);
    ctx.beginPath();
    ctx.ellipse(-0.06 * sc, -0.04 * sc, 0.14 * sc, 0.06 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    // near wrist wrap (cream cloth)
    ctx.save();
    ctx.translate(handX, handY);
    ctx.rotate(armAng_S);
    ctx.fillStyle = G_CREAM;
    rr(ctx, -0.18 * sc, -0.13 * sc, 0.32 * sc, 0.26 * sc, 0.07 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    // dark wrap stripes
    ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.022 * sc;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.16 * sc, i * 0.080 * sc);
      ctx.lineTo(0.10 * sc, i * 0.080 * sc);
      ctx.stroke();
    }
    ctx.restore();
    // gold knuckle rings
    ctx.fillStyle = G_GOLD;
    for (let i = -1; i <= 1; i++) {
      const krX = handX + Math.cos(armAng_S) * (0.10 * sc + i * 0.04 * sc);
      const krY = handY + Math.sin(armAng_S) * (0.10 * sc + i * 0.04 * sc);
      ctx.beginPath();
      ctx.arc(krX, krY, 0.030 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.014 * sc; ctx.stroke();
    }

    // the club (drawn at the near-hand grip)
    ctx.save();
    ctx.translate(handX, handY);
    ctx.rotate(armAng_S + Math.PI / 2);
    drawClub();
    ctx.restore();

    // Front pauldron (drawn over the arm so it caps the shoulder properly).
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.arc(0.44 * sc, shoY + 0.02 * sc, 0.30 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.fillStyle = G_GOLD_HI;
    ctx.beginPath();
    ctx.arc(0.38 * sc, shoY - 0.10 * sc, 0.12 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,48,73,0.42)';
    ctx.beginPath();
    ctx.arc(0.50 * sc, shoY + 0.12 * sc, 0.20 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = TEAM_HI;
    ctx.beginPath();
    ctx.arc(0.44 * sc, shoY + 0.02 * sc, 0.060 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();

  // ── FRONT VIEW ─────────────────────────────────────────────────────────
  } else if (p.view === 'front') {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.06 * sc;
    ctx.translate(sway, 0);

    // alternating leg lifts
    const legSpreadF = 0.30 * sc;
    const liftL = Math.max(0, sw)  * 0.22 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.22 * sc * p.moving;
    const drawFrontLeg = (side, footLift) => {
      const x = side * legSpreadF;
      const footPt = baseY - footLift;
      // thigh + shin (one big bare leg capsule)
      ctx.fillStyle = G_SKIN;
      capsule(ctx, x, hipY + 0.02 * sc, x, footPt - 0.02 * sc, 0.26 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // shadow stripe down the outside
      ctx.fillStyle = 'rgba(0,48,73,0.22)';
      capsule(ctx, x + side * 0.10 * sc, hipY + 0.10 * sc,
                   x + side * 0.10 * sc, footPt - 0.10 * sc, 0.10 * sc);
      ctx.fill();
      // knee highlight
      const kY = (hipY + footPt) * 0.5;
      ctx.fillStyle = G_SKIN_HI;
      ctx.beginPath();
      ctx.arc(x - side * 0.05 * sc, kY - 0.04 * sc, 0.09 * sc, 0, TAU);
      ctx.fill();
      // sandal wrap
      ctx.fillStyle = G_CREAM;
      rr(ctx, x - 0.26 * sc, footPt - 0.20 * sc, 0.52 * sc, 0.22 * sc, 0.08 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // cross binding
      ctx.strokeStyle = OL; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(x - 0.18 * sc, footPt - 0.20 * sc);
      ctx.lineTo(x + 0.10 * sc, footPt - 0.02 * sc);
      ctx.moveTo(x + 0.10 * sc, footPt - 0.20 * sc);
      ctx.lineTo(x - 0.18 * sc, footPt - 0.02 * sc);
      ctx.stroke();
      // foot-plant dust on the grounded leg
      if (footLift < 0.02 * sc && p.moving > 0.2) {
        ctx.fillStyle = `rgba(170,150,120,${0.28 * p.moving})`;
        ctx.beginPath();
        ctx.ellipse(x, baseY + 0.02 * sc, 0.36 * sc, 0.10 * sc, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawFrontLeg(-1, liftL);
    drawFrontLeg(1, liftR);

    // Kilt covers hips down to mid-shin.
    {
      const ky0 = hipY + 0.04 * sc;
      const kyB = baseY - 0.30 * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-0.46 * sc, ky0);
      ctx.lineTo(-0.52 * sc, kyB);
      ctx.quadraticCurveTo(0, kyB + 0.10 * sc, 0.52 * sc, kyB);
      ctx.lineTo(0.46 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // pleats
      ctx.strokeStyle = G_RED_LO; ctx.lineWidth = 0.026 * sc;
      for (let i = 0; i < 5; i++) {
        const px = lerp(-0.42, 0.42, i / 4) * sc;
        ctx.beginPath();
        ctx.moveTo(px, ky0 + 0.04 * sc);
        ctx.lineTo(px * 1.12, kyB - 0.04 * sc);
        ctx.stroke();
      }
      // bright highlight on the left-side pleats
      ctx.fillStyle = G_RED_HI;
      ctx.beginPath();
      ctx.moveTo(-0.28 * sc, ky0 + 0.05 * sc);
      ctx.lineTo(-0.32 * sc, kyB - 0.04 * sc);
      ctx.lineTo(-0.12 * sc, kyB - 0.06 * sc);
      ctx.lineTo(-0.10 * sc, ky0 + 0.05 * sc);
      ctx.closePath();
      ctx.fill();
      // shadow on the right-side pleats
      ctx.fillStyle = G_RED_LO;
      ctx.beginPath();
      ctx.moveTo(0.18 * sc, ky0 + 0.05 * sc);
      ctx.lineTo(0.20 * sc, kyB - 0.04 * sc);
      ctx.lineTo(0.42 * sc, kyB - 0.06 * sc);
      ctx.lineTo(0.40 * sc, ky0 + 0.05 * sc);
      ctx.closePath();
      ctx.fill();
      // gold trim at waist
      ctx.fillStyle = G_GOLD;
      ctx.fillRect(-0.46 * sc, ky0 + 0.02 * sc, 0.92 * sc, 0.030 * sc);
      // dark hem (cracked-leather suggestion)
      ctx.fillStyle = G_DARK;
      ctx.beginPath();
      ctx.moveTo(-0.50 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.50 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.50 * sc, kyB - 0.02 * sc);
      ctx.quadraticCurveTo(0, kyB + 0.06 * sc, -0.50 * sc, kyB - 0.02 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // Big bare torso, facing camera.
    ctx.beginPath();
    ctx.moveTo(-0.54 * sc, shoY);
    ctx.quadraticCurveTo(-0.62 * sc, (shoY + hipY) * 0.5, -0.48 * sc, hipY);
    ctx.lineTo(0.48 * sc, hipY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.54 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.26 * sc, -0.54 * sc, shoY);
    ctx.closePath();
    const tgF = ctx.createLinearGradient(-0.54 * sc, shoY, 0.54 * sc, hipY);
    tgF.addColorStop(0, G_SKIN_HI);
    tgF.addColorStop(0.5, G_SKIN);
    tgF.addColorStop(1, G_SKIN_SH);
    ctx.fillStyle = tgF;
    ctx.fill();
    // right-side shadow
    ctx.fillStyle = 'rgba(0,48,73,0.28)';
    ctx.beginPath();
    ctx.moveTo(0.54 * sc, shoY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.48 * sc, hipY);
    ctx.lineTo(0.18 * sc, hipY);
    ctx.lineTo(0.12 * sc, shoY - 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15;
    ctx.beginPath();
    ctx.moveTo(-0.54 * sc, shoY);
    ctx.quadraticCurveTo(-0.62 * sc, (shoY + hipY) * 0.5, -0.48 * sc, hipY);
    ctx.lineTo(0.48 * sc, hipY);
    ctx.quadraticCurveTo(0.62 * sc, (shoY + hipY) * 0.5, 0.54 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.26 * sc, -0.54 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // pec split
    ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.040 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY - 0.02 * sc);
    ctx.lineTo(0, hipY - 0.08 * sc);
    ctx.stroke();
    // pec under-curves
    ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.36 * sc, shoY + 0.34 * sc);
    ctx.quadraticCurveTo(-0.20 * sc, shoY + 0.50 * sc, -0.02 * sc, shoY + 0.42 * sc);
    ctx.moveTo(0.36 * sc, shoY + 0.34 * sc);
    ctx.quadraticCurveTo(0.20 * sc, shoY + 0.50 * sc, 0.02 * sc, shoY + 0.42 * sc);
    ctx.stroke();
    // ab cuts
    for (let i = 0; i < 3; i++) {
      const ay = lerp(shoY + 0.65 * sc, hipY - 0.06 * sc, i / 2);
      ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.028 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.18 * sc, ay);
      ctx.lineTo(0.18 * sc, ay);
      ctx.stroke();
    }
    // war-paint horizontal stripe (team-tinted)
    ctx.fillStyle = TEAM;
    ctx.fillRect(-0.40 * sc, shoY + 0.20 * sc, 0.80 * sc, 0.036 * sc);

    // Belt
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.50 * sc, hipY - 0.05 * sc, 1.00 * sc, 0.18 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.strokeStyle = G_DARK_D; ctx.lineWidth = 0.018 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.48 * sc, hipY + 0.10 * sc);
    ctx.lineTo(0.48 * sc, hipY + 0.10 * sc);
    ctx.stroke();
    // buckle + gem
    ctx.fillStyle = G_GOLD;
    rr(ctx, -0.12 * sc, hipY - 0.07 * sc, 0.24 * sc, 0.22 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
    ctx.fillStyle = TEAM_HI;
    ctx.beginPath();
    ctx.arc(0, hipY + 0.04 * sc, 0.060 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = 0.020 * sc; ctx.stroke();

    // Two gold-rimmed pauldrons (symmetric).
    for (const sgn of [-1, 1]) {
      const pcx = sgn * 0.54 * sc;
      ctx.fillStyle = G_GOLD;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.28 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = G_GOLD_HI;
      ctx.beginPath();
      ctx.arc(pcx - sgn * 0.08 * sc, shoY - 0.08 * sc, 0.11 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,48,73,0.40)';
      ctx.beginPath();
      ctx.arc(pcx + sgn * 0.05 * sc, shoY + 0.10 * sc, 0.18 * sc, 0, TAU);
      ctx.fill();
      // central rivet (team-tinted)
      ctx.fillStyle = TEAM_HI;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.060 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
    }

    // Idle / off-hand arm — hangs at the left side (viewer's left).
    {
      const ox = -0.46 * sc, oy = shoY + 0.20 * sc;
      const hx2 = -0.50 * sc + Math.cos(p.t * 0.6 + p.phase) * 0.02 * sc * (1 - p.moving);
      const hy2 = hipY + 0.10 * sc;
      ctx.fillStyle = G_SKIN;
      capsule(ctx, ox, oy, hx2, hy2, 0.20 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // shadow stripe
      ctx.fillStyle = 'rgba(0,48,73,0.22)';
      capsule(ctx, ox - 0.06 * sc, oy + 0.05 * sc, hx2 - 0.06 * sc, hy2 - 0.05 * sc, 0.08 * sc);
      ctx.fill();
      // wrist wrap + fist
      ctx.fillStyle = G_CREAM;
      rr(ctx, hx2 - 0.16 * sc, hy2 - 0.10 * sc, 0.30 * sc, 0.22 * sc, 0.07 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.020 * sc;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(hx2 - 0.14 * sc, hy2 + i * 0.06 * sc);
        ctx.lineTo(hx2 + 0.08 * sc, hy2 + i * 0.06 * sc);
        ctx.stroke();
      }
      // gold knuckles
      ctx.fillStyle = G_GOLD;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.arc(hx2 + i * 0.05 * sc, hy2 - 0.02 * sc, 0.025 * sc, 0, TAU);
        ctx.fill();
      }
    }

    // Club arm — sweeps overhead from rest → wind → slam.
    const swShXF = 0.42 * sc, swShYF = shoY + 0.10 * sc;
    const handR_F = 0.66 * sc;
    const cHandX = swShXF + Math.cos(armAng_F) * handR_F;
    const cHandY = swShYF + Math.sin(armAng_F) * handR_F;

    // motion smear arc + ghost clubs
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAng_F, hitAng_F,
                              easeOut(Math.max(0, (s - 0.22) / 0.40 - 0.25)));
      ctx.strokeStyle = `rgba(255,255,255,${0.42 * swingPhase})`;
      ctx.lineWidth = 0.26 * sc;
      ctx.beginPath();
      ctx.arc(swShXF, swShYF, handR_F + 0.3 * sc, trailStart, armAng_F, false);
      ctx.stroke();
      for (let i = 1; i <= 2; i++) {
        const t2 = i / 3;
        const gAng = lerp(armAng_F, trailStart, t2);
        const gHX = swShXF + Math.cos(gAng) * handR_F;
        const gHY = swShYF + Math.sin(gAng) * handR_F;
        ctx.save();
        ctx.translate(gHX, gHY);
        ctx.rotate(gAng + Math.PI / 2);
        ctx.globalAlpha = 0.28 * (1 - t2) * swingPhase;
        drawClub();
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
    // upper arm
    ctx.fillStyle = G_SKIN;
    capsule(ctx, swShXF, swShYF, cHandX, cHandY, 0.22 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // bicep cel-shade
    ctx.fillStyle = 'rgba(0,48,73,0.22)';
    capsule(ctx, swShXF + 0.10 * sc, swShYF + 0.06 * sc,
                 cHandX + 0.10 * sc * Math.cos(armAng_F + Math.PI / 2),
                 cHandY + 0.10 * sc * Math.sin(armAng_F + Math.PI / 2), 0.09 * sc);
    ctx.fill();
    // wrist wrap + knuckles
    ctx.save();
    ctx.translate(cHandX, cHandY);
    ctx.rotate(armAng_F);
    ctx.fillStyle = G_CREAM;
    rr(ctx, -0.18 * sc, -0.13 * sc, 0.32 * sc, 0.26 * sc, 0.07 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.022 * sc;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.16 * sc, i * 0.080 * sc);
      ctx.lineTo(0.10 * sc, i * 0.080 * sc);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = G_GOLD;
    for (let i = -1; i <= 1; i++) {
      const krX = cHandX + Math.cos(armAng_F) * (0.10 * sc + i * 0.04 * sc);
      const krY = cHandY + Math.sin(armAng_F) * (0.10 * sc + i * 0.04 * sc);
      ctx.beginPath();
      ctx.arc(krX, krY, 0.030 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.014 * sc; ctx.stroke();
    }

    // the club itself
    ctx.save();
    ctx.translate(cHandX, cHandY);
    ctx.rotate(armAng_F + Math.PI / 2);
    drawClub();
    ctx.restore();

    // Head + beard go last so they sit on top of the torso silhouette.
    const hxF = 0;
    drawHeadDome(hxF, false);
    drawFaceFront(hxF);
    drawBeardFront(hxF);
    // idle breath puff at the mouth
    if (p.moving < 0.05) {
      const bP = Math.sin(p.t * 1.3 + p.phase);
      if (bP > 0.80) {
        const bF = (bP - 0.80) / 0.20;
        ctx.fillStyle = `rgba(255,255,255,${0.50 * bF})`;
        ctx.beginPath();
        ctx.ellipse(hxF, headY + 0.30 * sc, 0.12 * sc * bF, 0.05 * sc * bF, 0, 0, TAU);
        ctx.fill();
      }
    }

  // ── BACK VIEW ──────────────────────────────────────────────────────────
  } else {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.06 * sc;
    ctx.translate(sway, 0);

    const legSpreadB = 0.30 * sc;
    const liftL = Math.max(0, sw)  * 0.20 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.20 * sc * p.moving;
    const drawBackLeg = (side, footLift) => {
      const x = side * legSpreadB;
      const footPt = baseY - footLift;
      ctx.fillStyle = G_SKIN_SH;
      capsule(ctx, x, hipY + 0.02 * sc, x, footPt - 0.02 * sc, 0.26 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // mid-tone calf
      ctx.fillStyle = G_SKIN;
      capsule(ctx, x, hipY + 0.30 * sc, x, footPt - 0.20 * sc, 0.12 * sc);
      ctx.fill();
      // sandal back
      ctx.fillStyle = G_CREAM;
      rr(ctx, x - 0.24 * sc, footPt - 0.18 * sc, 0.48 * sc, 0.20 * sc, 0.07 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.strokeStyle = OL; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(x - 0.18 * sc, footPt - 0.18 * sc);
      ctx.lineTo(x + 0.10 * sc, footPt - 0.02 * sc);
      ctx.moveTo(x + 0.10 * sc, footPt - 0.18 * sc);
      ctx.lineTo(x - 0.18 * sc, footPt - 0.02 * sc);
      ctx.stroke();
    };
    drawBackLeg(-1, liftL);
    drawBackLeg(1, liftR);

    // Kilt covering from behind.
    {
      const ky0 = hipY + 0.04 * sc;
      const kyB = baseY - 0.30 * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-0.48 * sc, ky0);
      ctx.lineTo(-0.54 * sc, kyB);
      ctx.quadraticCurveTo(0, kyB + 0.10 * sc, 0.54 * sc, kyB);
      ctx.lineTo(0.48 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // bright sash knot in back center
      ctx.fillStyle = G_RED_HI;
      ctx.beginPath();
      ctx.ellipse(0, ky0 + 0.04 * sc, 0.10 * sc, 0.06 * sc, 0, 0, TAU);
      ctx.fill();
      // pleats
      ctx.strokeStyle = G_RED_LO; ctx.lineWidth = 0.026 * sc;
      for (let i = 0; i < 5; i++) {
        const px = lerp(-0.42, 0.42, i / 4) * sc;
        ctx.beginPath();
        ctx.moveTo(px, ky0 + 0.04 * sc);
        ctx.lineTo(px * 1.12, kyB - 0.04 * sc);
        ctx.stroke();
      }
      // gold trim at waist
      ctx.fillStyle = G_GOLD;
      ctx.fillRect(-0.48 * sc, ky0 + 0.02 * sc, 0.96 * sc, 0.030 * sc);
      // dark hem
      ctx.fillStyle = G_DARK;
      ctx.beginPath();
      ctx.moveTo(-0.52 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.52 * sc, kyB - 0.08 * sc);
      ctx.lineTo(0.52 * sc, kyB - 0.02 * sc);
      ctx.quadraticCurveTo(0, kyB + 0.06 * sc, -0.52 * sc, kyB - 0.02 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // Big bare back.
    ctx.beginPath();
    ctx.moveTo(-0.56 * sc, shoY);
    ctx.quadraticCurveTo(-0.64 * sc, (shoY + hipY) * 0.5, -0.48 * sc, hipY);
    ctx.lineTo(0.48 * sc, hipY);
    ctx.quadraticCurveTo(0.64 * sc, (shoY + hipY) * 0.5, 0.56 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.24 * sc, -0.56 * sc, shoY);
    ctx.closePath();
    const tgB = ctx.createLinearGradient(0, shoY, 0, hipY);
    tgB.addColorStop(0, G_SKIN);
    tgB.addColorStop(0.5, G_SKIN);
    tgB.addColorStop(1, G_SKIN_SH);
    ctx.fillStyle = tgB;
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.15; ctx.stroke();
    // spine groove
    ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.040 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY - 0.02 * sc);
    ctx.lineTo(0, hipY - 0.04 * sc);
    ctx.stroke();
    // shoulder-blade muscle hints
    ctx.strokeStyle = G_SKIN_SH; ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.30 * sc, shoY + 0.20 * sc);
    ctx.quadraticCurveTo(-0.16 * sc, shoY + 0.32 * sc, -0.04 * sc, shoY + 0.20 * sc);
    ctx.moveTo(0.30 * sc, shoY + 0.20 * sc);
    ctx.quadraticCurveTo(0.16 * sc, shoY + 0.32 * sc, 0.04 * sc, shoY + 0.20 * sc);
    ctx.stroke();
    // war-paint stripe across the back (team-tinted)
    ctx.fillStyle = TEAM;
    ctx.fillRect(-0.42 * sc, shoY + 0.46 * sc, 0.84 * sc, 0.036 * sc);

    // Belt
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.50 * sc, hipY - 0.05 * sc, 1.00 * sc, 0.18 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();

    // Two gold-rimmed pauldrons.
    for (const sgn of [-1, 1]) {
      const pcx = sgn * 0.54 * sc;
      ctx.fillStyle = G_GOLD;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.28 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = G_GOLD_HI;
      ctx.beginPath();
      ctx.arc(pcx + sgn * 0.06 * sc, shoY - 0.10 * sc, 0.11 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,48,73,0.40)';
      ctx.beginPath();
      ctx.arc(pcx - sgn * 0.05 * sc, shoY + 0.12 * sc, 0.18 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = TEAM_HI;
      ctx.beginPath();
      ctx.arc(pcx, shoY + 0.02 * sc, 0.060 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.024 * sc; ctx.stroke();
    }

    // Off-hand arm hanging at the side.
    {
      const ox = -0.48 * sc, oy = shoY + 0.22 * sc;
      const hx2 = -0.52 * sc, hy2 = hipY + 0.08 * sc;
      ctx.fillStyle = G_SKIN_SH;
      capsule(ctx, ox, oy, hx2, hy2, 0.20 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = G_CREAM;
      rr(ctx, hx2 - 0.16 * sc, hy2 - 0.10 * sc, 0.30 * sc, 0.22 * sc, 0.07 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    }

    // Club arm — overhead chop visible from behind.
    const swShXB = 0.42 * sc, swShYB = shoY + 0.10 * sc;
    const handR_B = 0.66 * sc;
    const bHandX = swShXB + Math.cos(armAng_F) * handR_B;
    const bHandY = swShYB + Math.sin(armAng_F) * handR_B;
    // motion smear
    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAng_F, hitAng_F,
                              easeOut(Math.max(0, (s - 0.22) / 0.40 - 0.25)));
      ctx.strokeStyle = `rgba(255,255,255,${0.36 * swingPhase})`;
      ctx.lineWidth = 0.24 * sc;
      ctx.beginPath();
      ctx.arc(swShXB, swShYB, handR_B + 0.3 * sc, trailStart, armAng_F, false);
      ctx.stroke();
    }
    ctx.fillStyle = G_SKIN;
    capsule(ctx, swShXB, swShYB, bHandX, bHandY, 0.22 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // wrist wrap
    ctx.save();
    ctx.translate(bHandX, bHandY);
    ctx.rotate(armAng_F);
    ctx.fillStyle = G_CREAM;
    rr(ctx, -0.18 * sc, -0.13 * sc, 0.32 * sc, 0.26 * sc, 0.07 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.restore();
    // gold knuckle rings
    ctx.fillStyle = G_GOLD;
    for (let i = -1; i <= 1; i++) {
      const krX = bHandX + Math.cos(armAng_F) * (0.10 * sc + i * 0.04 * sc);
      const krY = bHandY + Math.sin(armAng_F) * (0.10 * sc + i * 0.04 * sc);
      ctx.beginPath();
      ctx.arc(krX, krY, 0.030 * sc, 0, TAU);
      ctx.fill();
    }
    // club — visible when overhead (during rest/wind/early strike); occluded
    // by body silhouette once it crosses below the shoulder.
    if (bHandY < swShYB + 0.05 * sc || (swingPhase > 0 && swingPhase < 1)) {
      ctx.save();
      ctx.translate(bHandX, bHandY);
      ctx.rotate(armAng_F + Math.PI / 2);
      drawClub();
      ctx.restore();
    }

    // Head from behind: bald with top-knot.
    const hxB = 0;
    drawHeadDome(hxB, true);
    // back-of-head detail (no face, just shape + top-knot already drawn).
    // A subtle hair stubble line at the base of the skull.
    ctx.strokeStyle = G_GOLD_LO; ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(hxB - 0.20 * sc, headY + 0.30 * sc);
    ctx.lineTo(hxB + 0.20 * sc, headY + 0.30 * sc);
    ctx.stroke();
    // braided back-beard tip just peeking past the jawline
    ctx.fillStyle = G_GOLD;
    ctx.beginPath();
    ctx.ellipse(hxB + 0.18 * sc * Math.cos(beardSway * 0.5 + 0.2),
                headY + 0.46 * sc, 0.10 * sc, 0.07 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
  }

  // ── full-figure hit flash ──────────────────────────────────────────────
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.55 * p.flash})`;
    rr(ctx, -0.85 * sc, headY - 0.60 * sc,
            1.70 * sc, (baseY - headY) + 0.80 * sc, 0.32 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
  return true;
}

export function markGiant(id) {
  const a = anim.get(id);
  if (a) a.wasGiant = true;
}

// ── Archer palette ─────────────────────────────────────────────────────────
// Spec-supplied core five: dark teal #006d77, mint/sage #83c5be, near-white
// #edf6f9, peach skin #ffddd2, terracotta leather/wood #e29578. Plus a
// derived deeper peach, a darker leather, a mint highlight, and a small red
// fletching accent — all explicitly used as "1-2 derived shades" per spec.
const A_DARK      = '#006d77';
const A_DARK_D    = '#004f57';   // derived: deeper teal (hood interior)
const A_MINT      = '#83c5be';
const A_MINT_HI   = '#a7d5cf';   // derived: lighter mint (highlights)
const A_LIGHT     = '#edf6f9';
const A_SKIN      = '#ffddd2';
const A_SKIN_SH   = '#e8a89b';   // derived: deeper peach (shading)
const A_LEATHER   = '#e29578';
const A_LEATHER_D = '#b86a4d';   // derived: darker leather (shadows)
const A_RED       = '#bc4749';   // small red fletching accent
const A_OL        = '#0a2c2f';   // outline: very dark teal-black

// Self-contained wooden arrow, oriented along `ang`. Travels along local +x.
// Used both by the in-flight projectile renderer (renderer.js -> drawArrow)
// and by drawArcher for the nocked arrow when at rest / winding up.
//   opts.motion (bool) — draw a faint white speed streak behind the shaft.
//   opts.alpha  (num)  — overall alpha multiplier (default 1).
export function drawArrow(ctx, x, y, ang, tile, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;
  const L = tile * 0.7;
  const W = tile * 0.06;
  const tipL = tile * 0.18;
  const tipW = tile * 0.11;
  const fX = -L * 0.5;
  const flL = tile * 0.20;
  const flW = tile * 0.13;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // Motion-blur streak (semi-transparent white tapering line behind butt).
  if (opts.motion) {
    const tailL = tile * 1.25;
    const grad = ctx.createLinearGradient(fX - tailL, 0, fX, 0);
    grad.addColorStop(0, `rgba(237,246,249,0)`);
    grad.addColorStop(1, `rgba(237,246,249,${0.55 * alpha})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(fX - tailL, -W * 0.18);
    ctx.lineTo(fX, -W * 0.55);
    ctx.lineTo(fX, W * 0.55);
    ctx.lineTo(fX - tailL, W * 0.18);
    ctx.closePath();
    ctx.fill();
  }

  // Wooden shaft (terracotta mid + darker underside cel-shade).
  ctx.fillStyle = `rgba(226,149,120,${alpha})`;
  ctx.fillRect(fX, -W * 0.5, L, W);
  ctx.fillStyle = `rgba(184,106,77,${0.95 * alpha})`;
  ctx.fillRect(fX, W * 0.10, L, W * 0.40);
  ctx.fillStyle = `rgba(237,246,249,${0.55 * alpha})`;
  ctx.fillRect(fX, -W * 0.45, L, W * 0.12);
  ctx.strokeStyle = `rgba(10,44,47,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.020);
  ctx.strokeRect(fX, -W * 0.5, L, W);

  // Iron arrowhead (steel-gray triangle with a bright highlight).
  const tipBase = L * 0.5 - tipL;
  const tipTip  = L * 0.5 + tile * 0.06;
  ctx.fillStyle = `rgba(154,160,173,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(tipBase, -tipW * 0.5);
  ctx.lineTo(tipTip, 0);
  ctx.lineTo(tipBase, tipW * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(10,44,47,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.022);
  ctx.stroke();
  // Steel highlight along the upper edge of the head.
  ctx.fillStyle = `rgba(237,246,249,${0.85 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(tipBase + tile * 0.01, -tipW * 0.42);
  ctx.lineTo(tipTip - tile * 0.02, -tipW * 0.06);
  ctx.lineTo(tipBase + tipL * 0.55, -tipW * 0.18);
  ctx.closePath();
  ctx.fill();
  // Tiny dark socket where the head meets the shaft.
  ctx.fillStyle = `rgba(10,44,47,${0.80 * alpha})`;
  ctx.fillRect(tipBase - tile * 0.015, -W * 0.55, tile * 0.030, W * 1.10);

  // Fletching — two/three feathers at the butt (cream top, red bottom, +
  // a small mid feather peeking when viewed in profile).
  // Top feather (cream).
  ctx.fillStyle = `rgba(237,246,249,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + tile * 0.05, -W * 0.30);
  ctx.lineTo(fX - flL, -flW * 0.55);
  ctx.lineTo(fX - flL * 0.20, -flW * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(10,44,47,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.016);
  ctx.stroke();
  // Mid feather (small terracotta sliver, only visible when viewed at this
  // angle — gives the arrow a 3-feather impression in side profile).
  ctx.fillStyle = `rgba(184,106,77,${0.95 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + tile * 0.04, 0);
  ctx.lineTo(fX - flL * 0.85, 0);
  ctx.lineTo(fX - flL * 0.25, W * 0.20);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Bottom feather (red).
  ctx.fillStyle = `rgba(188,71,73,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + tile * 0.05, W * 0.30);
  ctx.lineTo(fX - flL, flW * 0.55);
  ctx.lineTo(fX - flL * 0.20, flW * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Nock at the very back (small dark notch).
  ctx.fillStyle = `rgba(10,44,47,${alpha})`;
  ctx.fillRect(fX - tile * 0.02, -W * 0.45, tile * 0.04, W * 0.90);
  ctx.fillStyle = `rgba(237,246,249,${0.6 * alpha})`;
  ctx.fillRect(fX - tile * 0.015, -W * 0.20, tile * 0.030, W * 0.10);

  ctx.restore();
}

// Polished 2.5D Archer — a hooded female elven ranger with a curved bow.
// Slimmer and ~10% shorter than the Knight. View-aware (side / front / back)
// with a three-phase nock → draw → release attack; cloak flutters and the
// hood drops a soft shadow across the face from which a single teal eye-glow
// peeks. Idle breathing, hood sway, occasional blink, spawn rune ring,
// hit-flash and a smaller cloth/feather death poof complete the rig.
export function drawArcher(ctx, gx, gy, tile, p) {
  const S = tile * 0.62;                 // slimmer/shorter than the Knight
  const grow = lerp(0.6, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── kinematics ─────────────────────────────────────────────────────────
  const sw = Math.sin(p.gait * TAU);
  const bob = Math.abs(Math.sin(p.gait * TAU)) * p.moving;
  // Lighter breath / hood sway than the Knight — sells the lithe silhouette.
  const breath = Math.sin((p.t + p.phase) * 2.2) * (1 - p.moving) * 0.018;
  const lift = (bob * 0.32 + breath) * sc;
  const headBob = Math.sin(p.gait * TAU * 2) * p.moving * 0.014 * sc;
  const hoodSway = Math.sin(p.t * 2.4 + p.phase) * 0.020 * sc;
  // Cloak hem flutter (drives the trailing edge in side/back views).
  const tC = (p.t + p.phase) * 4.6;
  const flutter = (Math.sin(tC) * (0.07 + p.moving * 0.20) +
                   Math.sin(tC * 1.7) * 0.045) * sc;

  // Attack timeline — three phases:
  //   0.00..0.42  WINDUP : draw bowstring back, body leans back, arrow nocked
  //   0.42..0.62  STRIKE : RELEASE; string snaps flat, arrow vanishes,
  //                        small puff at the bow grip, bow oscillates
  //   0.62..1.00  RECOVERY: bow drops to rest, draw-hand reaches to quiver
  // p.atk is 1 at the very start of a swing and 0 at the end; s grows 0→1.
  const s = 1 - p.atk;
  let windPhase = 0, strikePhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.42)      windPhase = easeOut(s / 0.42);
    else if (s < 0.62){ windPhase = 1; strikePhase = easeOut((s - 0.42) / 0.20); }
    else              { strikePhase = 1; recoverPhase = easeInOut((s - 0.62) / 0.38); }
  }
  // Brief intense flash at the release moment.
  const releasePop = clamp01(1 - Math.abs(s - 0.46) * 12);
  // How far the string is drawn back (0 at rest, 1 at full draw, snaps to 0
  // on release and stays there during recovery).
  const drawAmt = windPhase * (1 - strikePhase) * (1 - recoverPhase * 0.0);
  // Small body lean: BACK while drawing, slight forward on release, settle.
  const lunge = (windPhase * -0.06 + strikePhase * 0.04 + recoverPhase * -0.02) * sc * p.face;
  const recoil = p.flash * 0.10 * sc * -p.face;

  // Occasional eye blink (idle): single-frame dim of the eye-glow.
  const blinkBeat = Math.sin(p.t * 0.7 + p.phase * 3.1);
  const blinking = blinkBeat > 0.985 && p.moving < 0.2 && p.atk === 0;

  ctx.save();
  ctx.globalAlpha = lerp(0.25, 1, easeOut(p.spawnF));

  // Ground cast shadow (smaller / shorter than Knight's).
  const shR = sc * (0.86 - bob * 0.18);
  ctx.fillStyle = `rgba(0,0,0,${0.48 * (1 - bob * 0.30)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.16, gy + sc * 0.04, shR, shR * 0.40, 0, 0, TAU);
  ctx.fill();

  // Spawn rune ring — teal-tinted regardless of team, with cream sparkles
  // (a "hooded-ranger" silvery ring rather than the Knight's team-color one).
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(0,109,119,${0.92 * inv})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.86 + sf * 0.86), sc * 0.34 * (0.86 + sf * 0.86), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(237,246,249,${0.75 * inv})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.66 + sf * 0.66), sc * 0.26 * (0.66 + sf * 0.66), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(237,246,249,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + sf * 0.6;
      const rx = sc * (0.82 + sf * 0.82), ry = sc * 0.30 * (0.82 + sf * 0.82);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.08 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter local space (feet anchor; +x = facing dir; -y = up the screen).
  ctx.translate(gx + lunge + recoil, gy);
  ctx.scale(p.face, 1);
  // Mild postural tilt: lean (movement) + a small backward tilt on full draw.
  ctx.rotate(-p.lean * p.face * 0.50 + windPhase * 0.07 - strikePhase * 0.03);
  ctx.translate(0, -lift);

  // Slim proportions.
  const baseY = 0;
  const hipY  = -1.00 * sc;
  const shoY  = -1.78 * sc;
  const headY = -2.18 * sc + headBob;
  // Chibi cuteness boost: scales the head/hood/face/eyes up around the chin
  // pivot so the silhouette reads as a stylized girly archer.
  const HEAD_S = 1.30;
  const HEAD_PIVOT_Y = () => headY + 0.18 * sc;

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = A_OL;
  const OW = 0.065 * sc;

  // ── reusable bow drawing helper ────────────────────────────────────────
  // Drawn at the bow grip; the bow is centered at local origin with its
  // limbs reaching up and down along local y. `drawBack` is the bowstring
  // pull (0 = rest, 1 = full draw). `showArrow` adds a nocked arrow.
  const drawBow = (drawBack, showArrow) => {
    const bowL = 1.05 * sc;            // half-height of the bow (each limb)
    const limbW = 0.060 * sc;
    // Upper limb (curved outward, away from archer along +x).
    ctx.strokeStyle = A_LEATHER_D;
    ctx.lineWidth = limbW + 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(0, -0.05 * sc);
    ctx.quadraticCurveTo(0.34 * sc, -bowL * 0.50, 0.04 * sc, -bowL);
    ctx.stroke();
    // Lower limb.
    ctx.beginPath();
    ctx.moveTo(0, 0.05 * sc);
    ctx.quadraticCurveTo(0.34 * sc, bowL * 0.50, 0.04 * sc, bowL);
    ctx.stroke();
    // Wood mid-tone overlay.
    ctx.strokeStyle = A_LEATHER;
    ctx.lineWidth = limbW;
    ctx.beginPath();
    ctx.moveTo(0, -0.05 * sc);
    ctx.quadraticCurveTo(0.34 * sc, -bowL * 0.50, 0.04 * sc, -bowL);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0.05 * sc);
    ctx.quadraticCurveTo(0.34 * sc, bowL * 0.50, 0.04 * sc, bowL);
    ctx.stroke();
    // Cream wood-grain highlight along the inside (riser-facing) edge.
    ctx.strokeStyle = `rgba(237,246,249,0.55)`;
    ctx.lineWidth = 0.020 * sc;
    ctx.beginPath();
    ctx.moveTo(0.01 * sc, -0.06 * sc);
    ctx.quadraticCurveTo(0.30 * sc, -bowL * 0.50, 0.03 * sc, -bowL * 0.96);
    ctx.moveTo(0.01 * sc, 0.06 * sc);
    ctx.quadraticCurveTo(0.30 * sc, bowL * 0.50, 0.03 * sc, bowL * 0.96);
    ctx.stroke();
    // Limb tips (small dark caps where the string anchors).
    ctx.fillStyle = A_OL;
    ctx.beginPath(); ctx.arc(0.04 * sc, -bowL, 0.038 * sc, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(0.04 * sc,  bowL, 0.038 * sc, 0, TAU); ctx.fill();
    // Riser / grip (terracotta with a cream wrap).
    ctx.fillStyle = A_LEATHER_D;
    rr(ctx, -0.06 * sc, -0.34 * sc, 0.16 * sc, 0.68 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.fillStyle = A_LIGHT;
    rr(ctx, -0.05 * sc, -0.20 * sc, 0.14 * sc, 0.40 * sc, 0.030 * sc);
    ctx.fill();
    ctx.strokeStyle = A_LEATHER_D; ctx.lineWidth = 0.020 * sc;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.05 * sc, i * 0.10 * sc);
      ctx.lineTo(0.09 * sc, i * 0.10 * sc);
      ctx.stroke();
    }
    // String — bends into a chevron when drawn back.
    const pull = -0.50 * sc * drawBack;
    ctx.strokeStyle = A_LIGHT;
    ctx.lineWidth = 0.022 * sc;
    if (drawBack > 0.02) {
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, -bowL);
      ctx.lineTo(pull, -0.05 * sc * drawBack);
      ctx.lineTo(pull, 0.05 * sc * drawBack);
      ctx.lineTo(0.04 * sc, bowL);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, -bowL);
      ctx.lineTo(0.04 * sc, bowL);
      ctx.stroke();
    }
    // Nocked arrow (sits horizontally; rotates with bow). drawArrow draws
    // the shaft centred on the origin with length 0.7*tile, so we translate
    // so the nock end sits exactly on the bowstring's current pull point.
    if (showArrow) {
      const arrowTileLocal = sc * 1.30;
      const arrowLen = arrowTileLocal * 0.7;
      ctx.save();
      ctx.translate(pull + arrowLen * 0.5, 0);
      drawArrow(ctx, 0, 0, 0, arrowTileLocal, { alpha: 1 });
      ctx.restore();
    }
    // Release puff at the grip on strike.
    if (releasePop > 0.05) {
      ctx.fillStyle = `rgba(237,246,249,${0.85 * releasePop})`;
      ctx.beginPath();
      ctx.arc(0.10 * sc, 0, 0.28 * sc * releasePop, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.65 * releasePop})`;
      ctx.beginPath();
      ctx.arc(0.05 * sc, 0, 0.14 * sc * releasePop, 0, TAU);
      ctx.fill();
    }
    // Subtle bow oscillation flash near the limb tips just after release.
    if (strikePhase > 0 && recoverPhase < 0.6) {
      const osc = Math.sin((1 - recoverPhase) * 18) * (1 - recoverPhase) * 0.04 * sc;
      ctx.strokeStyle = `rgba(237,246,249,${0.35 * (1 - recoverPhase)})`;
      ctx.lineWidth = 0.018 * sc;
      ctx.beginPath();
      ctx.moveTo(0.04 * sc + osc, -bowL * 0.94);
      ctx.lineTo(0.04 * sc - osc, bowL * 0.94);
      ctx.stroke();
    }
  };

  // ── quiver helper (back of figure) ─────────────────────────────────────
  // Drawn at the quiver center. `w`,`h` give the tube; arrows poke out top.
  const drawQuiver = (cx, cy, w, h, showArrows) => {
    // Leather tube body (terracotta with darker shadow stripe).
    ctx.fillStyle = A_LEATHER;
    rr(ctx, cx - w * 0.5, cy - h * 0.5, w, h, w * 0.32);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
    // Dark shadow side.
    ctx.fillStyle = A_LEATHER_D;
    rr(ctx, cx + w * 0.05, cy - h * 0.45, w * 0.40, h * 0.90, w * 0.20);
    ctx.fill();
    // Cream specular highlight along the left edge.
    ctx.fillStyle = `rgba(237,246,249,0.55)`;
    rr(ctx, cx - w * 0.42, cy - h * 0.40, w * 0.18, h * 0.80, w * 0.10);
    ctx.fill();
    // Leather strap rings.
    ctx.strokeStyle = A_DARK; ctx.lineWidth = 0.024 * sc;
    for (const sy of [-0.30, 0.30]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + sy * h, w * 0.52, h * 0.10, 0, 0, TAU);
      ctx.stroke();
    }
    // Top opening (dark teal interior).
    ctx.fillStyle = A_DARK_D;
    ctx.beginPath();
    ctx.ellipse(cx, cy - h * 0.5, w * 0.50, h * 0.13, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    // Arrow tips poking out (3-5 fletched ends).
    if (showArrows) {
      const arrows = [
        [-0.30, -1.10, -0.10, A_LIGHT, A_RED],
        [-0.05, -1.32, -0.04, A_LIGHT, A_LEATHER_D],
        [0.20, -1.18, 0.06, A_LIGHT, A_RED],
        [0.34, -0.95, 0.10, A_RED, A_LIGHT],
      ];
      for (const [bx, by, tilt, top, bot] of arrows) {
        const x0 = cx + bx * w;
        const y0 = cy + by * h * 0.5;
        // shaft
        ctx.strokeStyle = A_LEATHER_D;
        ctx.lineWidth = 0.040 * sc;
        ctx.beginPath();
        ctx.moveTo(cx + bx * w * 0.6, cy - h * 0.45);
        ctx.lineTo(x0 + tilt * 0.04 * sc, y0);
        ctx.stroke();
        ctx.strokeStyle = A_LEATHER;
        ctx.lineWidth = 0.024 * sc;
        ctx.beginPath();
        ctx.moveTo(cx + bx * w * 0.6, cy - h * 0.45);
        ctx.lineTo(x0 + tilt * 0.04 * sc, y0);
        ctx.stroke();
        // Fletching at the top (two short feathers).
        ctx.fillStyle = top;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 - 0.06 * sc, y0 - 0.10 * sc);
        ctx.lineTo(x0 + 0.04 * sc, y0 - 0.06 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.4; ctx.stroke();
        ctx.fillStyle = bot;
        ctx.beginPath();
        ctx.moveTo(x0 + 0.02 * sc, y0);
        ctx.lineTo(x0 + 0.10 * sc, y0 - 0.10 * sc);
        ctx.lineTo(x0 + 0.04 * sc, y0 - 0.04 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  };

  // ── hood helpers ───────────────────────────────────────────────────────
  // The hood drops a dark interior shadow across the face. The outer is mint
  // with a darker teal trim where it meets the face. drawHoodOuter is the
  // top half (back of the hood) and is drawn over the head; drawHoodFace
  // pulls the inner shadow over the upper part of the face.
  const drawHoodSide = (hx) => {
    // Outer hood silhouette.
    ctx.fillStyle = A_MINT;
    ctx.beginPath();
    ctx.moveTo(hx - 0.36 * sc, headY + 0.32 * sc);
    ctx.quadraticCurveTo(hx - 0.46 * sc + hoodSway * 0.5, headY - 0.28 * sc,
                         hx - 0.04 * sc + hoodSway, headY - 0.48 * sc);
    ctx.quadraticCurveTo(hx + 0.32 * sc, headY - 0.34 * sc,
                         hx + 0.40 * sc, headY + 0.10 * sc);
    ctx.lineTo(hx + 0.34 * sc, headY + 0.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Dark teal trim line along the hood's edge.
    ctx.strokeStyle = A_DARK;
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(hx + 0.40 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx + 0.32 * sc, headY - 0.34 * sc,
                         hx - 0.04 * sc + hoodSway, headY - 0.48 * sc);
    ctx.stroke();
    // Inner shadow under the brow (teal interior visible through the opening).
    ctx.fillStyle = A_DARK_D;
    ctx.beginPath();
    ctx.moveTo(hx + 0.06 * sc, headY - 0.18 * sc);
    ctx.quadraticCurveTo(hx + 0.34 * sc, headY - 0.08 * sc,
                         hx + 0.30 * sc, headY + 0.12 * sc);
    ctx.lineTo(hx + 0.10 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx - 0.04 * sc, headY - 0.04 * sc,
                         hx + 0.06 * sc, headY - 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    // Mint highlight on the top of the hood.
    ctx.fillStyle = A_MINT_HI;
    ctx.beginPath();
    ctx.moveTo(hx - 0.10 * sc + hoodSway, headY - 0.44 * sc);
    ctx.quadraticCurveTo(hx - 0.30 * sc + hoodSway * 0.6, headY - 0.20 * sc,
                         hx - 0.30 * sc, headY + 0.06 * sc);
    ctx.quadraticCurveTo(hx - 0.20 * sc, headY - 0.20 * sc,
                         hx + 0.02 * sc + hoodSway, headY - 0.38 * sc);
    ctx.closePath();
    ctx.fill();
  };

  const drawHoodFront = (hx) => {
    // Outer hood: oval that wraps around the head from behind.
    ctx.fillStyle = A_MINT;
    ctx.beginPath();
    ctx.moveTo(hx - 0.38 * sc, headY + 0.32 * sc);
    ctx.quadraticCurveTo(hx - 0.46 * sc, headY - 0.40 * sc,
                         hx + hoodSway, headY - 0.52 * sc);
    ctx.quadraticCurveTo(hx + 0.46 * sc, headY - 0.40 * sc,
                         hx + 0.38 * sc, headY + 0.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Mint highlight on the right-rear (light from upper-left).
    ctx.fillStyle = A_MINT_HI;
    ctx.beginPath();
    ctx.moveTo(hx - 0.04 * sc + hoodSway, headY - 0.50 * sc);
    ctx.quadraticCurveTo(hx - 0.36 * sc, headY - 0.30 * sc,
                         hx - 0.34 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx - 0.18 * sc, headY - 0.32 * sc,
                         hx + 0.04 * sc + hoodSway, headY - 0.40 * sc);
    ctx.closePath();
    ctx.fill();
    // Inside opening — dark teal cup that shadows the face.
    ctx.fillStyle = A_DARK_D;
    ctx.beginPath();
    ctx.moveTo(hx - 0.26 * sc, headY - 0.10 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.36 * sc,
                         hx + 0.26 * sc, headY - 0.10 * sc);
    ctx.lineTo(hx + 0.24 * sc, headY + 0.22 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.30 * sc, hx - 0.24 * sc, headY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    // Trim band where outer meets the face opening.
    ctx.strokeStyle = A_DARK;
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(hx - 0.30 * sc, headY + 0.04 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.36 * sc,
                         hx + 0.30 * sc, headY + 0.04 * sc);
    ctx.stroke();
  };

  const drawHoodBack = (hx) => {
    // Big dome from behind, fully covering the head.
    ctx.fillStyle = A_MINT;
    ctx.beginPath();
    ctx.moveTo(hx - 0.42 * sc, headY + 0.36 * sc);
    ctx.quadraticCurveTo(hx - 0.50 * sc, headY - 0.40 * sc,
                         hx + hoodSway, headY - 0.56 * sc);
    ctx.quadraticCurveTo(hx + 0.50 * sc, headY - 0.40 * sc,
                         hx + 0.42 * sc, headY + 0.36 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Centre crease (slight valley over the spine of the hood).
    ctx.strokeStyle = A_DARK;
    ctx.lineWidth = 0.028 * sc;
    ctx.beginPath();
    ctx.moveTo(hx + hoodSway * 0.4, headY - 0.50 * sc);
    ctx.quadraticCurveTo(hx + hoodSway * 0.3, headY - 0.10 * sc,
                         hx, headY + 0.30 * sc);
    ctx.stroke();
    // Mint highlight on the upper-left.
    ctx.fillStyle = A_MINT_HI;
    ctx.beginPath();
    ctx.moveTo(hx - 0.04 * sc + hoodSway, headY - 0.52 * sc);
    ctx.quadraticCurveTo(hx - 0.42 * sc, headY - 0.30 * sc,
                         hx - 0.36 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx - 0.20 * sc, headY - 0.30 * sc,
                         hx + 0.02 * sc + hoodSway, headY - 0.40 * sc);
    ctx.closePath();
    ctx.fill();
    // Dark teal trim along the bottom hem.
    ctx.strokeStyle = A_DARK;
    ctx.lineWidth = 0.034 * sc;
    ctx.beginPath();
    ctx.moveTo(hx - 0.42 * sc, headY + 0.34 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.42 * sc,
                         hx + 0.42 * sc, headY + 0.34 * sc);
    ctx.stroke();
  };

  // Inner-hood face shadow that softly darkens the upper face. Used in side
  // and front views right before drawing the human eyes. Lightened from the
  // older magical-archer version so the warm skin tone reads through.
  const drawFaceShadow = (hx, side) => {
    ctx.fillStyle = `rgba(40,30,30,0.30)`;
    if (side) {
      ctx.beginPath();
      ctx.moveTo(hx + 0.06 * sc, headY - 0.02 * sc);
      ctx.quadraticCurveTo(hx + 0.30 * sc, headY + 0.04 * sc,
                           hx + 0.30 * sc, headY + 0.12 * sc);
      ctx.lineTo(hx + 0.10 * sc, headY + 0.12 * sc);
      ctx.quadraticCurveTo(hx + 0.04 * sc, headY + 0.04 * sc,
                           hx + 0.06 * sc, headY - 0.02 * sc);
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.moveTo(hx - 0.22 * sc, headY - 0.02 * sc);
      ctx.quadraticCurveTo(hx, headY - 0.14 * sc,
                           hx + 0.22 * sc, headY - 0.02 * sc);
      ctx.lineTo(hx + 0.20 * sc, headY + 0.10 * sc);
      ctx.quadraticCurveTo(hx, headY + 0.14 * sc, hx - 0.20 * sc, headY + 0.10 * sc);
      ctx.closePath();
    }
    ctx.fill();
  };

  // Human eye — small almond white sclera, dark iris/pupil with a tiny
  // catchlight, soft eyelash arc above for a feminine read. Blink collapses
  // the eye to a thin lash line so the rig still feels alive but human.
  const eyeOpen = () => (blinking ? 0 : 1) - p.flash * 0.0;
  const drawEyeSide = (hx) => {
    const o = eyeOpen();
    const ex = hx + 0.20 * sc, ey = headY + 0.08 * sc;
    // upper eyelid + lash line
    ctx.strokeStyle = A_OL;
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(ex - 0.07 * sc, ey - 0.005 * sc);
    ctx.quadraticCurveTo(ex, ey - 0.045 * sc, ex + 0.06 * sc, ey + 0.005 * sc);
    ctx.stroke();
    if (o > 0.05) {
      // sclera (white of the eye)
      ctx.fillStyle = `rgba(245,238,232,${o})`;
      ctx.beginPath();
      ctx.ellipse(ex, ey + 0.005 * sc, 0.055 * sc, 0.030 * sc, 0, 0, TAU);
      ctx.fill();
      // brown iris
      ctx.fillStyle = `rgba(78,52,32,${o})`;
      ctx.beginPath();
      ctx.arc(ex + 0.012 * sc, ey + 0.008 * sc, 0.026 * sc, 0, TAU);
      ctx.fill();
      // tiny white catchlight
      ctx.fillStyle = `rgba(255,255,255,${o})`;
      ctx.beginPath();
      ctx.arc(ex + 0.020 * sc, ey + 0.000 * sc, 0.010 * sc, 0, TAU);
      ctx.fill();
    }
    // soft eyebrow
    ctx.strokeStyle = `rgba(80,55,40,0.85)`;
    ctx.lineWidth = 0.020 * sc;
    ctx.beginPath();
    ctx.moveTo(ex - 0.06 * sc, ey - 0.07 * sc);
    ctx.quadraticCurveTo(ex, ey - 0.095 * sc, ex + 0.05 * sc, ey - 0.06 * sc);
    ctx.stroke();
  };
  const drawEyesFront = (hx) => {
    const o = eyeOpen();
    for (const dx of [-0.10, 0.10]) {
      const ex = hx + dx * sc, ey = headY + 0.08 * sc;
      // upper lash line (closed-eye fallback)
      ctx.strokeStyle = A_OL;
      ctx.lineWidth = 0.020 * sc;
      ctx.beginPath();
      ctx.moveTo(ex - 0.055 * sc, ey - 0.002 * sc);
      ctx.quadraticCurveTo(ex, ey - 0.038 * sc, ex + 0.055 * sc, ey - 0.002 * sc);
      ctx.stroke();
      if (o > 0.05) {
        // sclera
        ctx.fillStyle = `rgba(245,238,232,${o})`;
        ctx.beginPath();
        ctx.ellipse(ex, ey + 0.006 * sc, 0.050 * sc, 0.028 * sc, 0, 0, TAU);
        ctx.fill();
        // brown iris
        ctx.fillStyle = `rgba(78,52,32,${o})`;
        ctx.beginPath();
        ctx.arc(ex, ey + 0.010 * sc, 0.025 * sc, 0, TAU);
        ctx.fill();
        // catchlight
        ctx.fillStyle = `rgba(255,255,255,${o})`;
        ctx.beginPath();
        ctx.arc(ex + 0.010 * sc, ey + 0.002 * sc, 0.010 * sc, 0, TAU);
        ctx.fill();
      }
      // brow above
      ctx.strokeStyle = `rgba(80,55,40,0.85)`;
      ctx.lineWidth = 0.018 * sc;
      ctx.beginPath();
      ctx.moveTo(ex - 0.05 * sc, ey - 0.07 * sc);
      ctx.quadraticCurveTo(ex, ey - 0.090 * sc, ex + 0.05 * sc, ey - 0.07 * sc);
      ctx.stroke();
    }
  };

  // Skin patch — visible face inside the hood. Expanded from the older
  // "just-nose-chin" sliver so the eye/cheek area also reads as human skin.
  const drawSkinSide = (hx) => {
    ctx.fillStyle = A_SKIN;
    ctx.beginPath();
    ctx.moveTo(hx + 0.04 * sc, headY - 0.10 * sc);
    ctx.quadraticCurveTo(hx + 0.34 * sc, headY - 0.04 * sc,
                         hx + 0.34 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx + 0.32 * sc, headY + 0.20 * sc,
                         hx + 0.28 * sc, headY + 0.30 * sc);
    ctx.quadraticCurveTo(hx + 0.16 * sc, headY + 0.38 * sc,
                         hx + 0.04 * sc, headY + 0.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Cheek blush.
    ctx.fillStyle = `rgba(232,168,155,0.65)`;
    ctx.beginPath();
    ctx.ellipse(hx + 0.22 * sc, headY + 0.16 * sc, 0.07 * sc, 0.04 * sc, 0, 0, TAU);
    ctx.fill();
    // Nose ridge highlight.
    ctx.fillStyle = A_LIGHT;
    ctx.beginPath();
    ctx.moveTo(hx + 0.26 * sc, headY + 0.12 * sc);
    ctx.lineTo(hx + 0.32 * sc, headY + 0.18 * sc);
    ctx.lineTo(hx + 0.24 * sc, headY + 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    // Lip — soft red, slightly fuller for a feminine read.
    ctx.fillStyle = A_RED;
    ctx.beginPath();
    ctx.ellipse(hx + 0.20 * sc, headY + 0.26 * sc, 0.07 * sc, 0.020 * sc, 0, 0, TAU);
    ctx.fill();
  };
  const drawSkinFront = (hx) => {
    // Wider face oval — visible upper face (eyes/cheeks) + lower face (lips/chin).
    ctx.fillStyle = A_SKIN;
    ctx.beginPath();
    ctx.moveTo(hx - 0.24 * sc, headY - 0.06 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.12 * sc, hx + 0.24 * sc, headY - 0.06 * sc);
    ctx.lineTo(hx + 0.20 * sc, headY + 0.24 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.36 * sc, hx - 0.20 * sc, headY + 0.24 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Cheek blush, both sides.
    ctx.fillStyle = `rgba(232,168,155,0.65)`;
    ctx.beginPath();
    ctx.ellipse(hx - 0.14 * sc, headY + 0.16 * sc, 0.055 * sc, 0.035 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(hx + 0.14 * sc, headY + 0.16 * sc, 0.055 * sc, 0.035 * sc, 0, 0, TAU);
    ctx.fill();
    // Nose — soft small triangle shadow.
    ctx.fillStyle = A_SKIN_SH;
    ctx.beginPath();
    ctx.moveTo(hx - 0.025 * sc, headY + 0.14 * sc);
    ctx.lineTo(hx + 0.025 * sc, headY + 0.14 * sc);
    ctx.lineTo(hx, headY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    // Lips — softer feminine red ellipse.
    ctx.fillStyle = A_RED;
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.27 * sc, 0.075 * sc, 0.022 * sc, 0, 0, TAU);
    ctx.fill();
    // Subtle lip-shine highlight.
    ctx.fillStyle = `rgba(255,220,210,0.65)`;
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.265 * sc, 0.030 * sc, 0.007 * sc, 0, 0, TAU);
    ctx.fill();
  };

  // ── SIDE VIEW ──────────────────────────────────────────────────────────
  if (p.view === 'side') {

    // Trailing cloak (drawn first so it sits behind everything else).
    {
      ctx.save();
      ctx.translate(-0.14 * sc, shoY + 0.10 * sc);
      ctx.rotate(0.04 + p.moving * 0.10);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-0.50 * sc + flutter * 0.3, 0.55 * sc,
                           -0.30 * sc + flutter, 1.25 * sc);
      ctx.quadraticCurveTo(-0.04 * sc, 1.35 * sc, 0.18 * sc, 1.20 * sc);
      ctx.quadraticCurveTo(0.22 * sc, 0.50 * sc, 0.20 * sc, 0);
      ctx.closePath();
      const cg = ctx.createLinearGradient(0, 0, -0.4 * sc, 1.1 * sc);
      cg.addColorStop(0, A_MINT);
      cg.addColorStop(0.55, A_DARK);
      cg.addColorStop(1, A_DARK_D);
      ctx.fillStyle = cg;
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Trailing edge piping (dark teal accent).
      ctx.strokeStyle = A_DARK_D;
      ctx.lineWidth = 0.034 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.50 * sc + flutter * 0.3, 0.55 * sc);
      ctx.quadraticCurveTo(-0.30 * sc + flutter, 1.05 * sc,
                           -0.10 * sc + flutter * 0.6, 1.30 * sc);
      ctx.stroke();
      // Thin near-white highlight crease.
      ctx.strokeStyle = A_LIGHT;
      ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.04 * sc, 0.08 * sc);
      ctx.quadraticCurveTo(-0.14 * sc + flutter * 0.3, 0.60 * sc,
                           -0.06 * sc + flutter * 0.4, 1.18 * sc);
      ctx.stroke();
      ctx.restore();
    }

    // Quiver on the back (drawn behind the torso, peeking out at the top).
    {
      const qx = -0.30 * sc;
      const qy = (shoY + hipY) * 0.5 + 0.04 * sc;
      ctx.save();
      ctx.translate(qx, qy);
      ctx.rotate(-0.18);
      drawQuiver(0, 0, 0.40 * sc, 1.10 * sc, true);
      ctx.restore();
    }

    // Legs.
    const legSpread = 0.22 * sc;
    const legSwing  = sw * 0.32 * sc * p.moving;
    const drawSideLeg = (side, swingX, isBack) => {
      const hipX     = side * legSpread;
      const footX    = side * legSpread + swingX;
      const kneeBend = side * legSpread + swingX * 0.55;
      const kneeY    = (hipY + baseY) * 0.5 + Math.abs(swingX) * 0.10;
      // bare peach legs (no leggings) — slimmer capsule for girly silhouette
      ctx.fillStyle = isBack ? A_SKIN_SH : A_SKIN;
      capsule(ctx, hipX, hipY + 0.08 * sc, kneeBend, kneeY, 0.11 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // shin
      ctx.fillStyle = isBack ? A_SKIN_SH : A_SKIN;
      capsule(ctx, kneeBend, kneeY, footX, baseY - 0.30 * sc, 0.095 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // subtle peach shadow on the back of the calf
      if (!isBack) {
        ctx.fillStyle = `rgba(232,168,155,0.55)`;
        capsule(ctx, kneeBend - 0.03 * sc, kneeY + 0.04 * sc,
                     footX - 0.03 * sc, baseY - 0.32 * sc, 0.04 * sc);
        ctx.fill();
      }
      // tall terracotta knee-high boot with cream cuff + lace ribbon
      ctx.fillStyle = A_LEATHER_D;
      rr(ctx, footX - 0.20 * sc, baseY - 0.42 * sc, 0.42 * sc, 0.42 * sc, 0.08 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // lighter terracotta inner panel
      ctx.fillStyle = A_LEATHER;
      rr(ctx, footX - 0.18 * sc, baseY - 0.40 * sc, 0.20 * sc, 0.34 * sc, 0.04 * sc);
      ctx.fill();
      // cream folded cuff at the top of the boot
      ctx.fillStyle = A_LIGHT;
      rr(ctx, footX - 0.22 * sc, baseY - 0.44 * sc, 0.46 * sc, 0.08 * sc, 0.03 * sc);
      ctx.fill();
      ctx.strokeStyle = A_DARK; ctx.lineWidth = 0.018 * sc; ctx.stroke();
      // dark sole stripe
      ctx.fillStyle = A_OL;
      rr(ctx, footX - 0.22 * sc, baseY - 0.05 * sc, 0.46 * sc, 0.05 * sc, 0.02 * sc);
      ctx.fill();
      // small red bow ribbon at the boot cuff (girly accent)
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(footX + 0.06 * sc, baseY - 0.40 * sc);
      ctx.lineTo(footX + 0.14 * sc, baseY - 0.46 * sc);
      ctx.lineTo(footX + 0.14 * sc, baseY - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(footX + 0.06 * sc, baseY - 0.40 * sc);
      ctx.lineTo(footX - 0.02 * sc, baseY - 0.46 * sc);
      ctx.lineTo(footX - 0.02 * sc, baseY - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = A_LIGHT;
      ctx.beginPath();
      ctx.arc(footX + 0.06 * sc, baseY - 0.40 * sc, 0.022 * sc, 0, TAU);
      ctx.fill();
      // foot-plant dust
      const plantA = Math.max(0, (isBack ? -sw : sw)) * p.moving;
      if (plantA > 0.15) {
        ctx.fillStyle = `rgba(180,180,170,${0.20 * plantA})`;
        ctx.beginPath();
        ctx.ellipse(footX - 0.08 * sc * (isBack ? -1 : 1), baseY + 0.02 * sc,
                    0.32 * sc * plantA, 0.09 * sc * plantA, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawSideLeg(-1, -legSwing, true);

    // Tunic (mint torso) — drawn behind the cloak's front but in front of
    // the back leg.
    ctx.beginPath();
    ctx.moveTo(-0.36 * sc, shoY);
    ctx.quadraticCurveTo(-0.46 * sc, (shoY + hipY) * 0.5, -0.34 * sc, hipY);
    ctx.lineTo(0.38 * sc, hipY);
    ctx.quadraticCurveTo(0.50 * sc, (shoY + hipY) * 0.5, 0.44 * sc, shoY);
    ctx.quadraticCurveTo(0.04 * sc, shoY - 0.18 * sc, -0.36 * sc, shoY);
    ctx.closePath();
    const tg = ctx.createLinearGradient(-0.4 * sc, shoY, 0.4 * sc, hipY);
    tg.addColorStop(0, A_MINT_HI);
    tg.addColorStop(0.55, A_MINT);
    tg.addColorStop(1, A_DARK);
    ctx.fillStyle = tg;
    ctx.fill();
    // dark-side band (behind facing)
    ctx.fillStyle = `rgba(0,79,87,0.45)`;
    ctx.beginPath();
    ctx.moveTo(-0.36 * sc, shoY);
    ctx.quadraticCurveTo(-0.46 * sc, (shoY + hipY) * 0.5, -0.34 * sc, hipY);
    ctx.lineTo(-0.14 * sc, hipY);
    ctx.lineTo(-0.10 * sc, shoY - 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.1;
    ctx.beginPath();
    ctx.moveTo(-0.36 * sc, shoY);
    ctx.quadraticCurveTo(-0.46 * sc, (shoY + hipY) * 0.5, -0.34 * sc, hipY);
    ctx.lineTo(0.38 * sc, hipY);
    ctx.quadraticCurveTo(0.50 * sc, (shoY + hipY) * 0.5, 0.44 * sc, shoY);
    ctx.quadraticCurveTo(0.04 * sc, shoY - 0.18 * sc, -0.36 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // Lace-up centerline (cream string + four cross-stitches).
    ctx.strokeStyle = A_LIGHT;
    ctx.lineWidth = 0.024 * sc;
    ctx.beginPath();
    ctx.moveTo(0.08 * sc, shoY + 0.04 * sc);
    ctx.lineTo(0.06 * sc, hipY - 0.10 * sc);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const y = lerp(shoY + 0.16 * sc, hipY - 0.18 * sc, i / 3);
      ctx.beginPath();
      ctx.moveTo(0.00 * sc, y);
      ctx.lineTo(0.14 * sc, y + 0.04 * sc);
      ctx.moveTo(0.14 * sc, y);
      ctx.lineTo(0.00 * sc, y + 0.04 * sc);
      ctx.stroke();
    }

    // Leather belt + buckle.
    ctx.fillStyle = A_LEATHER_D;
    rr(ctx, -0.38 * sc, hipY - 0.05 * sc, 0.80 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.36 * sc, hipY - 0.02 * sc, 0.76 * sc, 0.06 * sc, 0.02 * sc);
    ctx.fill();
    ctx.fillStyle = A_LIGHT;
    rr(ctx, 0.10 * sc, hipY - 0.06 * sc, 0.16 * sc, 0.18 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = A_LEATHER_D; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = A_DARK;
    ctx.beginPath();
    ctx.arc(0.18 * sc, hipY + 0.04 * sc, 0.050 * sc, 0, TAU);
    ctx.fill();

    // Short flared skirt of the dress (mint with dark teal underside + cream
    // lace hem). Ends mid-thigh so the bare legs read clearly below.
    {
      const hemY = hipY + 0.45 * sc;
      ctx.fillStyle = A_DARK;
      ctx.beginPath();
      ctx.moveTo(-0.34 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.50 * sc + flutter * 0.3, hemY);
      ctx.quadraticCurveTo(-0.10 * sc, hemY + 0.10 * sc,
                           0.30 * sc + flutter * 0.2, hemY - 0.02 * sc);
      ctx.lineTo(0.10 * sc, hipY + 0.06 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
      // mint front panel (the lit side)
      ctx.fillStyle = A_MINT;
      ctx.beginPath();
      ctx.moveTo(-0.30 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.40 * sc + flutter * 0.2, hemY - 0.02 * sc);
      ctx.quadraticCurveTo(-0.04 * sc, hemY,
                           0.24 * sc + flutter * 0.15, hemY - 0.06 * sc);
      ctx.lineTo(0.08 * sc, hipY + 0.06 * sc);
      ctx.closePath();
      ctx.fill();
      // cream scalloped lace along the hem (3 small scallops)
      ctx.fillStyle = A_LIGHT;
      ctx.strokeStyle = A_DARK_D;
      ctx.lineWidth = 0.016 * sc;
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const sx = lerp(-0.40 * sc, 0.26 * sc, t) + flutter * 0.15 * (1 - t);
        const sy = lerp(hemY - 0.02 * sc, hemY - 0.06 * sc, t);
        ctx.beginPath();
        ctx.arc(sx, sy, 0.05 * sc, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    // Cute red bow ribbon at the waist (girly accent on top of the belt).
    {
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, hipY + 0.02 * sc);
      ctx.lineTo(0.18 * sc, hipY - 0.08 * sc);
      ctx.lineTo(0.18 * sc, hipY + 0.12 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, hipY + 0.02 * sc);
      ctx.lineTo(-0.10 * sc, hipY - 0.08 * sc);
      ctx.lineTo(-0.10 * sc, hipY + 0.12 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // bow knot
      ctx.fillStyle = '#9a3539';
      ctx.beginPath();
      ctx.arc(0.04 * sc, hipY + 0.02 * sc, 0.040 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      ctx.fillStyle = A_LIGHT;
      ctx.beginPath();
      ctx.arc(0.024 * sc, hipY, 0.012 * sc, 0, TAU);
      ctx.fill();
    }

    // Front (near) leg over the tunic hem.
    drawSideLeg(1, legSwing, false);

    // ── arms + bow ────────────────────────────────────────────────────
    // Side-view bow geometry: the bow shoulder is the FRONT shoulder; the
    // bow extends forward, the draw hand pulls back toward the cheek.
    const bowShX = 0.34 * sc, bowShY = shoY + 0.14 * sc;
    const drawShX = -0.04 * sc, drawShY = shoY + 0.18 * sc;
    // Front-arm reach: locked forward when winding, drops slightly on
    // release recovery.
    const reach = lerp(0.62, 0.78, windPhase) - recoverPhase * 0.16;
    const bowHandX = bowShX + reach * sc;
    const bowHandY = bowShY + (windPhase * 0.02 + recoverPhase * 0.08) * sc;
    // Draw hand: starts at front of bow at rest, pulls back to the cheek at
    // full draw, then snaps forward on release, then dips down on recovery
    // (reaching back to the quiver).
    let drawHandX, drawHandY;
    if (recoverPhase > 0.01) {
      drawHandX = lerp(bowHandX - 0.10 * sc, -0.30 * sc, recoverPhase);
      drawHandY = lerp(bowHandY, shoY + 0.10 * sc - 0.10 * sc * recoverPhase, recoverPhase);
    } else if (windPhase > 0.01) {
      drawHandX = lerp(bowHandX - 0.10 * sc, 0.04 * sc, windPhase * (1 - strikePhase));
      drawHandY = lerp(bowHandY, headY + 0.20 * sc, windPhase * (1 - strikePhase));
    } else {
      drawHandX = bowHandX - 0.14 * sc;
      drawHandY = bowHandY + 0.02 * sc;
    }

    // Back/draw upper arm (drawn first; behind torso).
    ctx.fillStyle = A_DARK;
    capsule(ctx, drawShX, drawShY, drawHandX, drawHandY, 0.10 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Sleeve cuff (cream).
    ctx.save();
    ctx.translate(drawHandX, drawHandY);
    ctx.rotate(Math.atan2(drawHandY - drawShY, drawHandX - drawShX));
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.14 * sc, -0.09 * sc, 0.26 * sc, 0.18 * sc, 0.05 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    // skin hand
    ctx.fillStyle = A_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.07 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    // Hood now wraps over the head. Drawn AFTER the back arm so that
    // when the arm reaches up the elbow disappears behind the shoulder.
    // Whole head/hood/face is scaled up around the chin pivot for chibi cuteness.
    const hxS = 0;
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      drawHoodSide(hxS);
      drawFaceShadow(hxS, true);
      drawSkinSide(hxS);
      drawEyeSide(hxS);
      // Two cute orange-cream side bangs peeking from the hood opening.
      ctx.fillStyle = A_LEATHER;
      ctx.beginPath();
      ctx.moveTo(hxS + 0.06 * sc, headY + 0.00 * sc);
      ctx.quadraticCurveTo(hxS + 0.16 * sc, headY + 0.10 * sc,
                           hxS + 0.10 * sc, headY + 0.22 * sc);
      ctx.quadraticCurveTo(hxS + 0.06 * sc, headY + 0.10 * sc,
                           hxS + 0.04 * sc, headY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      ctx.restore();
    }

    // Bow arm (front).
    ctx.fillStyle = A_MINT;
    capsule(ctx, bowShX, bowShY, bowHandX, bowHandY, 0.11 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // arm shading
    ctx.fillStyle = `rgba(0,79,87,0.35)`;
    capsule(ctx, bowShX + 0.05 * sc, bowShY + 0.04 * sc,
                 bowHandX + 0.05 * sc, bowHandY + 0.04 * sc, 0.05 * sc);
    ctx.fill();
    // leather bracer
    ctx.save();
    ctx.translate((bowShX + bowHandX) * 0.5, (bowShY + bowHandY) * 0.5);
    ctx.rotate(Math.atan2(bowHandY - bowShY, bowHandX - bowShX));
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.10 * sc, -0.08 * sc, 0.20 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.strokeStyle = A_LEATHER_D; ctx.lineWidth = 0.018 * sc;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(-0.08 * sc, i * 0.045 * sc);
      ctx.lineTo(0.08 * sc, i * 0.045 * sc);
      ctx.stroke();
    }
    ctx.restore();

    // The bow itself (and the nocked arrow when at rest / winding up).
    // Rotated so the limbs reach up/down in the bow's local frame.
    const showArrow = strikePhase < 0.05 && recoverPhase < 0.15;
    ctx.save();
    ctx.translate(bowHandX, bowHandY);
    drawBow(drawAmt, showArrow);
    ctx.restore();

  // ── FRONT VIEW ─────────────────────────────────────────────────────────
  } else if (p.view === 'front') {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    // Short flared dress side panels (dark teal back / mint front trim).
    // Ends just above the knee so bare legs read clearly below.
    {
      const flR = Math.sin(tC) * (0.05 + p.moving * 0.10) * sc;
      const flL = Math.cos(tC * 1.1) * (0.05 + p.moving * 0.10) * sc;
      const skirtHemY = hipY + 0.45 * sc;
      const cg = ctx.createLinearGradient(0, shoY, 0, skirtHemY);
      cg.addColorStop(0, A_DARK);
      cg.addColorStop(1, A_DARK_D);
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(-0.36 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(-0.58 * sc + flL, hipY + 0.20 * sc,
                           -0.50 * sc + flL * 0.5, skirtHemY);
      ctx.quadraticCurveTo(-0.26 * sc, skirtHemY + 0.06 * sc,
                           -0.26 * sc, shoY + 0.18 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.36 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(0.58 * sc + flR, hipY + 0.20 * sc,
                           0.50 * sc + flR * 0.5, skirtHemY);
      ctx.quadraticCurveTo(0.26 * sc, skirtHemY + 0.06 * sc,
                           0.26 * sc, shoY + 0.18 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // Mint accent along the dress edge.
      ctx.strokeStyle = A_MINT;
      ctx.lineWidth = 0.028 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.36 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(-0.30 * sc, hipY + 0.20 * sc, -0.48 * sc, skirtHemY - 0.02 * sc);
      ctx.moveTo(0.36 * sc, shoY + 0.10 * sc);
      ctx.quadraticCurveTo(0.30 * sc, hipY + 0.20 * sc, 0.48 * sc, skirtHemY - 0.02 * sc);
      ctx.stroke();
      // Mint front skirt panel (a small flared piece in the middle).
      ctx.fillStyle = A_MINT;
      ctx.beginPath();
      ctx.moveTo(-0.26 * sc, hipY + 0.04 * sc);
      ctx.quadraticCurveTo(-0.36 * sc, (hipY + skirtHemY) * 0.5,
                           -0.34 * sc, skirtHemY - 0.04 * sc);
      ctx.quadraticCurveTo(0, skirtHemY + 0.04 * sc,
                           0.34 * sc, skirtHemY - 0.04 * sc);
      ctx.quadraticCurveTo(0.36 * sc, (hipY + skirtHemY) * 0.5,
                           0.26 * sc, hipY + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.75; ctx.stroke();
      // cream scalloped lace hem
      ctx.fillStyle = A_LIGHT;
      ctx.strokeStyle = A_DARK_D;
      ctx.lineWidth = 0.016 * sc;
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const sx = lerp(-0.34 * sc, 0.34 * sc, t);
        const sy = skirtHemY - 0.04 * sc + Math.sin(t * Math.PI) * 0.04 * sc;
        ctx.beginPath();
        ctx.arc(sx, sy, 0.05 * sc, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Alternating leg lifts.
    const legSpreadF = 0.22 * sc;
    const liftL = Math.max(0, sw)  * 0.20 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.20 * sc * p.moving;
    const drawFrontLeg = (side, footLift) => {
      const x = side * legSpreadF;
      const footPt = baseY - footLift;
      // bare peach legs (slimmer capsules)
      ctx.fillStyle = A_SKIN;
      capsule(ctx, x, hipY + 0.10 * sc, x, footPt - 0.36 * sc, 0.10 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // soft shadow down the outer side
      ctx.fillStyle = `rgba(232,168,155,0.55)`;
      capsule(ctx, x + side * 0.05 * sc, hipY + 0.16 * sc,
                   x + side * 0.05 * sc, footPt - 0.40 * sc, 0.035 * sc);
      ctx.fill();
      // tall terracotta knee-high boot with cream cuff
      ctx.fillStyle = A_LEATHER_D;
      rr(ctx, x - 0.18 * sc, footPt - 0.42 * sc, 0.36 * sc, 0.42 * sc, 0.08 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = A_LEATHER;
      rr(ctx, x - 0.16 * sc, footPt - 0.40 * sc, 0.18 * sc, 0.34 * sc, 0.04 * sc);
      ctx.fill();
      // cream cuff
      ctx.fillStyle = A_LIGHT;
      rr(ctx, x - 0.20 * sc, footPt - 0.44 * sc, 0.40 * sc, 0.08 * sc, 0.03 * sc);
      ctx.fill();
      ctx.strokeStyle = A_DARK; ctx.lineWidth = 0.018 * sc; ctx.stroke();
      // sole
      ctx.fillStyle = A_OL;
      rr(ctx, x - 0.20 * sc, footPt - 0.05 * sc, 0.40 * sc, 0.05 * sc, 0.02 * sc);
      ctx.fill();
      // small red bow ribbon at the cuff (girly accent)
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(x, footPt - 0.40 * sc);
      ctx.lineTo(x + 0.08 * sc, footPt - 0.46 * sc);
      ctx.lineTo(x + 0.08 * sc, footPt - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, footPt - 0.40 * sc);
      ctx.lineTo(x - 0.08 * sc, footPt - 0.46 * sc);
      ctx.lineTo(x - 0.08 * sc, footPt - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = A_LIGHT;
      ctx.beginPath();
      ctx.arc(x, footPt - 0.40 * sc, 0.022 * sc, 0, TAU);
      ctx.fill();
      if (footLift < 0.02 * sc && p.moving > 0.2) {
        ctx.fillStyle = `rgba(180,180,170,${0.22 * p.moving})`;
        ctx.beginPath();
        ctx.ellipse(x, baseY + 0.02 * sc, 0.30 * sc, 0.08 * sc, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawFrontLeg(-1, liftL);
    drawFrontLeg(1, liftR);

    // Tunic — slimmer than knight torso.
    ctx.beginPath();
    ctx.moveTo(-0.40 * sc, shoY);
    ctx.quadraticCurveTo(-0.50 * sc, (shoY + hipY) * 0.5, -0.38 * sc, hipY);
    ctx.lineTo(0.38 * sc, hipY);
    ctx.quadraticCurveTo(0.50 * sc, (shoY + hipY) * 0.5, 0.40 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.20 * sc, -0.40 * sc, shoY);
    ctx.closePath();
    const tgF = ctx.createLinearGradient(-0.40 * sc, shoY, 0.40 * sc, hipY);
    tgF.addColorStop(0, A_MINT_HI);
    tgF.addColorStop(0.5, A_MINT);
    tgF.addColorStop(1, A_DARK);
    ctx.fillStyle = tgF;
    ctx.fill();
    // right-side shadow band
    ctx.fillStyle = `rgba(0,79,87,0.30)`;
    ctx.beginPath();
    ctx.moveTo(0.40 * sc, shoY);
    ctx.quadraticCurveTo(0.50 * sc, (shoY + hipY) * 0.5, 0.38 * sc, hipY);
    ctx.lineTo(0.12 * sc, hipY);
    ctx.lineTo(0.10 * sc, shoY - 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.10;
    ctx.beginPath();
    ctx.moveTo(-0.40 * sc, shoY);
    ctx.quadraticCurveTo(-0.50 * sc, (shoY + hipY) * 0.5, -0.38 * sc, hipY);
    ctx.lineTo(0.38 * sc, hipY);
    ctx.quadraticCurveTo(0.50 * sc, (shoY + hipY) * 0.5, 0.40 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.20 * sc, -0.40 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // Centre lacing.
    ctx.strokeStyle = A_LIGHT; ctx.lineWidth = 0.024 * sc;
    ctx.beginPath();
    ctx.moveTo(0, shoY + 0.04 * sc);
    ctx.lineTo(0, hipY - 0.10 * sc);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const y = lerp(shoY + 0.16 * sc, hipY - 0.18 * sc, i / 3);
      ctx.beginPath();
      ctx.moveTo(-0.08 * sc, y);
      ctx.lineTo(0.08 * sc, y + 0.04 * sc);
      ctx.moveTo(0.08 * sc, y);
      ctx.lineTo(-0.08 * sc, y + 0.04 * sc);
      ctx.stroke();
    }

    // Belt + buckle (centered).
    ctx.fillStyle = A_LEATHER_D;
    rr(ctx, -0.42 * sc, hipY - 0.05 * sc, 0.84 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.40 * sc, hipY - 0.02 * sc, 0.80 * sc, 0.06 * sc, 0.02 * sc);
    ctx.fill();
    ctx.fillStyle = A_LIGHT;
    rr(ctx, -0.10 * sc, hipY - 0.06 * sc, 0.20 * sc, 0.18 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = A_LEATHER_D; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = A_DARK;
    ctx.beginPath();
    ctx.arc(0, hipY + 0.04 * sc, 0.050 * sc, 0, TAU);
    ctx.fill();
    // Cute red bow ribbon centered at the waist (girly accent).
    {
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(0, hipY + 0.04 * sc);
      ctx.lineTo(0.16 * sc, hipY - 0.10 * sc);
      ctx.lineTo(0.16 * sc, hipY + 0.16 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, hipY + 0.04 * sc);
      ctx.lineTo(-0.16 * sc, hipY - 0.10 * sc);
      ctx.lineTo(-0.16 * sc, hipY + 0.16 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // bow knot
      ctx.fillStyle = '#9a3539';
      ctx.beginPath();
      ctx.arc(0, hipY + 0.04 * sc, 0.045 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      ctx.fillStyle = A_LIGHT;
      ctx.beginPath();
      ctx.arc(-0.015 * sc, hipY + 0.024 * sc, 0.015 * sc, 0, TAU);
      ctx.fill();
      // dangling ribbon tails
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(-0.03 * sc, hipY + 0.07 * sc);
      ctx.lineTo(-0.08 * sc, hipY + 0.28 * sc);
      ctx.lineTo(-0.02 * sc, hipY + 0.30 * sc);
      ctx.lineTo(0.02 * sc, hipY + 0.10 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0.03 * sc, hipY + 0.07 * sc);
      ctx.lineTo(0.08 * sc, hipY + 0.28 * sc);
      ctx.lineTo(0.02 * sc, hipY + 0.30 * sc);
      ctx.lineTo(-0.02 * sc, hipY + 0.10 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // Quiver edge peeking over the left shoulder (just a sliver of the tube).
    {
      ctx.save();
      ctx.translate(-0.36 * sc, shoY - 0.08 * sc);
      ctx.rotate(-0.32);
      ctx.fillStyle = A_LEATHER_D;
      rr(ctx, -0.06 * sc, 0, 0.18 * sc, 0.40 * sc, 0.06 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = A_LIGHT;
      ctx.beginPath();
      ctx.moveTo(0.02 * sc, -0.04 * sc);
      ctx.lineTo(-0.04 * sc, -0.18 * sc);
      ctx.lineTo(0.10 * sc, -0.10 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, 0);
      ctx.lineTo(0.16 * sc, -0.14 * sc);
      ctx.lineTo(0.12 * sc, -0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ── front view arms + bow ────────────────────────────────────────
    // At rest: bow held vertically in front of body, on viewer's left
    // (the archer's left, which is screen-right of center after p.face).
    // On attack: rotates more horizontal toward the camera, draw arm
    // pulls right.
    const bowShXF = -0.42 * sc, bowShYF = shoY + 0.18 * sc;
    const drawShXF = 0.42 * sc, drawShYF = shoY + 0.18 * sc;
    // Bow hand sits roughly in front of body; lifts a bit during draw.
    const bowHandXF = lerp(-0.06 * sc, -0.18 * sc, windPhase) + strikePhase * 0.04 * sc;
    const bowHandYF = lerp(hipY + 0.10 * sc, shoY + 0.42 * sc, windPhase);
    // Draw hand
    let drawHandXF, drawHandYF;
    if (recoverPhase > 0.01) {
      drawHandXF = lerp(bowHandXF + 0.20 * sc, 0.50 * sc, recoverPhase);
      drawHandYF = lerp(bowHandYF, shoY + 0.20 * sc - 0.10 * sc * recoverPhase, recoverPhase);
    } else if (windPhase > 0.01) {
      drawHandXF = lerp(bowHandXF + 0.20 * sc, 0.36 * sc, windPhase * (1 - strikePhase));
      drawHandYF = lerp(bowHandYF, shoY + 0.32 * sc, windPhase * (1 - strikePhase));
    } else {
      drawHandXF = bowHandXF + 0.18 * sc;
      drawHandYF = bowHandYF + 0.02 * sc;
    }

    // Draw arm (back / behind torso when not winding).
    ctx.fillStyle = A_DARK;
    capsule(ctx, drawShXF, drawShYF, drawHandXF, drawHandYF, 0.10 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Cuff + hand.
    ctx.save();
    ctx.translate(drawHandXF, drawHandYF);
    ctx.rotate(Math.atan2(drawHandYF - drawShYF, drawHandXF - drawShXF));
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.12 * sc, -0.08 * sc, 0.22 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.fillStyle = A_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.07 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    // Bow arm (front).
    ctx.fillStyle = A_MINT;
    capsule(ctx, bowShXF, bowShYF, bowHandXF, bowHandYF, 0.11 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // bracer
    ctx.save();
    ctx.translate((bowShXF + bowHandXF) * 0.5, (bowShYF + bowHandYF) * 0.5);
    ctx.rotate(Math.atan2(bowHandYF - bowShYF, bowHandXF - bowShXF));
    ctx.fillStyle = A_LEATHER;
    rr(ctx, -0.10 * sc, -0.07 * sc, 0.20 * sc, 0.14 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.restore();

    // Bow itself. Held vertically at rest; rotates toward horizontal during
    // the draw so the nocked arrow ends up pointing down at the camera
    // (i.e. "she's shooting at the viewer").
    const showArrowF = strikePhase < 0.05 && recoverPhase < 0.15;
    ctx.save();
    ctx.translate(bowHandXF, bowHandYF);
    ctx.rotate(lerp(0, Math.PI / 2 - 0.18, windPhase));
    drawBow(drawAmt, showArrowF);
    ctx.restore();

    // Head + hood + face go on top. Whole head scales up for chibi cuteness.
    const hxF = 0;
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      drawHoodFront(hxF);
      drawFaceShadow(hxF, false);
      drawSkinFront(hxF);
      drawEyesFront(hxF);
      // Two symmetric peach-blonde bangs peeking from under the hood.
      ctx.fillStyle = A_LEATHER;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(hxF + side * 0.12 * sc, headY - 0.02 * sc);
        ctx.quadraticCurveTo(hxF + side * 0.22 * sc, headY + 0.08 * sc,
                             hxF + side * 0.14 * sc, headY + 0.22 * sc);
        ctx.quadraticCurveTo(hxF + side * 0.10 * sc, headY + 0.10 * sc,
                             hxF + side * 0.08 * sc, headY - 0.02 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      }
      ctx.restore();
    }

  // ── BACK VIEW ──────────────────────────────────────────────────────────
  } else {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    const legSpreadB = 0.22 * sc;
    const liftL = Math.max(0, sw)  * 0.18 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.18 * sc * p.moving;
    const drawBackLeg = (side, footLift) => {
      const x = side * legSpreadB;
      const footPt = baseY - footLift;
      // bare peach legs from the back
      ctx.fillStyle = A_SKIN;
      capsule(ctx, x, hipY + 0.10 * sc, x, footPt - 0.36 * sc, 0.10 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // subtle peach shadow stripe
      ctx.fillStyle = `rgba(232,168,155,0.55)`;
      capsule(ctx, x - side * 0.04 * sc, hipY + 0.16 * sc,
                   x - side * 0.04 * sc, footPt - 0.40 * sc, 0.035 * sc);
      ctx.fill();
      // terracotta knee-high boot back with cream cuff
      ctx.fillStyle = A_LEATHER_D;
      rr(ctx, x - 0.18 * sc, footPt - 0.42 * sc, 0.36 * sc, 0.42 * sc, 0.08 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = A_LIGHT;
      rr(ctx, x - 0.20 * sc, footPt - 0.44 * sc, 0.40 * sc, 0.08 * sc, 0.03 * sc);
      ctx.fill();
      ctx.strokeStyle = A_DARK; ctx.lineWidth = 0.018 * sc; ctx.stroke();
      // small red bow ribbon at the back of the cuff
      ctx.fillStyle = A_RED;
      ctx.beginPath();
      ctx.moveTo(x, footPt - 0.40 * sc);
      ctx.lineTo(x + 0.08 * sc, footPt - 0.46 * sc);
      ctx.lineTo(x + 0.08 * sc, footPt - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, footPt - 0.40 * sc);
      ctx.lineTo(x - 0.08 * sc, footPt - 0.46 * sc);
      ctx.lineTo(x - 0.08 * sc, footPt - 0.34 * sc);
      ctx.closePath();
      ctx.fill();
    };
    drawBackLeg(-1, liftL);
    drawBackLeg(1, liftR);

    // Cloak hanging straight down the back, dominant in the silhouette.
    {
      const ky0 = shoY + 0.06 * sc;
      const kyB = baseY - 0.10 * sc;
      ctx.fillStyle = A_DARK;
      ctx.beginPath();
      ctx.moveTo(-0.50 * sc, ky0);
      ctx.quadraticCurveTo(-0.62 * sc + flutter * 0.3, hipY + 0.40 * sc,
                           -0.50 * sc + flutter * 0.5, kyB);
      ctx.quadraticCurveTo(0, kyB + 0.20 * sc + flutter * 0.4,
                           0.50 * sc - flutter * 0.5, kyB);
      ctx.quadraticCurveTo(0.62 * sc - flutter * 0.3, hipY + 0.40 * sc,
                           0.50 * sc, ky0);
      ctx.quadraticCurveTo(0, ky0 - 0.16 * sc, -0.50 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Centre crease (highlight)
      ctx.strokeStyle = A_MINT;
      ctx.lineWidth = 0.040 * sc;
      ctx.beginPath();
      ctx.moveTo(0, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(flutter * 0.3, (shoY + hipY) * 0.5,
                           flutter * 0.5, hipY + 0.50 * sc);
      ctx.lineTo(flutter * 0.4, kyB - 0.10 * sc);
      ctx.stroke();
      // Dark-teal piping along the hem (a thin line).
      ctx.strokeStyle = A_DARK_D;
      ctx.lineWidth = 0.036 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.50 * sc, kyB - 0.04 * sc);
      ctx.quadraticCurveTo(0, kyB + 0.16 * sc + flutter * 0.4,
                           0.50 * sc, kyB - 0.04 * sc);
      ctx.stroke();
      // Mint highlight strip down the left side.
      ctx.strokeStyle = A_MINT_HI;
      ctx.lineWidth = 0.024 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.40 * sc, hipY);
      ctx.quadraticCurveTo(-0.28 * sc + flutter * 0.2, (hipY + kyB) * 0.5,
                           -0.20 * sc + flutter * 0.3, kyB - 0.08 * sc);
      ctx.stroke();
    }

    // Quiver dominant in the center back, with fletched arrows sticking up.
    {
      ctx.save();
      ctx.translate(-0.04 * sc, (shoY + hipY) * 0.5 + 0.06 * sc);
      drawQuiver(0, 0, 0.46 * sc, 1.15 * sc, true);
      ctx.restore();
    }

    // Bow visible at one side (tucked behind the right shoulder, partial).
    {
      ctx.save();
      ctx.translate(0.46 * sc, shoY + 0.40 * sc);
      ctx.rotate(0.32);
      ctx.scale(0.85, 0.85);
      // shortened bow profile — just one limb's silhouette
      ctx.strokeStyle = A_LEATHER_D;
      ctx.lineWidth = 0.065 * sc;
      ctx.beginPath();
      ctx.moveTo(0, -0.85 * sc);
      ctx.quadraticCurveTo(0.20 * sc, 0, 0, 0.85 * sc);
      ctx.stroke();
      ctx.strokeStyle = A_LEATHER;
      ctx.lineWidth = 0.040 * sc;
      ctx.beginPath();
      ctx.moveTo(0, -0.85 * sc);
      ctx.quadraticCurveTo(0.20 * sc, 0, 0, 0.85 * sc);
      ctx.stroke();
      ctx.strokeStyle = A_LIGHT;
      ctx.lineWidth = 0.018 * sc;
      ctx.beginPath();
      ctx.moveTo(0, -0.85 * sc);
      ctx.lineTo(0, 0.85 * sc);
      ctx.stroke();
      ctx.restore();
    }

    // Hood back (covers head from behind). Scaled up for chibi cuteness.
    const hxB = 0;
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      drawHoodBack(hxB);
      ctx.restore();
    }
  }

  // Hit flash (white wash over the whole figure).
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.55 * p.flash})`;
    rr(ctx, -0.66 * sc, headY - 0.55 * sc,
        1.32 * sc, (baseY - headY) + 0.70 * sc, 0.26 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
  return true;
}

export function markArcher(id) {
  const a = anim.get(id);
  if (a) a.wasArcher = true;
}

// Polished 2.5D Goblin — small, mischievous, scampering Clash-Royale-style
// dagger goblin. Engine spawns 4 per deploy; each unit instance gets its own
// rig via getAnim() so the four de-sync naturally on p.phase. View-aware
// (side / front / back) with a three-phase dagger-stab attack (windup pulls
// the dagger back behind the head, strike lunges with a diagonal slash and
// red-tipped motion smear, recovery snaps back). Big floppy ears wobble,
// the head tilts side-to-side, the body bounces low-and-fast on a hunched
// scamper. Idle: breathing, occasional tongue flick and ear twitch. Spawn
// ring is green-tinted; small cloth/skin/red poof on death.
export function drawGoblin(ctx, gx, gy, tile, p) {
  // ── Goblin palette (function-local to avoid clashing with the Giant's
  // overlapping G_DARK / G_RED / G_CREAM names at module scope) ──────────
  // User-supplied 5-color core:
  //   #386641 forest green — skin shadow, dagger handle wrap, sash shadow,
  //                          outline (darkest of the five, doubles as ink)
  //   #6a994e mid green    — skin body/arms/face base, leaf-green cloth fold
  //   #a7c957 bright lime  — skin highlight (cheek/forehead/ear ridges),
  //                          inner ear, blade highlight, pommel
  //   #f2e8cf cream        — sack-cloth tunic, bandages, teeth, eye sclera,
  //                          dagger blade (cream-steel cel-shade)
  //   #bc4749 rust red     — eye irises, headband/bandana, dagger drips,
  //                          tongue tip
  // All shading/half-tones come from rgba() of these five base colors — no
  // new hues are introduced. #386641 doubles as the outline ink so the line
  // work reads as "deep mossy" rather than pure black.
  const G_DARK  = '#386641';
  const G_MID   = '#6a994e';
  const G_LIME  = '#a7c957';
  const G_CREAM = '#f2e8cf';
  const G_RED   = '#bc4749';

  // TINY silhouette: ~half the Knight's height. Spec: S = tile * 0.45.
  const S = tile * 0.45;
  const grow = lerp(0.55, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── kinematics ─────────────────────────────────────────────────────────
  const sw  = Math.sin(p.gait * TAU);
  // Big bouncy vertical bob — goblins SCAMPER (much more vertical than the
  // Knight). Low center of gravity, fast cadence.
  const bob = Math.abs(Math.sin(p.gait * TAU)) * p.moving;
  const breath = Math.sin((p.t + p.phase) * 2.7) * (1 - p.moving) * 0.022;
  const lift = (bob * 0.55 + breath) * sc;
  // Oversized head: it bobs and tilts side-to-side on the run.
  const headBob  = Math.sin(p.gait * TAU * 2) * p.moving * 0.024 * sc;
  const headTilt = Math.sin(p.gait * TAU) * p.moving * 0.10;
  // Floppy ear wobble (small while idle, big while running).
  const earWob = Math.sin(p.t * 5 + p.phase) * (0.05 + p.moving * 0.16);

  // Occasional tongue flick on idle: a thin sine threshold so it pops out
  // briefly every few seconds, per-rig because of p.phase.
  const tongueBeat = Math.sin(p.t * 0.55 + p.phase * 2.3);
  const tongueOut  = (tongueBeat > 0.92 && p.atk === 0 && p.moving < 0.3)
                   ? (tongueBeat - 0.92) / 0.08 : 0;
  // Occasional ear twitch on idle (separate sine so it's not synced).
  const twitchBeat = Math.sin(p.t * 0.83 + p.phase * 1.7);
  const earTwitch  = (twitchBeat > 0.95 && p.moving < 0.3) ? (twitchBeat - 0.95) / 0.05 : 0;

  // Attack timeline — three phases (s grows 0→1 across one swing):
  //   0.00..0.30  WINDUP : dagger pulled back behind head/shoulder, crouch,
  //                        grin widens, eyes narrow to predator slits.
  //   0.30..0.62  STRIKE : lunge forward, diagonal slash with motion-smear
  //                        arc and a brief red-tip flash. Stab-impact pop.
  //   0.62..1.00  RECOVERY: dagger snaps back to ready, body recoils.
  const s = 1 - p.atk;
  let windPhase = 0, swingPhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.30)       windPhase = easeOut(s / 0.30);
    else if (s < 0.62){ windPhase = 1; swingPhase = easeOut((s - 0.30) / 0.32); }
    else              { swingPhase = 1; recoverPhase = easeInOut((s - 0.62) / 0.38); }
  }
  // Strike pop peaks just past the start of the strike window.
  const strikePop = clamp01(1 - Math.abs(s - 0.42) * 8);
  // Lunge: small backward crouch on windup, big forward stab on strike,
  // settle on recovery.
  const lunge  = (windPhase * -0.12 + swingPhase * 0.55 + recoverPhase * -0.18) * sc * p.face;
  const recoil = p.flash * 0.14 * sc * -p.face;
  // Body crouches lower on windup (mischievous coil) and pops UP on the strike.
  const crouch = (windPhase * 0.08 - swingPhase * 0.04) * sc;

  ctx.save();
  ctx.globalAlpha = lerp(0.25, 1, easeOut(p.spawnF));

  // ── ground cast shadow (small) ─────────────────────────────────────────
  const shR = sc * (0.74 - bob * 0.20);
  ctx.fillStyle = `rgba(0,0,0,${0.48 * (1 - bob * 0.30)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.14, gy + sc * 0.03, shR, shR * 0.40, 0, 0, TAU);
  ctx.fill();

  // ── spawn rune ring (small, green-tinted with lime sparkles) ──────────
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(106,153,78,${0.92 * inv})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.78 + sf * 0.78), sc * 0.32 * (0.78 + sf * 0.78), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(167,201,87,${0.75 * inv})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.58 + sf * 0.58), sc * 0.24 * (0.58 + sf * 0.58), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(167,201,87,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + sf * 0.6;
      const rx = sc * (0.74 + sf * 0.74), ry = sc * 0.28 * (0.74 + sf * 0.74);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.08 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter local space (feet anchor; +x = facing dir; -y = up the screen).
  ctx.translate(gx + lunge + recoil, gy);
  ctx.scale(p.face, 1);
  // Hunched posture: small constant forward tilt, more when sprinting.
  // Plus windup-pull-back and strike-thrust-forward.
  const hunch = -0.08 - p.moving * 0.10;
  ctx.rotate(-p.lean * p.face * 0.55 + hunch
             + windPhase * 0.22 - swingPhase * 0.28 + recoverPhase * 0.06);
  ctx.translate(0, -lift + crouch);

  // Proportions: SHORT legs, SHORT torso, BIG HEAD. Hunched.
  const baseY = 0;
  const hipY  = -0.58 * sc;
  const shoY  = -1.04 * sc;
  // Head is large and sits high above the shoulders.
  const headY = -1.52 * sc + headBob;
  const headR = 0.46 * sc;

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = G_DARK;
  const OW = 0.060 * sc;

  // ── helper: the dagger ─────────────────────────────────────────────────
  // Drawn so the blade points along local +x; the handle's grip is at the
  // origin (so callers translate to the hand and rotate by armAng).
  // motionFlash 0..1 brightens the red-stained tip and adds a tiny drip.
  const drawDagger = (motionFlash) => {
    const bladeL = 0.42 * sc;
    const bladeW = 0.10 * sc;
    // Handle wrap (dark green, slightly wider than the blade root).
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.20 * sc, -0.055 * sc, 0.20 * sc, 0.110 * sc, 0.030 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    // Handle wrap stitching (mid-green ridges).
    ctx.strokeStyle = G_MID; ctx.lineWidth = 0.020 * sc;
    for (let i = 0; i < 3; i++) {
      const hx = -0.17 * sc + i * 0.05 * sc;
      ctx.beginPath();
      ctx.moveTo(hx, -0.055 * sc); ctx.lineTo(hx, 0.055 * sc);
      ctx.stroke();
    }
    // Pommel (lime knob at the butt of the handle).
    ctx.fillStyle = G_LIME;
    ctx.beginPath();
    ctx.arc(-0.21 * sc, 0, 0.045 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
    // Crossguard (small lime bar where blade meets handle).
    ctx.fillStyle = G_LIME;
    rr(ctx, -0.020 * sc, -0.085 * sc, 0.055 * sc, 0.170 * sc, 0.018 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    // Blade — cream "steel" with a subtle curve (top edge straight, bottom
    // edge gently arcing toward the tip).
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.moveTo(0.030 * sc, -bladeW * 0.50);
    ctx.lineTo(bladeL - 0.02 * sc, -bladeW * 0.18);
    ctx.lineTo(bladeL + 0.05 * sc, 0);
    ctx.lineTo(bladeL - 0.04 * sc, bladeW * 0.45);
    ctx.lineTo(0.030 * sc, bladeW * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    // Lime highlight along the top edge of the blade.
    ctx.fillStyle = G_LIME;
    ctx.beginPath();
    ctx.moveTo(0.050 * sc, -bladeW * 0.42);
    ctx.lineTo(bladeL - 0.06 * sc, -bladeW * 0.12);
    ctx.lineTo(bladeL - 0.08 * sc, -bladeW * 0.02);
    ctx.lineTo(0.050 * sc, -bladeW * 0.22);
    ctx.closePath();
    ctx.fill();
    // Mid-green shadow along the underside of the blade.
    ctx.fillStyle = `rgba(56,102,65,0.45)`;
    ctx.beginPath();
    ctx.moveTo(0.060 * sc, bladeW * 0.10);
    ctx.lineTo(bladeL - 0.08 * sc, bladeW * 0.22);
    ctx.lineTo(bladeL - 0.10 * sc, bladeW * 0.42);
    ctx.lineTo(0.060 * sc, bladeW * 0.42);
    ctx.closePath();
    ctx.fill();
    // Red-stained tip — always slightly tinted, brighter on strike.
    const tipA = 0.50 + motionFlash * 0.50;
    ctx.fillStyle = `rgba(188,71,73,${tipA})`;
    ctx.beginPath();
    ctx.moveTo(bladeL - 0.13 * sc, -bladeW * 0.30);
    ctx.lineTo(bladeL + 0.05 * sc, 0);
    ctx.lineTo(bladeL - 0.13 * sc, bladeW * 0.40);
    ctx.closePath();
    ctx.fill();
    // Tiny red drip falling off the tip during the strike.
    if (motionFlash > 0.35) {
      ctx.fillStyle = `rgba(188,71,73,${0.90 * motionFlash})`;
      ctx.beginPath();
      ctx.arc(bladeL + 0.10 * sc, 0.08 * sc, 0.035 * sc * motionFlash, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bladeL + 0.16 * sc, 0.14 * sc, 0.022 * sc * motionFlash, 0, TAU);
      ctx.fill();
    }
  };

  // ── helper: a pointy ear with barbed notches ───────────────────────────
  // Drawn relative to (cx, cy) where cy is the side of the head it sprouts
  // from. dir = +1 (right) or -1 (left). length is along the local x-out
  // direction with a slight upward tilt. tiltOffset adds a per-call wobble.
  const drawEar = (cx, cy, dir, tiltOffset) => {
    const L = 0.38 * sc;     // ear length
    const H = 0.26 * sc;     // ear vertical span
    const tilt = tiltOffset;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt * dir);
    // Outer (mid-green) silhouette with two barbed notches at the tip.
    ctx.fillStyle = G_MID;
    ctx.beginPath();
    ctx.moveTo(0, -H * 0.40);
    // top edge out to first notch
    ctx.quadraticCurveTo(dir * L * 0.35, -H * 0.55, dir * L * 0.70, -H * 0.32);
    // notch 1
    ctx.lineTo(dir * L * 0.78, -H * 0.18);
    ctx.lineTo(dir * L * 0.88, -H * 0.30);
    // notch 2
    ctx.lineTo(dir * L * 0.96, -H * 0.10);
    ctx.lineTo(dir * (L + 0.02 * sc), H * 0.05);
    // bottom edge back to base
    ctx.quadraticCurveTo(dir * L * 0.55, H * 0.30, 0, H * 0.40);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
    // Inner ear: lighter lime canal.
    ctx.fillStyle = G_LIME;
    ctx.beginPath();
    ctx.moveTo(dir * 0.04 * sc, -H * 0.22);
    ctx.quadraticCurveTo(dir * L * 0.40, -H * 0.30, dir * L * 0.72, -H * 0.12);
    ctx.quadraticCurveTo(dir * L * 0.45, H * 0.10, dir * 0.04 * sc, H * 0.22);
    ctx.closePath();
    ctx.fill();
    // Forest-green shadow along the lower rim of the inner ear.
    ctx.fillStyle = `rgba(56,102,65,0.55)`;
    ctx.beginPath();
    ctx.moveTo(dir * 0.04 * sc, H * 0.22);
    ctx.quadraticCurveTo(dir * L * 0.45, H * 0.10, dir * L * 0.70, -H * 0.04);
    ctx.lineTo(dir * L * 0.55, H * 0.16);
    ctx.lineTo(dir * 0.04 * sc, H * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  // ── helper: bandaged hand (small cream wrap + green skin knuckles) ─────
  // Called inside a frame already centered/rotated on the hand.
  const drawHand = () => {
    // Skin (mid green) — the underlying knuckle.
    ctx.fillStyle = G_MID;
    ctx.beginPath();
    ctx.arc(0, 0, 0.080 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Lime knuckle highlight.
    ctx.fillStyle = G_LIME;
    ctx.beginPath();
    ctx.arc(-0.020 * sc, -0.025 * sc, 0.030 * sc, 0, TAU);
    ctx.fill();
    // Cream bandage wrap (two diagonal strips).
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.rect(-0.10 * sc, -0.025 * sc, 0.20 * sc, 0.040 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.40; ctx.stroke();
    ctx.fillStyle = `rgba(56,102,65,0.45)`;
    ctx.fillRect(-0.10 * sc, 0.000 * sc, 0.20 * sc, 0.010 * sc);
  };

  // ── helper: red glowing eye ────────────────────────────────────────────
  // Cream sclera with red iris dot; iris becomes a vertical slit on attack
  // (predator focus); dims briefly on blink-like noise; brightens on hit.
  const slit = clamp01(windPhase + swingPhase * 0.6); // 0 = round, 1 = slit
  const eyeGlow = 0.70 + strikePop * 0.30 + p.flash * 0.30;
  const drawEye = (cx, cy, scale) => {
    const sclR = 0.080 * sc * scale;
    // cream sclera
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.arc(cx, cy, sclR, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
    // soft red halo around the iris
    ctx.fillStyle = `rgba(188,71,73,${0.30 * eyeGlow})`;
    ctx.beginPath();
    ctx.arc(cx, cy, sclR * 1.15, 0, TAU);
    ctx.fill();
    // red iris/pupil — round at rest, vertical slit on attack
    const irisH = sclR * 0.95;
    const irisW = lerp(sclR * 0.55, sclR * 0.20, slit);
    ctx.fillStyle = `rgba(188,71,73,${0.90 + eyeGlow * 0.10})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, irisW, irisH, 0, 0, TAU);
    ctx.fill();
    // tiny cream catchlight inside the iris
    ctx.fillStyle = `rgba(242,232,207,${0.85})`;
    ctx.beginPath();
    ctx.arc(cx - sclR * 0.18, cy - sclR * 0.22, sclR * 0.18, 0, TAU);
    ctx.fill();
  };

  // ── helper: toothy grin (cream fangs on a dark mouth slit) ─────────────
  // `width` controls grin width; widens on windup. The lower fangs always
  // peek out, even at rest, because goblins are goblins.
  const drawGrinSide = (cx, cy) => {
    const grinW = 0.20 * sc * (1 + windPhase * 0.20);
    // dark mouth slit
    ctx.fillStyle = G_DARK;
    rr(ctx, cx - grinW * 0.08, cy - 0.020 * sc, grinW, 0.060 * sc, 0.012 * sc);
    ctx.fill();
    // tongue tip (visible during idle flick OR on a wide windup grin)
    const tw = Math.max(tongueOut, windPhase * 0.30);
    if (tw > 0.05) {
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.ellipse(cx + grinW * 0.40, cy + 0.012 * sc, 0.040 * sc * tw, 0.020 * sc * tw, 0, 0, TAU);
      ctx.fill();
    }
    // upper fang (small triangle hanging down at the front of the slit)
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.moveTo(cx + grinW * 0.55, cy - 0.018 * sc);
    ctx.lineTo(cx + grinW * 0.70, cy + 0.020 * sc);
    ctx.lineTo(cx + grinW * 0.78, cy - 0.018 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
    // lower fang (sticks up from the bottom of the slit)
    ctx.fillStyle = G_CREAM;
    ctx.beginPath();
    ctx.moveTo(cx + grinW * 0.20, cy + 0.040 * sc);
    ctx.lineTo(cx + grinW * 0.32, cy + 0.000 * sc);
    ctx.lineTo(cx + grinW * 0.42, cy + 0.040 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
  };
  const drawGrinFront = (cx, cy) => {
    const grinW = 0.28 * sc * (1 + windPhase * 0.18);
    // dark mouth slit
    ctx.fillStyle = G_DARK;
    rr(ctx, cx - grinW * 0.5, cy - 0.020 * sc, grinW, 0.070 * sc, 0.015 * sc);
    ctx.fill();
    // tongue
    const tw = Math.max(tongueOut, windPhase * 0.30);
    if (tw > 0.05) {
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 0.020 * sc, 0.060 * sc * tw, 0.024 * sc * tw, 0, 0, TAU);
      ctx.fill();
    }
    // a row of cream teeth (4 little fangs along the upper lip)
    ctx.fillStyle = G_CREAM;
    for (let i = 0; i < 4; i++) {
      const tx = cx - grinW * 0.40 + (i / 3) * grinW * 0.80;
      ctx.beginPath();
      ctx.moveTo(tx - 0.022 * sc, cy - 0.020 * sc);
      ctx.lineTo(tx, cy + 0.018 * sc);
      ctx.lineTo(tx + 0.022 * sc, cy - 0.020 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.30; ctx.stroke();
    }
    // two prominent lower fangs (sticking up out of the bottom of the grin)
    ctx.fillStyle = G_CREAM;
    for (const lx of [-0.20, 0.20]) {
      ctx.beginPath();
      ctx.moveTo(cx + lx * sc - 0.022 * sc, cy + 0.050 * sc);
      ctx.lineTo(cx + lx * sc, cy + 0.005 * sc);
      ctx.lineTo(cx + lx * sc + 0.022 * sc, cy + 0.050 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
    }
  };

  // ────────────────────────────────────────────────────────────────────────
  // ── SIDE VIEW ──────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  if (p.view === 'side') {

    // Trailing sash flutter (drawn first so it sits behind the body).
    {
      const tC = (p.t + p.phase) * 4.8;
      const flut = (Math.sin(tC) * (0.05 + p.moving * 0.18) +
                    Math.sin(tC * 1.7) * 0.030) * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-0.10 * sc, hipY - 0.02 * sc);
      ctx.lineTo(-0.30 * sc + flut, hipY + 0.32 * sc);
      ctx.lineTo(-0.18 * sc + flut * 0.5, hipY + 0.36 * sc);
      ctx.lineTo(-0.06 * sc, hipY + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = `rgba(56,102,65,0.55)`;
      ctx.beginPath();
      ctx.moveTo(-0.10 * sc, hipY - 0.02 * sc);
      ctx.lineTo(-0.20 * sc + flut * 0.6, hipY + 0.20 * sc);
      ctx.lineTo(-0.14 * sc + flut * 0.3, hipY + 0.22 * sc);
      ctx.lineTo(-0.08 * sc, hipY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
    }

    // Legs (back leg first; front leg later over the tunic hem).
    const legSpread = 0.16 * sc;
    const legSwing  = sw * 0.26 * sc * p.moving;
    const drawSideLeg = (side, swingX, isBack) => {
      const hipX     = side * legSpread;
      const footX    = side * legSpread + swingX;
      const kneeBend = side * legSpread + swingX * 0.55;
      const kneeY    = (hipY + baseY) * 0.5 + Math.abs(swingX) * 0.10;
      // Thigh (mid green; back leg is forest shadow).
      ctx.fillStyle = isBack ? G_DARK : G_MID;
      capsule(ctx, hipX, hipY, kneeBend, kneeY, 0.110 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Shin.
      capsule(ctx, kneeBend, kneeY, footX, baseY - 0.02 * sc, 0.090 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Lime highlight stripe down the front of the shin (only on the
      // forward/visible leg).
      if (!isBack) {
        ctx.fillStyle = G_LIME;
        capsule(ctx, kneeBend + 0.03 * sc, kneeY,
                     footX + 0.03 * sc, baseY - 0.08 * sc, 0.024 * sc);
        ctx.fill();
      }
      // Bandaged foot (cream wrap, jagged hem).
      ctx.fillStyle = G_CREAM;
      rr(ctx, footX - 0.18 * sc, baseY - 0.16 * sc, 0.36 * sc, 0.18 * sc, 0.05 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // Bandage cross-stitches.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.020 * sc;
      for (let i = 0; i < 2; i++) {
        const fx = footX - 0.10 * sc + i * 0.14 * sc;
        ctx.beginPath();
        ctx.moveTo(fx - 0.04 * sc, baseY - 0.16 * sc);
        ctx.lineTo(fx + 0.04 * sc, baseY - 0.02 * sc);
        ctx.moveTo(fx + 0.04 * sc, baseY - 0.16 * sc);
        ctx.lineTo(fx - 0.04 * sc, baseY - 0.02 * sc);
        ctx.stroke();
      }
      // Toe tip — small green claw poking out of the bandage.
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.moveTo(footX + 0.18 * sc, baseY - 0.06 * sc);
      ctx.lineTo(footX + 0.24 * sc, baseY - 0.02 * sc);
      ctx.lineTo(footX + 0.18 * sc, baseY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      // Foot-plant dust (TINY puffs — goblins are light).
      const plantA = Math.max(0, (isBack ? -sw : sw)) * p.moving;
      if (plantA > 0.18) {
        ctx.fillStyle = `rgba(180,180,170,${0.18 * plantA})`;
        ctx.beginPath();
        ctx.ellipse(footX - 0.06 * sc * (isBack ? -1 : 1), baseY + 0.02 * sc,
                    0.22 * sc * plantA, 0.06 * sc * plantA, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawSideLeg(-1, -legSwing, true);

    // Tunic — ragged cream sack-cloth with jagged hem.
    {
      ctx.fillStyle = G_CREAM;
      ctx.beginPath();
      ctx.moveTo(-0.30 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(-0.40 * sc, (shoY + hipY) * 0.5, -0.32 * sc, hipY + 0.06 * sc);
      // jagged hem (zigzag)
      ctx.lineTo(-0.22 * sc, hipY + 0.18 * sc);
      ctx.lineTo(-0.12 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.02 * sc, hipY + 0.20 * sc);
      ctx.lineTo(0.10 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.22 * sc, hipY + 0.20 * sc);
      ctx.lineTo(0.32 * sc, hipY + 0.06 * sc);
      ctx.quadraticCurveTo(0.42 * sc, (shoY + hipY) * 0.5, 0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(0, shoY - 0.10 * sc, -0.30 * sc, shoY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      // Bold outline.
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.05;
      ctx.stroke();
      // Back-side shade band.
      ctx.fillStyle = `rgba(56,102,65,0.35)`;
      ctx.beginPath();
      ctx.moveTo(-0.30 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(-0.40 * sc, (shoY + hipY) * 0.5, -0.32 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.14 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.10 * sc, shoY + 0.00 * sc);
      ctx.closePath();
      ctx.fill();
      // Cloth fold lines (dark-green stitches running down the front).
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(0.04 * sc, shoY + 0.06 * sc);
      ctx.quadraticCurveTo(0.02 * sc, (shoY + hipY) * 0.5, 0.04 * sc, hipY + 0.04 * sc);
      ctx.stroke();
      // A patchy stitched square on the chest.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.018 * sc;
      ctx.setLineDash([0.030 * sc, 0.024 * sc]);
      ctx.beginPath();
      ctx.rect(-0.18 * sc, shoY + 0.10 * sc, 0.14 * sc, 0.18 * sc);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Rope sash (mid green) tied at the waist.
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.34 * sc, hipY + 0.02 * sc, 0.68 * sc, 0.080 * sc, 0.020 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.fillStyle = G_MID;
    rr(ctx, -0.32 * sc, hipY + 0.04 * sc, 0.64 * sc, 0.040 * sc, 0.015 * sc);
    ctx.fill();
    // Knot bump on the side.
    ctx.fillStyle = G_DARK;
    ctx.beginPath();
    ctx.arc(0.22 * sc, hipY + 0.06 * sc, 0.060 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();

    // Front leg (over the tunic hem).
    drawSideLeg(1, legSwing, false);

    // ── arms + dagger ────────────────────────────────────────────────────
    // BACK arm (off-hand): rests at the side at idle, raises slightly on
    // strike to keep the silhouette balanced.
    {
      const offShX = -0.16 * sc, offShY = shoY + 0.04 * sc;
      const offHandAng = -2.05 + windPhase * -0.20 + swingPhase * -0.10;
      const offHandX = offShX + Math.cos(offHandAng) * 0.42 * sc;
      const offHandY = offShY + Math.sin(offHandAng) * 0.42 * sc;
      ctx.fillStyle = G_MID;
      capsule(ctx, offShX, offShY, offHandX, offHandY, 0.080 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Lime highlight stripe along the top.
      ctx.fillStyle = G_LIME;
      capsule(ctx, offShX, offShY - 0.02 * sc, offHandX, offHandY - 0.02 * sc, 0.020 * sc);
      ctx.fill();
      ctx.save();
      ctx.translate(offHandX, offHandY);
      ctx.rotate(offHandAng);
      drawHand();
      ctx.restore();
    }

    // HEAD (over the back arm, under the dagger arm).
    {
      // Apply head tilt (side-to-side bob).
      ctx.save();
      ctx.translate(0, headY);
      ctx.rotate(headTilt * 0.6);
      // Big round head.
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.ellipse(0, 0, headR * 1.04, headR * 0.96, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.1; ctx.stroke();
      // Back-of-head shadow (forest green).
      ctx.fillStyle = `rgba(56,102,65,0.55)`;
      ctx.beginPath();
      ctx.ellipse(-headR * 0.45, 0.06 * sc, headR * 0.55, headR * 0.70, 0, 0, TAU);
      ctx.fill();
      // Top-of-head lime highlight (light from upper-left).
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.ellipse(-headR * 0.10, -headR * 0.55, headR * 0.55, headR * 0.18, 0, 0, TAU);
      ctx.fill();
      // Cheek highlight.
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.arc(headR * 0.30, headR * 0.20, headR * 0.16, 0, TAU);
      ctx.fill();

      // Visible ear (back ear, sweeping up-and-back). Wobble + twitch.
      drawEar(-headR * 0.08, -headR * 0.10, -1, -0.35 + earWob * 0.5 + earTwitch * 0.4);

      // Small gold-like (lime) hoop earring dangling from the ear lobe.
      ctx.strokeStyle = G_LIME; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.arc(-headR * 0.16, headR * 0.18, 0.040 * sc, 0, TAU);
      ctx.stroke();

      // Red headband across the forehead (with a tail flapping behind).
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.95, -headR * 0.20);
      ctx.quadraticCurveTo(0, -headR * 0.42, headR * 0.95, -headR * 0.15);
      ctx.lineTo(headR * 0.92, -headR * 0.05);
      ctx.quadraticCurveTo(0, -headR * 0.30, -headR * 0.95, -headR * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      // Bandana tail flapping at the back.
      const tC = (p.t + p.phase) * 5.0;
      const tflut = Math.sin(tC) * (0.05 + p.moving * 0.10) * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.90, -headR * 0.20);
      ctx.lineTo(-headR * 1.50 + tflut, -headR * 0.05);
      ctx.lineTo(-headR * 1.40 + tflut * 0.7, headR * 0.10);
      ctx.lineTo(-headR * 0.85, -headR * 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();

      // Big nose (mid-green nub sticking out).
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.moveTo(headR * 0.62, headR * 0.04);
      ctx.quadraticCurveTo(headR * 0.95, headR * 0.10, headR * 0.86, headR * 0.30);
      ctx.lineTo(headR * 0.60, headR * 0.30);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      // Nose tip highlight.
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.arc(headR * 0.78, headR * 0.16, headR * 0.08, 0, TAU);
      ctx.fill();

      // Eye (single visible — side profile).
      drawEye(headR * 0.32, -headR * 0.02, 1);

      // Brow ridge above the eye (small lime arch — predator focus on attack).
      ctx.strokeStyle = G_DARK;
      ctx.lineWidth = 0.030 * sc;
      ctx.beginPath();
      ctx.moveTo(headR * 0.18, -headR * 0.16 + windPhase * 0.04);
      ctx.quadraticCurveTo(headR * 0.36, -headR * 0.22 + windPhase * 0.06,
                           headR * 0.50, -headR * 0.10 + windPhase * 0.04);
      ctx.stroke();

      // Grin (centered on the lower face).
      drawGrinSide(headR * 0.32, headR * 0.36);

      ctx.restore();
    }

    // DAGGER ARM (front, lead hand). Full three-phase swing geometry.
    {
      const restAng = -0.10;            // arm forward, slightly down
      const windAng = -2.40;            // pulled back behind the head
      const hitAng  =  0.40;            // thrust forward (slightly down)
      let armAng;
      if (p.atk > 0) {
        if (s < 0.30)       armAng = lerp(restAng, windAng, easeOut(s / 0.30));
        else if (s < 0.62)  armAng = lerp(windAng, hitAng, easeOut((s - 0.30) / 0.32));
        else                armAng = lerp(hitAng,  restAng, easeInOut((s - 0.62) / 0.38));
      } else {
        armAng = restAng;
      }
      const shX  = 0.18 * sc, shYY = shoY + 0.04 * sc;
      const armL = 0.46 * sc;
      const handX = shX + Math.cos(armAng) * armL;
      const handY = shYY + Math.sin(armAng) * armL;

      // Motion-smear arc (during strike — ghost blade trail).
      if (swingPhase > 0.05 && p.atk > 0) {
        const trailStart = lerp(windAng, hitAng,
                                easeOut(Math.max(0, (s - 0.30) / 0.32 - 0.30)));
        ctx.strokeStyle = `rgba(242,232,207,${0.42 * swingPhase})`;
        ctx.lineWidth = 0.18 * sc;
        ctx.beginPath();
        ctx.arc(shX, shYY, armL + 0.30 * sc, trailStart, armAng, false);
        ctx.stroke();
        // Red-tinted ghost streak (the bloody tip's history).
        ctx.strokeStyle = `rgba(188,71,73,${0.45 * swingPhase})`;
        ctx.lineWidth = 0.06 * sc;
        ctx.beginPath();
        ctx.arc(shX, shYY, armL + 0.42 * sc, trailStart, armAng, false);
        ctx.stroke();
      }

      // Arm (mid-green capsule with a lime top highlight).
      ctx.fillStyle = G_MID;
      capsule(ctx, shX, shYY, handX, handY, 0.090 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = G_LIME;
      capsule(ctx, shX, shYY - 0.02 * sc, handX, handY - 0.02 * sc, 0.024 * sc);
      ctx.fill();
      // Bandage wrap around the wrist.
      ctx.save();
      ctx.translate(handX - Math.cos(armAng) * 0.10 * sc,
                    handY - Math.sin(armAng) * 0.10 * sc);
      ctx.rotate(armAng + Math.PI / 2);
      ctx.fillStyle = G_CREAM;
      rr(ctx, -0.12 * sc, -0.045 * sc, 0.24 * sc, 0.090 * sc, 0.030 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.018 * sc;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-0.10 * sc, i * 0.024 * sc);
        ctx.lineTo(0.10 * sc, i * 0.024 * sc);
        ctx.stroke();
      }
      ctx.restore();

      // Hand + dagger.
      ctx.save();
      ctx.translate(handX, handY);
      ctx.rotate(armAng);
      // Hand sits at the dagger's grip (dagger origin is the grip).
      ctx.save();
      ctx.rotate(-armAng);
      drawHand();
      ctx.restore();
      drawDagger(strikePop);
      ctx.restore();

      // Stab-impact pop (small star + cream cross-shine at the blade tip
      // during strike).
      if (strikePop > 0.10) {
        const tipX = handX + Math.cos(armAng) * 0.46 * sc;
        const tipY = handY + Math.sin(armAng) * 0.46 * sc;
        ctx.fillStyle = `rgba(242,232,207,${0.85 * strikePop})`;
        const rs = 0.14 * sc * strikePop;
        ctx.beginPath();
        ctx.moveTo(tipX - rs, tipY);
        ctx.lineTo(tipX, tipY - rs);
        ctx.lineTo(tipX + rs, tipY);
        ctx.lineTo(tipX, tipY + rs);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(188,71,73,${0.70 * strikePop})`;
        ctx.beginPath();
        ctx.arc(tipX, tipY, 0.05 * sc * strikePop, 0, TAU);
        ctx.fill();
      }
    }

  // ────────────────────────────────────────────────────────────────────────
  // ── FRONT VIEW ─────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  } else if (p.view === 'front') {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.04 * sc;
    ctx.translate(sway, 0);

    // Alternating leg lifts.
    const legSpreadF = 0.14 * sc;
    const liftL = Math.max(0, sw)  * 0.18 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.18 * sc * p.moving;
    const drawFrontLeg = (side, footLift) => {
      const x = side * legSpreadF;
      const footPt = baseY - footLift;
      ctx.fillStyle = G_MID;
      capsule(ctx, x, hipY, x, footPt - 0.02 * sc, 0.110 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Lime shin highlight.
      ctx.fillStyle = G_LIME;
      capsule(ctx, x - side * 0.04 * sc, hipY + 0.10 * sc,
                   x - side * 0.04 * sc, footPt - 0.10 * sc, 0.020 * sc);
      ctx.fill();
      // Forest-green inner shadow.
      ctx.fillStyle = `rgba(56,102,65,0.45)`;
      capsule(ctx, x + side * 0.04 * sc, hipY + 0.10 * sc,
                   x + side * 0.04 * sc, footPt - 0.10 * sc, 0.030 * sc);
      ctx.fill();
      // Bandaged foot.
      ctx.fillStyle = G_CREAM;
      rr(ctx, x - 0.15 * sc, footPt - 0.16 * sc, 0.30 * sc, 0.18 * sc, 0.05 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.018 * sc;
      ctx.beginPath();
      ctx.moveTo(x - 0.12 * sc, footPt - 0.10 * sc);
      ctx.lineTo(x + 0.12 * sc, footPt - 0.06 * sc);
      ctx.moveTo(x + 0.12 * sc, footPt - 0.10 * sc);
      ctx.lineTo(x - 0.12 * sc, footPt - 0.06 * sc);
      ctx.stroke();
      // Toe claws (3 tiny green tips poking out the front of the bandage).
      ctx.fillStyle = G_MID;
      for (let i = 0; i < 3; i++) {
        const cx = x - 0.07 * sc + i * 0.07 * sc;
        ctx.beginPath();
        ctx.moveTo(cx - 0.020 * sc, footPt + 0.020 * sc);
        ctx.lineTo(cx, footPt + 0.060 * sc);
        ctx.lineTo(cx + 0.020 * sc, footPt + 0.020 * sc);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
      }
      // Foot-plant dust.
      if (footLift < 0.02 * sc && p.moving > 0.2) {
        ctx.fillStyle = `rgba(180,180,170,${0.20 * p.moving})`;
        ctx.beginPath();
        ctx.ellipse(x, baseY + 0.02 * sc, 0.22 * sc, 0.06 * sc, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawFrontLeg(-1, liftL);
    drawFrontLeg(1, liftR);

    // Tunic — cream sack with jagged hem.
    {
      ctx.fillStyle = G_CREAM;
      ctx.beginPath();
      ctx.moveTo(-0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(-0.44 * sc, (shoY + hipY) * 0.5, -0.36 * sc, hipY + 0.06 * sc);
      // jagged hem
      ctx.lineTo(-0.26 * sc, hipY + 0.22 * sc);
      ctx.lineTo(-0.14 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.02 * sc, hipY + 0.24 * sc);
      ctx.lineTo(0.10 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.22 * sc, hipY + 0.22 * sc);
      ctx.lineTo(0.36 * sc, hipY + 0.06 * sc);
      ctx.quadraticCurveTo(0.44 * sc, (shoY + hipY) * 0.5, 0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(0, shoY - 0.12 * sc, -0.34 * sc, shoY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.05;
      ctx.stroke();
      // Right-side shade band.
      ctx.fillStyle = `rgba(56,102,65,0.30)`;
      ctx.beginPath();
      ctx.moveTo(0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(0.44 * sc, (shoY + hipY) * 0.5, 0.36 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.12 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.10 * sc, shoY + 0.00 * sc);
      ctx.closePath();
      ctx.fill();
      // Centerline lacing.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(0, shoY + 0.06 * sc);
      ctx.lineTo(0, hipY + 0.04 * sc);
      ctx.stroke();
      // X-stitches down the lace.
      ctx.lineWidth = 0.018 * sc;
      for (let i = 0; i < 3; i++) {
        const ty = lerp(shoY + 0.12 * sc, hipY - 0.04 * sc, i / 2);
        ctx.beginPath();
        ctx.moveTo(-0.06 * sc, ty);
        ctx.lineTo(0.06 * sc, ty + 0.04 * sc);
        ctx.moveTo(0.06 * sc, ty);
        ctx.lineTo(-0.06 * sc, ty + 0.04 * sc);
        ctx.stroke();
      }
      // Stitched patch on one side.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.018 * sc;
      ctx.setLineDash([0.030 * sc, 0.024 * sc]);
      ctx.beginPath();
      ctx.rect(0.10 * sc, shoY + 0.12 * sc, 0.14 * sc, 0.16 * sc);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Rope sash with knot.
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.38 * sc, hipY + 0.02 * sc, 0.76 * sc, 0.080 * sc, 0.020 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.fillStyle = G_MID;
    rr(ctx, -0.36 * sc, hipY + 0.04 * sc, 0.72 * sc, 0.040 * sc, 0.015 * sc);
    ctx.fill();
    // Knot bump (front center).
    ctx.fillStyle = G_DARK;
    ctx.beginPath();
    ctx.arc(0, hipY + 0.06 * sc, 0.065 * sc, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    // Knot tails.
    ctx.fillStyle = G_DARK;
    for (const sx2 of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx2 * 0.05 * sc, hipY + 0.08 * sc);
      ctx.lineTo(sx2 * 0.16 * sc, hipY + 0.20 * sc);
      ctx.lineTo(sx2 * 0.10 * sc, hipY + 0.22 * sc);
      ctx.lineTo(sx2 * 0.02 * sc, hipY + 0.10 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    }

    // ── arms + dagger ────────────────────────────────────────────────────
    // Off (left, viewer-right since pre-face) hand: rests at the side.
    // Dagger (right, viewer-left) hand: held forward + to the side, swings
    // across body on strike.
    {
      const offShX = -0.30 * sc, offShY = shoY + 0.04 * sc;
      const offAng = 1.50 + windPhase * 0.10;
      const offHandX = offShX + Math.cos(offAng + Math.PI) * 0.36 * sc;
      const offHandY = offShY + Math.sin(offAng + Math.PI) * 0.36 * sc;
      ctx.fillStyle = G_MID;
      capsule(ctx, offShX, offShY, offHandX, offHandY, 0.080 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = G_LIME;
      capsule(ctx, offShX - 0.02 * sc, offShY, offHandX - 0.02 * sc, offHandY, 0.018 * sc);
      ctx.fill();
      ctx.save();
      ctx.translate(offHandX, offHandY);
      drawHand();
      ctx.restore();
    }

    // Dagger arm — held to the right (after p.face) of the body. Swings
    // across the chest on strike.
    const dShX = 0.30 * sc, dShY = shoY + 0.04 * sc;
    // Rest: arm out-and-down, blade out to the side
    const restAng = 0.55, windAng = -1.20, hitAng = 2.40;
    let armAng;
    if (p.atk > 0) {
      if (s < 0.30)       armAng = lerp(restAng, windAng, easeOut(s / 0.30));
      else if (s < 0.62)  armAng = lerp(windAng, hitAng, easeOut((s - 0.30) / 0.32));
      else                armAng = lerp(hitAng,  restAng, easeInOut((s - 0.62) / 0.38));
    } else {
      armAng = restAng;
    }
    const armL = 0.44 * sc;
    const dHandX = dShX + Math.cos(armAng) * armL;
    const dHandY = dShY + Math.sin(armAng) * armL;

    if (swingPhase > 0.05 && p.atk > 0) {
      const trailStart = lerp(windAng, hitAng,
                              easeOut(Math.max(0, (s - 0.30) / 0.32 - 0.30)));
      ctx.strokeStyle = `rgba(242,232,207,${0.40 * swingPhase})`;
      ctx.lineWidth = 0.16 * sc;
      ctx.beginPath();
      ctx.arc(dShX, dShY, armL + 0.28 * sc, trailStart, armAng, false);
      ctx.stroke();
      ctx.strokeStyle = `rgba(188,71,73,${0.42 * swingPhase})`;
      ctx.lineWidth = 0.06 * sc;
      ctx.beginPath();
      ctx.arc(dShX, dShY, armL + 0.40 * sc, trailStart, armAng, false);
      ctx.stroke();
    }

    ctx.fillStyle = G_MID;
    capsule(ctx, dShX, dShY, dHandX, dHandY, 0.090 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.fillStyle = G_LIME;
    capsule(ctx, dShX, dShY - 0.02 * sc, dHandX, dHandY - 0.02 * sc, 0.022 * sc);
    ctx.fill();
    // Wrist bandage.
    ctx.save();
    ctx.translate(dHandX - Math.cos(armAng) * 0.10 * sc,
                  dHandY - Math.sin(armAng) * 0.10 * sc);
    ctx.rotate(armAng + Math.PI / 2);
    ctx.fillStyle = G_CREAM;
    rr(ctx, -0.10 * sc, -0.045 * sc, 0.20 * sc, 0.090 * sc, 0.028 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(dHandX, dHandY);
    ctx.rotate(armAng);
    ctx.save();
    ctx.rotate(-armAng);
    drawHand();
    ctx.restore();
    drawDagger(strikePop);
    ctx.restore();

    if (strikePop > 0.10) {
      const tipX = dHandX + Math.cos(armAng) * 0.46 * sc;
      const tipY = dHandY + Math.sin(armAng) * 0.46 * sc;
      ctx.fillStyle = `rgba(242,232,207,${0.85 * strikePop})`;
      const rs = 0.14 * sc * strikePop;
      ctx.beginPath();
      ctx.moveTo(tipX - rs, tipY);
      ctx.lineTo(tipX, tipY - rs);
      ctx.lineTo(tipX + rs, tipY);
      ctx.lineTo(tipX, tipY + rs);
      ctx.closePath();
      ctx.fill();
    }

    // HEAD (front, on top).
    {
      ctx.save();
      ctx.translate(0, headY);
      ctx.rotate(headTilt * 0.4);
      // Big round head.
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.ellipse(0, 0, headR * 1.08, headR * 1.00, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.1; ctx.stroke();
      // Right-side shadow.
      ctx.fillStyle = `rgba(56,102,65,0.45)`;
      ctx.beginPath();
      ctx.ellipse(headR * 0.45, 0.06 * sc, headR * 0.45, headR * 0.78, 0, 0, TAU);
      ctx.fill();
      // Top + left highlight.
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.ellipse(-headR * 0.20, -headR * 0.55, headR * 0.50, headR * 0.18, 0, 0, TAU);
      ctx.fill();
      // Both cheek highlights.
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.arc(-headR * 0.50, headR * 0.20, headR * 0.12, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(headR * 0.50, headR * 0.20, headR * 0.12, 0, TAU);
      ctx.fill();

      // BOTH pointy ears.
      drawEar(-headR * 0.95, -headR * 0.20, -1, -0.10 + earWob * 0.5 + earTwitch * 0.4);
      drawEar(headR * 0.95, -headR * 0.20, 1, -0.10 - earWob * 0.4 + earTwitch * 0.3);

      // Hoop earring on the (viewer-left) ear lobe.
      ctx.strokeStyle = G_LIME; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.arc(-headR * 0.92, headR * 0.20, 0.040 * sc, 0, TAU);
      ctx.stroke();

      // Red headband across the forehead.
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.98, -headR * 0.22);
      ctx.quadraticCurveTo(0, -headR * 0.46, headR * 0.98, -headR * 0.22);
      ctx.lineTo(headR * 0.95, -headR * 0.05);
      ctx.quadraticCurveTo(0, -headR * 0.34, -headR * 0.95, -headR * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      // Headband knot tails (poking up out of the forehead, one to each side).
      const tC = (p.t + p.phase) * 5.0;
      const tflut = Math.sin(tC) * (0.05 + p.moving * 0.10) * sc;
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.18, -headR * 0.42);
      ctx.lineTo(-headR * 0.40 + tflut, -headR * 0.72);
      ctx.lineTo(-headR * 0.30 + tflut * 0.6, -headR * 0.62);
      ctx.lineTo(-headR * 0.10, -headR * 0.38);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(headR * 0.10, -headR * 0.38);
      ctx.lineTo(headR * 0.32 + tflut * 0.8, -headR * 0.70);
      ctx.lineTo(headR * 0.42 + tflut * 0.5, -headR * 0.60);
      ctx.lineTo(headR * 0.18, -headR * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();

      // Big nose (central nub).
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.10, headR * 0.06);
      ctx.quadraticCurveTo(0, headR * 0.42, headR * 0.10, headR * 0.06);
      ctx.lineTo(headR * 0.06, headR * 0.30);
      ctx.lineTo(-headR * 0.06, headR * 0.30);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.arc(-headR * 0.02, headR * 0.16, headR * 0.05, 0, TAU);
      ctx.fill();

      // BOTH eyes.
      drawEye(-headR * 0.30, -headR * 0.04, 0.95);
      drawEye(headR * 0.30, -headR * 0.04, 0.95);

      // Brow ridges (predator focus on attack).
      ctx.strokeStyle = G_DARK;
      ctx.lineWidth = 0.026 * sc;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.50, -headR * 0.20 + windPhase * 0.06);
      ctx.quadraticCurveTo(-headR * 0.30, -headR * 0.30 + windPhase * 0.08,
                           -headR * 0.10, -headR * 0.16 + windPhase * 0.04);
      ctx.moveTo(headR * 0.10, -headR * 0.16 + windPhase * 0.04);
      ctx.quadraticCurveTo(headR * 0.30, -headR * 0.30 + windPhase * 0.08,
                           headR * 0.50, -headR * 0.20 + windPhase * 0.06);
      ctx.stroke();

      // Grin.
      drawGrinFront(0, headR * 0.46);

      ctx.restore();
    }

  // ────────────────────────────────────────────────────────────────────────
  // ── BACK VIEW ──────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────
  } else {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.04 * sc;
    ctx.translate(sway, 0);

    // Legs.
    const legSpreadB = 0.14 * sc;
    const liftL = Math.max(0, sw)  * 0.18 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.18 * sc * p.moving;
    const drawBackLeg = (side, footLift) => {
      const x = side * legSpreadB;
      const footPt = baseY - footLift;
      ctx.fillStyle = G_MID;
      capsule(ctx, x, hipY, x, footPt - 0.02 * sc, 0.110 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Forest-green shadow down the back.
      ctx.fillStyle = `rgba(56,102,65,0.55)`;
      capsule(ctx, x, hipY + 0.10 * sc, x, footPt - 0.10 * sc, 0.060 * sc);
      ctx.fill();
      // Lime calf highlight.
      ctx.fillStyle = G_LIME;
      capsule(ctx, x - side * 0.045 * sc, hipY + 0.16 * sc,
                   x - side * 0.045 * sc, footPt - 0.12 * sc, 0.020 * sc);
      ctx.fill();
      // Bandaged foot heel (showing from behind).
      ctx.fillStyle = G_CREAM;
      rr(ctx, x - 0.15 * sc, footPt - 0.16 * sc, 0.30 * sc, 0.18 * sc, 0.05 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.020 * sc;
      ctx.beginPath();
      ctx.moveTo(x - 0.10 * sc, footPt - 0.10 * sc);
      ctx.lineTo(x + 0.10 * sc, footPt - 0.06 * sc);
      ctx.moveTo(x + 0.10 * sc, footPt - 0.10 * sc);
      ctx.lineTo(x - 0.10 * sc, footPt - 0.06 * sc);
      ctx.stroke();
    };
    drawBackLeg(-1, liftL);
    drawBackLeg(1, liftR);

    // Tunic back (jagged hem).
    {
      ctx.fillStyle = G_CREAM;
      ctx.beginPath();
      ctx.moveTo(-0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(-0.44 * sc, (shoY + hipY) * 0.5, -0.36 * sc, hipY + 0.06 * sc);
      // jagged hem
      ctx.lineTo(-0.26 * sc, hipY + 0.22 * sc);
      ctx.lineTo(-0.14 * sc, hipY + 0.06 * sc);
      ctx.lineTo(-0.02 * sc, hipY + 0.24 * sc);
      ctx.lineTo(0.10 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.22 * sc, hipY + 0.22 * sc);
      ctx.lineTo(0.36 * sc, hipY + 0.06 * sc);
      ctx.quadraticCurveTo(0.44 * sc, (shoY + hipY) * 0.5, 0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(0, shoY - 0.12 * sc, -0.34 * sc, shoY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.05;
      ctx.stroke();
      // Right side shade.
      ctx.fillStyle = `rgba(56,102,65,0.35)`;
      ctx.beginPath();
      ctx.moveTo(0.34 * sc, shoY + 0.02 * sc);
      ctx.quadraticCurveTo(0.44 * sc, (shoY + hipY) * 0.5, 0.36 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.12 * sc, hipY + 0.06 * sc);
      ctx.lineTo(0.10 * sc, shoY + 0.00 * sc);
      ctx.closePath();
      ctx.fill();
      // Cloth fold line down the back.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(0, shoY + 0.04 * sc);
      ctx.quadraticCurveTo(0.02 * sc, (shoY + hipY) * 0.5, 0, hipY + 0.04 * sc);
      ctx.stroke();
      // Stitched patch on the back.
      ctx.strokeStyle = G_DARK; ctx.lineWidth = 0.018 * sc;
      ctx.setLineDash([0.030 * sc, 0.024 * sc]);
      ctx.beginPath();
      ctx.rect(-0.20 * sc, shoY + 0.16 * sc, 0.16 * sc, 0.20 * sc);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sash with knot at the back.
    ctx.fillStyle = G_DARK;
    rr(ctx, -0.38 * sc, hipY + 0.02 * sc, 0.76 * sc, 0.080 * sc, 0.020 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
    ctx.fillStyle = G_MID;
    rr(ctx, -0.36 * sc, hipY + 0.04 * sc, 0.72 * sc, 0.040 * sc, 0.015 * sc);
    ctx.fill();
    // Dagger pommel hanging at the (viewer-right) hip — the back view shows
    // it tucked at the waist.
    {
      ctx.save();
      ctx.translate(0.24 * sc, hipY + 0.04 * sc);
      ctx.rotate(0.30);
      // small sheathed dagger silhouette (just the handle showing above sash)
      ctx.fillStyle = G_DARK;
      rr(ctx, -0.04 * sc, -0.20 * sc, 0.10 * sc, 0.20 * sc, 0.020 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.arc(0.01 * sc, -0.22 * sc, 0.040 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.4; ctx.stroke();
      // Crossguard sliver.
      ctx.fillStyle = G_LIME;
      rr(ctx, -0.06 * sc, -0.03 * sc, 0.14 * sc, 0.040 * sc, 0.012 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.4; ctx.stroke();
      ctx.restore();
    }

    // Off arms hanging at sides (idle pose; both visible from behind).
    {
      for (const side of [-1, 1]) {
        const armShX = side * 0.30 * sc;
        const armShY = shoY + 0.04 * sc;
        const armHandX = side * 0.34 * sc;
        const armHandY = hipY + 0.08 * sc;
        ctx.fillStyle = G_MID;
        capsule(ctx, armShX, armShY, armHandX, armHandY, 0.080 * sc);
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
        ctx.fillStyle = `rgba(56,102,65,0.45)`;
        capsule(ctx, armShX + side * 0.02 * sc, armShY + 0.02 * sc,
                     armHandX + side * 0.02 * sc, armHandY - 0.02 * sc, 0.030 * sc);
        ctx.fill();
        ctx.save();
        ctx.translate(armHandX, armHandY);
        drawHand();
        ctx.restore();
      }
    }

    // HEAD from behind.
    {
      ctx.save();
      ctx.translate(0, headY);
      ctx.rotate(headTilt * 0.4);
      // Big round head.
      ctx.fillStyle = G_MID;
      ctx.beginPath();
      ctx.ellipse(0, 0, headR * 1.08, headR * 1.00, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.1; ctx.stroke();
      // Top-of-head lime cap (light from upper-left).
      ctx.fillStyle = G_LIME;
      ctx.beginPath();
      ctx.ellipse(-headR * 0.15, -headR * 0.55, headR * 0.62, headR * 0.22, 0, 0, TAU);
      ctx.fill();
      // Right-side shadow.
      ctx.fillStyle = `rgba(56,102,65,0.50)`;
      ctx.beginPath();
      ctx.ellipse(headR * 0.50, 0.06 * sc, headR * 0.40, headR * 0.78, 0, 0, TAU);
      ctx.fill();
      // Centre crease (slight valley running down the back of the head).
      ctx.strokeStyle = G_DARK;
      ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(0, -headR * 0.70);
      ctx.quadraticCurveTo(0.01 * sc, 0, 0, headR * 0.70);
      ctx.stroke();

      // BOTH pointy ears.
      drawEar(-headR * 0.95, -headR * 0.20, -1, -0.10 + earWob * 0.5 + earTwitch * 0.4);
      drawEar(headR * 0.95, -headR * 0.20, 1, -0.10 - earWob * 0.4 + earTwitch * 0.3);

      // Red headband going around (the knot is the prominent feature here).
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.98, -headR * 0.22);
      ctx.quadraticCurveTo(0, -headR * 0.40, headR * 0.98, -headR * 0.22);
      ctx.lineTo(headR * 0.95, -headR * 0.05);
      ctx.quadraticCurveTo(0, -headR * 0.30, -headR * 0.95, -headR * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
      // Big knot bow at the back of the head.
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.ellipse(0, -headR * 0.10, headR * 0.18, headR * 0.10, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.6; ctx.stroke();
      const tC = (p.t + p.phase) * 5.0;
      const tflut = Math.sin(tC) * (0.05 + p.moving * 0.10) * sc;
      // Two trailing knot tails.
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.10, -headR * 0.10);
      ctx.lineTo(-headR * 0.30 + tflut, headR * 0.10);
      ctx.lineTo(-headR * 0.18 + tflut * 0.6, headR * 0.16);
      ctx.lineTo(-headR * 0.02, -headR * 0.06);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.fillStyle = G_RED;
      ctx.beginPath();
      ctx.moveTo(headR * 0.02, -headR * 0.06);
      ctx.lineTo(headR * 0.22 - tflut * 0.8, headR * 0.12);
      ctx.lineTo(headR * 0.32 - tflut * 0.5, headR * 0.06);
      ctx.lineTo(headR * 0.10, -headR * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();

      ctx.restore();
    }
  }

  // ── hit flash (white wash over the whole figure) ───────────────────────
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.55 * p.flash})`;
    rr(ctx, -0.50 * sc, headY - 0.55 * sc,
            1.00 * sc, (baseY - headY) + 0.65 * sc, 0.22 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
  return true;
}

export function markGoblin(id) {
  const a = anim.get(id);
  if (a) a.wasGoblin = true;
}

// ── Polished 2.5D Minion — a small flying bat-imp with leathery wings,
//    sharp horns and glowing eyes. The engine spawns 3 per deploy (count
//    = 3); each instance gets its own rig via getAnim() so wings de-sync
//    naturally on p.phase. Continuously flaps, hover-bobs, and FLOATS above
//    its ground point. Three-phase attack:
//       WINDUP  : head pulls back, mouth opens, eyes flare
//       STRIKE  : head lunges forward, a "ptui" puff fires at the mouth
//                 (the engine handles the actual projectile spawn)
//       RECOVERY: head returns to neutral, mouth closes
//    Wings have three finger struts on a dark-navy membrane with a
//    light-slate leading edge. Spawn rune ring on the ground (the bat
//    physically spawned there), hit flash, and a small wing-scrap death
//    poof complete the rig.
//
//    Spec note: drawMinion INTERNALLY handles the hover offset — callers
//    pass the ground point (gy), and the body is drawn 0.9 * sc above it
//    with the cast shadow staying on the ground at gy.
export function drawMinion(ctx, gx, gy, tile, p) {
  // ── Function-local palette (declared inside drawMinion to avoid name
  //    collisions with other units' identifiers at module scope) ──────────
  //   #0d1b2a near-black navy  — outlines, deepest body silhouette,
  //                              deep wing-membrane shadow
  //   #1b263b dark navy        — wing membrane base, body shadow side,
  //                              horn shadows
  //   #415a77 slate blue       — body mid-tone, wing membrane mid,
  //                              ear inner
  //   #778da9 light slate      — body highlight, wing leading edge / claw,
  //                              horn highlight
  //   #e0e1dd off-white        — fangs, eye glow center, claw tips,
  //                              wing vein highlights
  const M_INK   = '#0d1b2a';
  const M_NAVY  = '#1b263b';
  const M_SLATE = '#415a77';
  const M_LIGHT = '#778da9';
  const M_OFF   = '#e0e1dd';

  // Similar to Archer in size; smaller than Knight. Spec: S = tile * 0.52.
  const S = tile * 0.52;
  const grow = lerp(0.55, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── hover kinematics ───────────────────────────────────────────────────
  // Body floats this much above the ground point (gy). The cast shadow
  // stays anchored at gy. (Spec: "hover height = 0.9 * sc".)
  const HOVER = 0.9 * sc;
  // Continuous wing-flap angle in [-1, 1]. Drives both the wing fold and
  // the membrane's visible area. (Spec rhythm: ~14 rad/s.)
  const flap  = Math.sin(p.t * 14 + p.phase);
  // Gentle hover bob: body floats up/down about HOVER. (Spec rhythm.)
  const hbob  = Math.sin(p.t * 3 + p.phase) * 0.06 * sc;
  // Small "settle" sync with the flap — body dips a hair on the upbeat
  // (wings push down → body lifts), giving the hover real weight.
  const flapLift = flap * 0.04 * sc;

  // Idle ear / tail twitches — de-synced from the flap rhythm.
  const earTwitch = Math.sin(p.t * 2.6 + p.phase * 1.7) * 0.06;
  const tailWag   = Math.sin(p.t * 2.0 + p.phase * 1.3) * 0.20;

  // ── attack timeline ────────────────────────────────────────────────────
  // s grows 0→1 across one hitSpeed swing.
  //   0.00..0.30  WINDUP   : head pulls back, eyes flare, mouth opens
  //   0.30..0.55  STRIKE   : head lunges forward, releases spit ("ptui" puff)
  //   0.55..1.00  RECOVERY : head returns to neutral, mouth closes
  const s = 1 - p.atk;
  let windPhase = 0, strikePhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.30)       windPhase = easeOut(s / 0.30);
    else if (s < 0.55){ windPhase = 1; strikePhase = easeOut((s - 0.30) / 0.25); }
    else              { strikePhase = 1; recoverPhase = easeInOut((s - 0.55) / 0.45); }
  }
  // Brief intense puff at the moment of release.
  const releasePop = clamp01(1 - Math.abs(s - 0.40) * 10);
  // Body lunge — small crouch-back on windup, lurches forward on strike,
  // settles on recovery. p.face flips so the lunge always points "forward".
  const lunge  = (windPhase * -0.08 + strikePhase * 0.22 + recoverPhase * -0.06) * sc * p.face;
  const recoil = p.flash * 0.10 * sc * -p.face;

  // Mouth opens during windup, wide on strike, closes on recovery.
  const mouthOpen = clamp01(windPhase * 0.7 + strikePhase * 1.0
                            - recoverPhase * strikePhase * 0.8);
  // Eye glow pulses on attack and on hit (spec: "pulse on p.atk / p.flash").
  const eyeGlow = 0.70 + windPhase * 0.30 + releasePop * 0.30 + p.flash * 0.30;

  ctx.save();
  ctx.globalAlpha = lerp(0.20, 1, easeOut(p.spawnF));

  // ── ground cast shadow (anchored at gy, BELOW the floating body) ───────
  // Shadow shrinks on the downbeat (flap > 0 → wings push down, bat lifts
  // higher) and grows on the upbeat — sells the up/down hover even on a
  // flat ground.
  const shR = sc * (0.62 + flap * 0.06);
  ctx.fillStyle = `rgba(0,0,0,${0.42 - flap * 0.10})`;
  ctx.beginPath();
  ctx.ellipse(gx, gy + sc * 0.03, shR, shR * 0.34, 0, 0, TAU);
  ctx.fill();

  // ── spawn rune ring (dark navy + light slate, off-white cardinal
  //    sparkles). Drawn at gy since the Minion physically spawns from the
  //    deploy tile on the ground.
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(27,38,59,${0.92 * inv})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy,
                sc * (0.80 + sf * 0.80),
                sc * 0.30 * (0.80 + sf * 0.80), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(119,141,169,${0.78 * inv})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy,
                sc * (0.60 + sf * 0.60),
                sc * 0.24 * (0.60 + sf * 0.60), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(224,225,221,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + sf * 0.6;
      const rx = sc * (0.76 + sf * 0.76), ry = sc * 0.28 * (0.76 + sf * 0.76);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.07 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter the body's local space. Origin = body CENTER (no feet anchor —
  // the bat floats). +x = facing direction; -y = up the screen. Apply the
  // hover offset, the hover bob, and the per-flap lift here so EVERYTHING
  // drawn below (wings, body, head, tail) gets the floating motion.
  ctx.translate(gx + lunge + recoil, gy - HOVER + hbob + flapLift);
  ctx.scale(p.face, 1);
  // Subtle pitch from the flap (wings push down → bat tilts up a hair)
  // plus the attack-phase lean.
  ctx.rotate(flap * 0.03 + windPhase * -0.10 + strikePhase * 0.16
             - recoverPhase * 0.04);

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = M_INK;
  const OW = 0.060 * sc;

  // ── proportions ────────────────────────────────────────────────────────
  // The body is pear-shaped — wider at the chest/shoulders, narrowing
  // toward the bottom (where the legs/tail emerge). The head sits above
  // the body with a stubby neck.
  const bodyCy = 0;
  const bodyR  = 0.40 * sc;
  const headCy = -0.62 * sc;
  const headR  = 0.32 * sc;

  // Head lunge — additional translate applied only to the head/horns so
  // the body doesn't whip around with the same magnitude as the head.
  const headDX = (windPhase * -0.12 + strikePhase * 0.20 + recoverPhase * -0.04) * sc;
  const headDY = (windPhase * -0.06 + strikePhase *  0.04 + recoverPhase * -0.02) * sc;

  // ── reusable: a single wing ────────────────────────────────────────────
  // (cx, cy)  = shoulder anchor (where the wing leaves the body)
  // baseAng   = nominal pitch of the wing humerus (rad; 0 = +x, -PI/2 = up)
  // span      = wing length (sc-scaled)
  // openness  = 0..1 (how far it spreads; 0 = folded, 1 = full extension)
  // far       = if true, dim slightly (used for the back wing in side view)
  const drawWing = (cx, cy, baseAng, span, openness, far) => {
    const alphaMul = far ? 0.65 : 1;
    const tipL  = span;
    // Humerus (upper-arm) endpoint — spreads outward as openness rises.
    const armAng = baseAng - 0.22 * openness;
    const armEx  = Math.cos(armAng) * span * 0.36;
    const armEy  = Math.sin(armAng) * span * 0.36;
    // Three finger tips — each is the outer end of a "phalange" that the
    // membrane stretches across. Slightly different angles give the wing
    // its characteristic bat fan + scalloped trailing edge.
    const f1Ang = baseAng - 0.50 * openness - 0.05;
    const f2Ang = baseAng - 0.20 * openness + 0.10;
    const f3Ang = baseAng + 0.20 * openness + 0.32;
    const f1x = armEx + Math.cos(f1Ang) * tipL * 0.78;
    const f1y = armEy + Math.sin(f1Ang) * tipL * 0.78;
    const f2x = armEx + Math.cos(f2Ang) * tipL * 0.90;
    const f2y = armEy + Math.sin(f2Ang) * tipL * 0.90;
    const f3x = armEx + Math.cos(f3Ang) * tipL * 0.75;
    const f3y = armEy + Math.sin(f3Ang) * tipL * 0.75;

    ctx.save();
    ctx.translate(cx, cy);

    // Membrane fill — concave polygon between body, fingertips, and the
    // wrist (armE). The scallops between fingertips are the classic bat
    // wing notches.
    ctx.fillStyle = `rgba(27,38,59,${0.95 * alphaMul})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(armEx, armEy);
    ctx.lineTo(f1x, f1y);
    ctx.quadraticCurveTo(
      (f1x + f2x) * 0.5 - Math.sin(f1Ang + 0.4) * span * 0.12,
      (f1y + f2y) * 0.5 + Math.cos(f1Ang + 0.4) * span * 0.12,
      f2x, f2y
    );
    ctx.quadraticCurveTo(
      (f2x + f3x) * 0.5 - Math.sin(f2Ang + 0.4) * span * 0.12,
      (f2y + f3y) * 0.5 + Math.cos(f2Ang + 0.4) * span * 0.12,
      f3x, f3y
    );
    ctx.quadraticCurveTo(armEx * 0.30, armEy * 0.30 + span * 0.16, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(13,27,42,${0.95 * alphaMul})`;
    ctx.lineWidth = OW * 0.85;
    ctx.stroke();

    // Mid-slate sub-fill near the body — cel-shaded gradient effect:
    // darker membrane interior, brighter near the leading edge.
    ctx.fillStyle = `rgba(65,90,119,${0.55 * alphaMul})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(armEx * 0.85, armEy * 0.85);
    ctx.lineTo(f2x * 0.55, f2y * 0.55);
    ctx.quadraticCurveTo(armEx * 0.25, armEy * 0.25 + span * 0.10, 0, 0);
    ctx.closePath();
    ctx.fill();

    // Finger struts (the "bones" along the wing) — light slate leading
    // edges over the membrane.
    ctx.strokeStyle = `rgba(119,141,169,${0.95 * alphaMul})`;
    ctx.lineWidth = 0.040 * sc;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(armEx, armEy);
    ctx.moveTo(armEx, armEy); ctx.lineTo(f1x, f1y);
    ctx.moveTo(armEx, armEy); ctx.lineTo(f2x, f2y);
    ctx.moveTo(armEx, armEy); ctx.lineTo(f3x, f3y);
    ctx.stroke();

    // Off-white vein highlight along the outer portion of each finger.
    ctx.strokeStyle = `rgba(224,225,221,${0.45 * alphaMul})`;
    ctx.lineWidth = 0.018 * sc;
    for (const tip of [[f1x, f1y], [f2x, f2y], [f3x, f3y]]) {
      const mx = armEx + (tip[0] - armEx) * 0.35;
      const my = armEy + (tip[1] - armEy) * 0.35;
      ctx.beginPath();
      ctx.moveTo(mx, my); ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
    }

    // Tiny dark-navy thumb claw at the wrist.
    ctx.fillStyle = `rgba(13,27,42,${alphaMul})`;
    ctx.beginPath();
    ctx.moveTo(armEx, armEy);
    ctx.lineTo(armEx + Math.cos(baseAng - 1.0) * 0.10 * sc,
               armEy + Math.sin(baseAng - 1.0) * 0.10 * sc);
    ctx.lineTo(armEx + Math.cos(baseAng - 0.3) * 0.04 * sc,
               armEy + Math.sin(baseAng - 0.3) * 0.04 * sc);
    ctx.closePath();
    ctx.fill();

    // Light-slate fingertip caps.
    ctx.fillStyle = `rgba(119,141,169,${alphaMul})`;
    for (const tip of [[f1x, f1y], [f2x, f2y], [f3x, f3y]]) {
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 0.025 * sc, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  };

  // Convenience: draw a mirrored wing (used for the LEFT wing in symmetric
  // front/back views). Wraps drawWing in a -1 x-scale so all angle math
  // stays "right-handed" inside drawWing.
  const drawWingMirror = (cx, cy, baseAng, span, openness, far) => {
    ctx.save();
    ctx.scale(-1, 1);
    drawWing(cx, cy, baseAng, span, openness, far);
    ctx.restore();
  };

  // ── reusable: a single horn (slim curving wedge up-and-back) ───────────
  // (cx, cy) = root, dir = +1 (right) / -1 (left), tilt = base rotation.
  const drawHorn = (cx, cy, dir, tilt) => {
    const L = 0.32 * sc;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt * dir);
    // Dark navy outer wedge.
    ctx.fillStyle = M_NAVY;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(dir * L * 0.35, -L * 0.55,
                         dir * L * 0.65, -L * 0.95);
    ctx.lineTo(dir * L * 0.50, -L * 0.95);
    ctx.quadraticCurveTo(dir * L * 0.18, -L * 0.45, 0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.70; ctx.stroke();
    // Light-slate highlight along the front (concave) edge.
    ctx.fillStyle = M_LIGHT;
    ctx.beginPath();
    ctx.moveTo(dir * 0.03 * sc, -0.04 * sc);
    ctx.quadraticCurveTo(dir * L * 0.30, -L * 0.45,
                         dir * L * 0.50, -L * 0.85);
    ctx.lineTo(dir * L * 0.42, -L * 0.85);
    ctx.quadraticCurveTo(dir * L * 0.15, -L * 0.40,
                         dir * 0.02 * sc, -0.04 * sc);
    ctx.closePath();
    ctx.fill();
    // Tiny off-white shine near the tip.
    ctx.fillStyle = M_OFF;
    ctx.beginPath();
    ctx.arc(dir * L * 0.55, -L * 0.78, 0.022 * sc, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  // ── reusable: a glowing eye ────────────────────────────────────────────
  // Dark navy socket holds a luminous off-white center over a soft halo;
  // pulse driven by `eyeGlow` (computed up top).
  const drawEye = (cx, cy, scale) => {
    const g = eyeGlow;
    const r = 0.10 * sc * scale;
    // soft halo (extra menace)
    ctx.fillStyle = `rgba(224,225,221,${0.35 * g})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.5, 0, TAU);
    ctx.fill();
    // dark socket
    ctx.fillStyle = M_INK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    // luminous center
    ctx.fillStyle = `rgba(224,225,221,${0.95 * g})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, TAU);
    ctx.fill();
    // bright catchlight
    ctx.fillStyle = `rgba(255,255,255,${g})`;
    ctx.beginPath();
    ctx.arc(cx - r * 0.18, cy - r * 0.18, r * 0.25, 0, TAU);
    ctx.fill();
  };

  // ── reusable: a single off-white fang (small triangle) ─────────────────
  const drawFang = (cx, cy, w, h) => {
    ctx.fillStyle = M_OFF;
    ctx.beginPath();
    ctx.moveTo(cx - w, cy);
    ctx.lineTo(cx + w, cy);
    ctx.lineTo(cx, cy + h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
  };

  // ── reusable: tail (thin, tapered, with arrowhead diamond tip) ─────────
  // (rootCx, rootCy) = where the tail emerges from the body
  // length = sc-scaled total length, dir = -1 (back-left) / 0 (down) / +1
  // (back-right), wag = per-frame sideways oscillation factor.
  const drawTail = (rootCx, rootCy, length, dir, wag) => {
    const L = length;
    ctx.save();
    ctx.translate(rootCx, rootCy);
    const dx = dir * L * 0.35 + wag * 0.10 * sc;
    const dy = L * 0.85;
    const midX = dir * L * 0.20 + wag * 0.18 * sc;
    const midY = L * 0.45;
    // Outer (thicker) dark-navy stroke.
    ctx.strokeStyle = M_NAVY;
    ctx.lineWidth = 0.10 * sc;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(midX, midY, dx, dy);
    ctx.stroke();
    // Ink outline.
    ctx.strokeStyle = M_INK; ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(midX, midY, dx, dy);
    ctx.stroke();
    // Slate highlight along the "lit" side of the shaft.
    ctx.strokeStyle = M_LIGHT; ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(0.02 * sc, 0.04 * sc);
    ctx.quadraticCurveTo(midX + 0.02 * sc, midY,
                         dx - 0.04 * sc, dy - 0.04 * sc);
    ctx.stroke();
    // Arrowhead tip diamond.
    ctx.save();
    ctx.translate(dx, dy);
    const tipAng = Math.atan2(dy - midY, dx - midX);
    ctx.rotate(tipAng);
    ctx.fillStyle = M_LIGHT;
    ctx.beginPath();
    ctx.moveTo(-0.06 * sc, 0);
    ctx.lineTo(0, -0.08 * sc);
    ctx.lineTo(0.14 * sc, 0);
    ctx.lineTo(0, 0.08 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
    // Small off-white shine in the diamond.
    ctx.fillStyle = M_OFF;
    ctx.beginPath();
    ctx.moveTo(0, -0.05 * sc);
    ctx.lineTo(0.10 * sc, 0);
    ctx.lineTo(0, 0.01 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();
  };

  // ── reusable: pear-shaped body silhouette ──────────────────────────────
  // Drawn centered at (0, bodyCy). `darkSideX` = ±1 picks which side gets
  // the cel-shaded shadow band (the "away" side from the light source).
  const drawBody = (darkSideX) => {
    // Main pear shape: ellipse top + tapered bottom.
    ctx.fillStyle = M_SLATE;
    ctx.beginPath();
    ctx.moveTo(-bodyR, bodyCy - 0.12 * sc);
    ctx.bezierCurveTo(
      -bodyR * 1.05, bodyCy - bodyR * 0.95,
       bodyR * 1.05, bodyCy - bodyR * 0.95,
       bodyR,        bodyCy - 0.12 * sc
    );
    ctx.bezierCurveTo(
      bodyR * 0.85, bodyCy + bodyR * 0.65,
      bodyR * 0.30, bodyCy + bodyR * 0.95,
      0,            bodyCy + bodyR * 0.95
    );
    ctx.bezierCurveTo(
      -bodyR * 0.30, bodyCy + bodyR * 0.95,
      -bodyR * 0.85, bodyCy + bodyR * 0.65,
      -bodyR,        bodyCy - 0.12 * sc
    );
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();

    // Dark-navy shadow band on the away side.
    ctx.fillStyle = `rgba(27,38,59,0.65)`;
    ctx.beginPath();
    ctx.moveTo(darkSideX * bodyR * 0.40, bodyCy - bodyR * 0.95);
    ctx.bezierCurveTo(
      darkSideX * bodyR * 1.05, bodyCy - bodyR * 0.55,
      darkSideX * bodyR * 0.95, bodyCy + bodyR * 0.55,
      darkSideX * bodyR * 0.30, bodyCy + bodyR * 0.90
    );
    ctx.lineTo(0, bodyCy + bodyR * 0.95);
    ctx.bezierCurveTo(
      darkSideX * bodyR * 0.10, bodyCy + bodyR * 0.55,
      darkSideX * bodyR * 0.20, bodyCy - bodyR * 0.40,
      darkSideX * bodyR * 0.10, bodyCy - bodyR * 0.90
    );
    ctx.closePath();
    ctx.fill();

    // Light-slate highlight crescent on the lit side (upper-left).
    ctx.fillStyle = `rgba(119,141,169,0.85)`;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.60, bodyCy - bodyR * 0.80);
    ctx.bezierCurveTo(
      -bodyR * 0.95, bodyCy - bodyR * 0.40,
      -bodyR * 0.85, bodyCy + bodyR * 0.25,
      -bodyR * 0.40, bodyCy + bodyR * 0.45
    );
    ctx.bezierCurveTo(
      -bodyR * 0.65, bodyCy - bodyR * 0.05,
      -bodyR * 0.55, bodyCy - bodyR * 0.55,
      -bodyR * 0.30, bodyCy - bodyR * 0.80
    );
    ctx.closePath();
    ctx.fill();

    // Belly seam — small dark line down the chest/belly center for depth.
    ctx.strokeStyle = `rgba(13,27,42,0.55)`;
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(0, bodyCy - bodyR * 0.70);
    ctx.lineTo(0, bodyCy + bodyR * 0.80);
    ctx.stroke();
  };

  // ── reusable: head (rounded, with cheek shadow + optional brow shadow) ─
  const drawHead = (showFaceShadow) => {
    ctx.fillStyle = M_SLATE;
    ctx.beginPath();
    ctx.ellipse(0, headCy, headR * 1.08, headR, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Dark-navy underside / chin shadow.
    ctx.fillStyle = `rgba(27,38,59,0.75)`;
    ctx.beginPath();
    ctx.ellipse(0, headCy + headR * 0.30, headR * 0.95, headR * 0.50, 0, 0, TAU);
    ctx.fill();
    // Light-slate cheek highlight (upper-left).
    ctx.fillStyle = `rgba(119,141,169,0.85)`;
    ctx.beginPath();
    ctx.ellipse(-headR * 0.30, headCy - headR * 0.30,
                headR * 0.55, headR * 0.30, -0.4, 0, TAU);
    ctx.fill();
    // Optional brow shadow under the horns.
    if (showFaceShadow) {
      ctx.fillStyle = `rgba(13,27,42,0.55)`;
      ctx.beginPath();
      ctx.ellipse(0, headCy - headR * 0.10,
                  headR * 0.95, headR * 0.30, 0, 0, TAU);
      ctx.fill();
    }
  };

  // ── reusable: "ptui" spit puff at the mouth during/after release ───────
  // (cx, cy) = mouth center in local frame. Drawn only while releasePop>0.
  const drawSpitPuff = (cx, cy) => {
    if (releasePop > 0.05) {
      // outer fading dark glob
      ctx.fillStyle = `rgba(13,27,42,${0.85 * releasePop})`;
      ctx.beginPath();
      ctx.arc(cx + 0.10 * sc, cy, 0.18 * sc * releasePop, 0, TAU);
      ctx.fill();
      // inner slate-blue volume
      ctx.fillStyle = `rgba(119,141,169,${0.85 * releasePop})`;
      ctx.beginPath();
      ctx.arc(cx + 0.12 * sc, cy - 0.02 * sc, 0.08 * sc * releasePop, 0, TAU);
      ctx.fill();
      // off-white wet-shine catch dot
      ctx.fillStyle = `rgba(224,225,221,${0.95 * releasePop})`;
      ctx.beginPath();
      ctx.arc(cx + 0.14 * sc, cy - 0.05 * sc, 0.030 * sc * releasePop, 0, TAU);
      ctx.fill();
      // 2 small fading droplet trails (back toward the mouth)
      ctx.fillStyle = `rgba(13,27,42,${0.55 * releasePop})`;
      ctx.beginPath();
      ctx.arc(cx + 0.04 * sc, cy + 0.04 * sc, 0.040 * sc * releasePop, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx - 0.04 * sc, cy + 0.08 * sc, 0.025 * sc * releasePop, 0, TAU);
      ctx.fill();
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // ── VIEW DISPATCH ─────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  if (p.view === 'side') {
    // ───── SIDE VIEW ───────────────────────────────────────────────────
    // Profile body, one wing big on the near side, one peeks behind the
    // body, tail dangles back, one visible horn (front), single glowing
    // eye in profile, two front fangs.

    // FAR wing (drawn first so it's occluded behind the body).
    {
      const openness = 0.55 + flap * 0.20;
      drawWing(-0.18 * sc, -0.22 * sc, -2.00 + flap * 0.20,
               0.95 * sc, openness, true);
    }

    // Tail (in profile, sweeping behind = local -x).
    drawTail(-0.18 * sc, 0.30 * sc, 0.60 * sc, -1, tailWag);

    // Body — shadow on the +x side (the bat is lit from upper-left).
    drawBody(1);

    // Tiny clawed leg tucked under the body (profile single leg).
    {
      ctx.fillStyle = M_NAVY;
      capsule(ctx, 0.04 * sc, 0.32 * sc, 0.12 * sc, 0.46 * sc, 0.045 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.fillStyle = M_LIGHT;
      for (const k of [-1, 0, 1]) {
        ctx.beginPath();
        ctx.moveTo(0.10 * sc + k * 0.025 * sc, 0.48 * sc);
        ctx.lineTo(0.10 * sc + k * 0.025 * sc + 0.020 * sc, 0.56 * sc);
        ctx.lineTo(0.10 * sc + k * 0.025 * sc - 0.005 * sc, 0.50 * sc);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Head + face (with its own lunge offset).
    ctx.save();
    ctx.translate(headDX, headDY);
    drawHead(true);

    // Profile ear (one visible, swept back).
    {
      const eAng = -0.30 + earTwitch;
      ctx.fillStyle = M_NAVY;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.40, headCy - headR * 0.70);
      ctx.quadraticCurveTo(-headR * 0.90, headCy - headR * 1.10 + eAng * 0.12 * sc,
                           -headR * 0.45, headCy - headR * 0.30);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.fillStyle = M_SLATE;
      ctx.beginPath();
      ctx.moveTo(-headR * 0.45, headCy - headR * 0.70);
      ctx.quadraticCurveTo(-headR * 0.75, headCy - headR * 0.95 + eAng * 0.10 * sc,
                           -headR * 0.50, headCy - headR * 0.35);
      ctx.closePath();
      ctx.fill();
    }

    // Near horn (front of head). The other horn is occluded; show a small
    // back-horn root peeking up behind the brow.
    drawHorn(headR * 0.30, headCy - headR * 0.70, 1, -0.30);
    ctx.fillStyle = M_NAVY;
    ctx.beginPath();
    ctx.moveTo(-headR * 0.20, headCy - headR * 0.80);
    ctx.quadraticCurveTo(-headR * 0.05, headCy - headR * 1.20,
                         headR * 0.04, headCy - headR * 0.85);
    ctx.lineTo(-headR * 0.12, headCy - headR * 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();

    // Single profile eye.
    drawEye(headR * 0.40, headCy - headR * 0.10, 1);

    // Mouth — opens with the attack. Two fangs always visible.
    {
      const mw = headR * (0.20 + mouthOpen * 0.40);
      const mh = headR * (0.06 + mouthOpen * 0.30);
      const mcx = headR * 0.70;
      const mcy = headCy + headR * 0.30;
      ctx.fillStyle = M_INK;
      ctx.beginPath();
      ctx.ellipse(mcx, mcy, mw, mh, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      drawFang(mcx - mw * 0.40, mcy - mh * 0.50, 0.030 * sc, 0.070 * sc);
      drawFang(mcx + mw * 0.10, mcy - mh * 0.50, 0.030 * sc, 0.085 * sc);
      drawSpitPuff(mcx, mcy);
    }

    ctx.restore();

    // NEAR wing (drawn last so it sits in front of the body).
    {
      const openness = 0.70 + flap * 0.25;
      drawWing(0.06 * sc, -0.18 * sc, -1.55 + flap * 0.40,
               1.05 * sc, openness, false);
    }

  } else if (p.view === 'front') {
    // ───── FRONT VIEW ──────────────────────────────────────────────────
    // Body facing camera, BOTH wings spread symmetrically, two horns, two
    // glowing eyes, fangs grinning.

    // Tail (behind body, slight wag).
    drawTail(0, 0.30 * sc, 0.55 * sc, 0, tailWag * 0.6);

    // BACK wings (drawn first; they overlap behind the body). The left
    // wing uses drawWingMirror to flip the wing geometry across the y-axis.
    {
      const openness = 0.75 + flap * 0.25;
      drawWingMirror(0.22 * sc, -0.20 * sc, -1.30 + flap * 0.30,
                     1.00 * sc, openness, false);
      drawWing      (0.22 * sc, -0.20 * sc, -1.30 + flap * 0.30,
                     1.00 * sc, openness, false);
    }

    // Body — shadow on the right (away from upper-left light).
    drawBody(-1);

    // Two clawed legs tucked under the body.
    for (const side of [-1, 1]) {
      ctx.fillStyle = M_NAVY;
      capsule(ctx, side * 0.10 * sc, 0.30 * sc,
                   side * 0.16 * sc, 0.46 * sc, 0.045 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.fillStyle = M_LIGHT;
      for (const k of [-1, 0, 1]) {
        const cx = side * 0.16 * sc + k * 0.022 * sc;
        ctx.beginPath();
        ctx.moveTo(cx, 0.48 * sc);
        ctx.lineTo(cx + 0.018 * sc, 0.55 * sc);
        ctx.lineTo(cx - 0.004 * sc, 0.49 * sc);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Head + face (with its own lunge offset).
    ctx.save();
    ctx.translate(headDX, headDY);
    drawHead(true);

    // Two ears (small, swept slightly outward).
    for (const side of [-1, 1]) {
      const eAng = side * (0.20 + earTwitch);
      ctx.fillStyle = M_NAVY;
      ctx.beginPath();
      ctx.moveTo(side * headR * 0.45, headCy - headR * 0.45);
      ctx.quadraticCurveTo(side * headR * 0.85,
                           headCy - headR * 0.85 + eAng * 0.05 * sc,
                           side * headR * 0.60, headCy - headR * 0.15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
      ctx.fillStyle = M_SLATE;
      ctx.beginPath();
      ctx.moveTo(side * headR * 0.48, headCy - headR * 0.45);
      ctx.quadraticCurveTo(side * headR * 0.72,
                           headCy - headR * 0.70 + eAng * 0.04 * sc,
                           side * headR * 0.58, headCy - headR * 0.20);
      ctx.closePath();
      ctx.fill();
    }

    // Two horns curving up and outward+back.
    drawHorn(-headR * 0.30, headCy - headR * 0.65, -1, -0.30);
    drawHorn( headR * 0.30, headCy - headR * 0.65,  1, -0.30);

    // Two glowing eyes.
    drawEye(-headR * 0.32, headCy - headR * 0.05, 1);
    drawEye( headR * 0.32, headCy - headR * 0.05, 1);

    // Toothy grin — wide opens during windup/strike. Four upper fangs
    // plus two prominent lower fangs sticking up.
    {
      const mw = headR * (0.46 + mouthOpen * 0.32);
      const mh = headR * (0.08 + mouthOpen * 0.40);
      const mcy = headCy + headR * 0.40;
      ctx.fillStyle = M_INK;
      ctx.beginPath();
      ctx.ellipse(0, mcy, mw * 0.5, mh, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
      // 4 upper fangs (with the middle two slightly longer).
      for (let i = 0; i < 4; i++) {
        const fx = -mw * 0.5 * 0.80 + (i / 3) * mw * 0.80;
        const fh = 0.060 * sc + ((i === 1 || i === 2) ? 0.012 * sc : 0);
        drawFang(fx, mcy - mh * 0.6, 0.026 * sc, fh);
      }
      // 2 lower fangs sticking up out of the bottom of the grin.
      for (const fx of [-mw * 0.5 * 0.40, mw * 0.5 * 0.40]) {
        ctx.fillStyle = M_OFF;
        ctx.beginPath();
        ctx.moveTo(fx - 0.024 * sc, mcy + mh * 0.70);
        ctx.lineTo(fx + 0.024 * sc, mcy + mh * 0.70);
        ctx.lineTo(fx, mcy - mh * 0.10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.35; ctx.stroke();
      }
      drawSpitPuff(0, mcy);
    }
    ctx.restore();

    // FRONT-wing roots (the upper portion of each wing where it leaves
    // the shoulder, drawn in front of the body's shoulders).
    {
      const openness = 0.75 + flap * 0.25;
      drawWingMirror(0.18 * sc, -0.10 * sc, -0.70 + flap * 0.15,
                     0.55 * sc, openness * 0.8, false);
      drawWing      (0.18 * sc, -0.10 * sc, -0.70 + flap * 0.15,
                     0.55 * sc, openness * 0.8, false);
    }

  } else {
    // ───── BACK VIEW ───────────────────────────────────────────────────
    // Body away from camera, both wings spread, spine ridges, tail down
    // the center, ears/horns visible from behind, no face features.

    // Tail straight down center.
    drawTail(0, 0.30 * sc, 0.62 * sc, 0, tailWag);

    // Both wings drawn behind the body.
    {
      const openness = 0.75 + flap * 0.25;
      drawWingMirror(0.22 * sc, -0.18 * sc, -1.30 + flap * 0.30,
                     1.00 * sc, openness, false);
      drawWing      (0.22 * sc, -0.18 * sc, -1.30 + flap * 0.30,
                     1.00 * sc, openness, false);
    }

    // Body (back view — light still from upper-left so shadow on +x side).
    drawBody(1);

    // Back ridges — a row of small dark-navy bumps down the spine.
    ctx.fillStyle = `rgba(13,27,42,0.85)`;
    for (let i = 0; i < 4; i++) {
      const ry = lerp(-bodyR * 0.70, bodyR * 0.70, i / 3);
      const rs = 0.06 * sc * (1 - Math.abs(i - 1.5) * 0.15);
      ctx.beginPath();
      ctx.arc(0, ry, rs, 0, TAU);
      ctx.fill();
    }

    // Two clawed legs from behind.
    for (const side of [-1, 1]) {
      ctx.fillStyle = M_NAVY;
      capsule(ctx, side * 0.12 * sc, 0.30 * sc,
                   side * 0.14 * sc, 0.46 * sc, 0.045 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    }

    // Head from behind — dome with back shadow stripe + cheek highlight.
    ctx.save();
    ctx.translate(headDX, headDY);
    ctx.fillStyle = M_SLATE;
    ctx.beginPath();
    ctx.ellipse(0, headCy, headR * 1.05, headR, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.fillStyle = `rgba(27,38,59,0.65)`;
    ctx.beginPath();
    ctx.ellipse(0, headCy + headR * 0.10,
                headR * 0.30, headR * 0.85, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(119,141,169,0.85)`;
    ctx.beginPath();
    ctx.ellipse(-headR * 0.30, headCy - headR * 0.30,
                headR * 0.55, headR * 0.30, -0.4, 0, TAU);
    ctx.fill();

    // Two horns visible from behind.
    drawHorn(-headR * 0.32, headCy - headR * 0.60, -1, -0.20);
    drawHorn( headR * 0.32, headCy - headR * 0.60,  1, -0.20);

    // Ears peeking around the head from behind.
    for (const side of [-1, 1]) {
      ctx.fillStyle = M_NAVY;
      ctx.beginPath();
      ctx.moveTo(side * headR * 0.55, headCy - headR * 0.35);
      ctx.quadraticCurveTo(side * headR * 0.95,
                           headCy - headR * 0.75 + earTwitch * 0.04 * sc,
                           side * headR * 0.65, headCy - headR * 0.10);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.50; ctx.stroke();
    }
    ctx.restore();
  }

  // ── hit flash (white wash over the whole figure, scaled to the body's
  //    bounding box in local space) ────────────────────────────────────
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.50 * p.flash})`;
    const flashTop = headCy - 0.50 * sc;
    const flashH   = (bodyCy + bodyR + 0.55 * sc) - flashTop;
    rr(ctx, -0.85 * sc, flashTop, 1.70 * sc, flashH, 0.24 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
  return true;
}

export function markMinion(id) {
  const a = anim.get(id);
  if (a) a.wasMinion = true;
}

// Short-range "spit" projectile fired by the Minion. A dark navy-to-near-
// black glob with a faint off-white wet-shine highlight catch on top,
// a slate-blue inner volume tone, and 2-3 fading dark droplets trailing
// behind along the travel direction. Used by the bolt branch in
// renderer.js when p.src.card === 'Minions'. Same call shape as drawArrow:
//   opts.alpha (num) — overall alpha multiplier (default 1).
export function drawMinionSpit(ctx, x, y, ang, tile, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;
  const R = tile * 0.16;                // lead glob radius

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // Trailing droplets — fade in size + alpha behind the lead glob along
  // local -x (the travel direction is local +x, so -x is "behind").
  const trail = [
    [-tile * 0.42, -tile * 0.020, R * 0.40, 0.55],
    [-tile * 0.30,  tile * 0.030, R * 0.55, 0.70],
    [-tile * 0.18, -tile * 0.010, R * 0.70, 0.85],
  ];
  for (const [dx, dy, dr, a] of trail) {
    ctx.fillStyle = `rgba(13,27,42,${a * alpha})`;
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(13,27,42,${alpha})`;
    ctx.lineWidth = Math.max(1, tile * 0.014);
    ctx.stroke();
  }

  // Lead glob — near-black navy body with a dark-ink outline.
  ctx.fillStyle = `rgba(13,27,42,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 1.10, R * 0.95, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = `rgba(13,27,42,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.022);
  ctx.stroke();
  // Dark-navy inner volume (gives the glob a 3D feel).
  ctx.fillStyle = `rgba(27,38,59,${0.85 * alpha})`;
  ctx.beginPath();
  ctx.ellipse(-R * 0.10, R * 0.05, R * 0.75, R * 0.65, 0, 0, TAU);
  ctx.fill();

  // Light-slate highlight on the upper-left (slightly behind the lead).
  ctx.fillStyle = `rgba(119,141,169,${0.55 * alpha})`;
  ctx.beginPath();
  ctx.ellipse(-R * 0.30, -R * 0.30, R * 0.32, R * 0.22, -0.4, 0, TAU);
  ctx.fill();

  // Off-white wet-shine specular dot (the "saliva" pop).
  ctx.fillStyle = `rgba(224,225,221,${0.95 * alpha})`;
  ctx.beginPath();
  ctx.arc(-R * 0.25, -R * 0.35, R * 0.16, 0, TAU);
  ctx.fill();

  // Tiny faint sparkle just ahead of the lead (a wet smear leading the
  // projectile's nose, sells motion).
  ctx.fillStyle = `rgba(224,225,221,${0.55 * alpha})`;
  ctx.beginPath();
  ctx.arc(R * 0.75, -R * 0.10, R * 0.10, 0, TAU);
  ctx.fill();

  ctx.restore();
}

// Polished 2.5D Musketeer — a confident female heroine in a long teal coat,
// tricorn hat with gold-and-orange plume, bright orange ponytail, and a long
// musket rifle with a dark navy barrel + light-blue wood stock. Same size
// family as the Archer (S = tile * 0.62) — slender humanoid silhouette. The
// attack is a three-phase fire: musket RAISED from hip to shoulder (windup),
// massive additive muzzle FLASH + smoke puff + body recoil (strike), musket
// LOWERED back to hip (recovery). Idle: breath, coat-tail flutter, ponytail
// sway, plume flutter. Spawn rune ring is teal-tinted; small coat-scrap +
// gunpowder + brass-button + broken-musket death poof completes the rig.
export function drawMusketeer(ctx, gx, gy, tile, p) {
  // ── Function-local palette (declared inside drawMusketeer to avoid name
  //    collisions with other units' identifiers at module scope) ──────────
  //   #8ecae6 light sky blue — coat highlight, hat brim hi, gun stock hi
  //   #219ebc teal blue      — coat MAIN, tricorn top, stockings
  //   #023047 very dark navy — coat shadow, boots, barrel, outline accents
  //   #ffb703 warm gold      — plume base, belt buckle, gun trim, buttons
  //   #fb8500 deep orange    — HAIR ponytail, muzzle flash core, plume tip
  const MK_SKY     = '#8ecae6';
  const MK_TEAL    = '#219ebc';
  const MK_NAVY    = '#023047';
  const MK_GOLD    = '#ffb703';
  const MK_ORANGE  = '#fb8500';
  // Derived tones (light/dark family members for cel-shading).
  const MK_SKY_HI  = '#c8e6f1';
  const MK_TEAL_D  = '#176c80';
  const MK_NAVY_D  = '#011a26';
  const MK_GOLD_HI = '#ffd462';
  const MK_ORANGE_D= '#c46300';
  const MK_SKIN    = '#ffddc0';
  const MK_SKIN_SH = '#e8a89b';

  // Spec: S = tile * 0.62 (same family as Archer; slightly taller, slender).
  const S = tile * 0.62;
  const grow = lerp(0.6, 1, easeOut(p.spawnF));
  const sc = S * grow;

  // ── kinematics ─────────────────────────────────────────────────────────
  const sw = Math.sin(p.gait * TAU);
  const bob = Math.abs(Math.sin(p.gait * TAU)) * p.moving;
  // Lithe heroine: lighter breath than the Knight, on the same family as
  // the Archer's lighter breath.
  const breath = Math.sin((p.t + p.phase) * 2.1) * (1 - p.moving) * 0.018;
  const lift = (bob * 0.32 + breath) * sc;
  const headBob = Math.sin(p.gait * TAU * 2) * p.moving * 0.014 * sc;
  // Coat tail flutter (drives the trailing hem in side/back views).
  const tC = (p.t + p.phase) * 4.6;
  const flutter = (Math.sin(tC) * (0.07 + p.moving * 0.20) +
                   Math.sin(tC * 1.7) * 0.045) * sc;
  // Plume flutter — slightly faster, de-synced from the cloak (spec).
  const tP = (p.t + p.phase * 1.7) * 5.4;
  const plume = (Math.sin(tP) * (0.18 + p.moving * 0.10) +
                 Math.sin(tP * 1.6) * 0.10);
  // Ponytail sway — long orange tail behind head, separate idle rhythm.
  const tail = Math.sin(p.t * 3.0 + p.phase) * 0.10
             + Math.sin(p.t * 4.7 + p.phase * 0.7) * 0.05;

  // ── attack timeline (three phases) ────────────────────────────────────
  // s grows 0→1 across one hitSpeed swing.
  //   0.00..0.42  WINDUP   : musket lifts from hip to shoulder, head tilts
  //                          to sight down the barrel
  //   0.42..0.55  STRIKE   : FIRE — muzzle flash + smoke puff, body recoil,
  //                          ponytail/coat fan briefly backward
  //   0.55..1.00  RECOVERY : musket lowers back toward hip, smoke fades,
  //                          recoil eases out
  const s = 1 - p.atk;
  let windPhase = 0, strikePhase = 0, recoverPhase = 0;
  if (p.atk > 0) {
    if (s < 0.42)      windPhase = easeOut(s / 0.42);
    else if (s < 0.55){ windPhase = 1; strikePhase = easeOut((s - 0.42) / 0.13); }
    else              { strikePhase = 1; recoverPhase = easeInOut((s - 0.55) / 0.45); }
  }
  // Brief intense pop at the very moment of firing (centered just inside
  // the STRIKE window).
  const firePop = clamp01(1 - Math.abs(s - 0.46) * 14);
  // "Aimed at shoulder" amount — 1 from full draw through strike, eases to 0
  // during recovery.
  const shoulder = windPhase * (1 - recoverPhase);
  // Body lunge — braces slightly back on windup, kicks BACK on the strike
  // (recoil), then settles. p.face flips so "back" always means -p.face.
  const lunge  = (windPhase * 0.02 + strikePhase * -0.12 + recoverPhase * -0.02)
               * sc * p.face;
  const recoil = p.flash * 0.10 * sc * -p.face;
  // Pre-strike: ponytail + coat momentarily fan BACKWARD on recoil — a sharp
  // impulse that decays through recovery.
  const recoilFan = strikePhase * (1 - recoverPhase) * 1.0;

  ctx.save();
  ctx.globalAlpha = lerp(0.25, 1, easeOut(p.spawnF));

  // ── ground cast shadow ────────────────────────────────────────────────
  const shR = sc * (0.84 - bob * 0.18);
  ctx.fillStyle = `rgba(0,0,0,${0.48 * (1 - bob * 0.30)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.16, gy + sc * 0.04, shR, shR * 0.40, 0, 0, TAU);
  ctx.fill();

  // ── spawn rune ring (teal-tinted with light-blue sparkles) ────────────
  if (p.spawnF < 1) {
    const sf = p.spawnF, inv = 1 - sf;
    ctx.strokeStyle = `rgba(33,158,188,${0.92 * inv})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.86 + sf * 0.86), sc * 0.34 * (0.86 + sf * 0.86), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(142,202,230,${0.75 * inv})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(gx, gy, sc * (0.66 + sf * 0.66), sc * 0.26 * (0.66 + sf * 0.66), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,183,3,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + sf * 0.6;
      const rx = sc * (0.82 + sf * 0.82), ry = sc * 0.30 * (0.82 + sf * 0.82);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.08 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // Enter local space (feet anchor; +x = facing dir; -y = up the screen).
  ctx.translate(gx + lunge + recoil, gy);
  ctx.scale(p.face, 1);
  // Mild postural tilt: movement lean + small forward squaring on aim,
  // brief back-tilt on the recoil moment.
  ctx.rotate(-p.lean * p.face * 0.50 + shoulder * -0.04 + strikePhase * 0.05 * (1 - recoverPhase));
  ctx.translate(0, -lift);

  // Slim heroine proportions (close to the Archer, slightly taller).
  const baseY = 0;
  const hipY  = -1.02 * sc;
  const shoY  = -1.82 * sc;
  const headY = -2.24 * sc + headBob;
  // Chibi cuteness boost: scales the head/hat/face up around the chin pivot.
  // Bumped from 1.30 → 1.85 so her face reads MUCH bigger relative to the
  // body (strong chibi heroine proportions, head ~1.4x body width).
  const HEAD_S = 1.85;
  const HEAD_PIVOT_Y = () => headY + 0.18 * sc;

  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  const OL = MK_NAVY_D;
  const OW = 0.065 * sc;

  // ── reusable: the musket ──────────────────────────────────────────────
  // Drawn at the BACK-HAND grip; canonical orientation is barrel pointing
  // along local -y (UP). Caller rotates by `armAng + π/2` so armAng matches
  // the firing direction in local space (+x = forward). Length stays in
  // sc-units so the gun scales with the figure.
  // Bigger, cooler version: longer barrel, thicker gold engraved bands,
  // sky-blue stock with gold filigree heart, a bayonet at the muzzle, and
  // a brass starburst on the lock plate.
  const L = 2.10 * sc;                    // total length (was 1.65)
  const drawMusket = () => {
    const barrelW = 0.095 * sc;
    const stockW  = 0.165 * sc;

    // ── shoulder stock (curvy "swan-neck" butt for a cute silhouette) ─
    ctx.fillStyle = MK_SKY;
    ctx.beginPath();
    ctx.moveTo(-stockW * 0.55, 0.05 * sc);
    ctx.lineTo( stockW * 0.65, 0.05 * sc);
    ctx.quadraticCurveTo(stockW * 0.55, L * 0.18, stockW * 0.45, L * 0.32);
    ctx.quadraticCurveTo(stockW * 0.20, L * 0.46, -stockW * 0.10, L * 0.48);
    ctx.quadraticCurveTo(-stockW * 0.55, L * 0.40, -stockW * 0.62, L * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
    // Darker teal grain band along the underside of the stock.
    ctx.fillStyle = `rgba(33,158,188,0.55)`;
    ctx.beginPath();
    ctx.moveTo( stockW * 0.30, 0.07 * sc);
    ctx.lineTo( stockW * 0.60, 0.10 * sc);
    ctx.quadraticCurveTo(stockW * 0.42, L * 0.30, stockW * 0.18, L * 0.40);
    ctx.lineTo( stockW * 0.10, L * 0.32);
    ctx.closePath();
    ctx.fill();
    // Light sky-blue highlight catch along the upper edge of the stock.
    ctx.fillStyle = MK_SKY_HI;
    ctx.beginPath();
    ctx.moveTo(-stockW * 0.48, 0.06 * sc);
    ctx.lineTo(-stockW * 0.20, 0.08 * sc);
    ctx.quadraticCurveTo(-stockW * 0.30, L * 0.30, -stockW * 0.50, L * 0.34);
    ctx.closePath();
    ctx.fill();
    // Gold filigree heart engraved on the stock — a girly signature.
    {
      ctx.save();
      ctx.translate(-stockW * 0.10, L * 0.22);
      const hr = 0.060 * sc;
      ctx.fillStyle = MK_GOLD;
      ctx.beginPath();
      ctx.arc(-hr * 0.45, -hr * 0.15, hr * 0.55, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc( hr * 0.45, -hr * 0.15, hr * 0.55, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-hr * 0.95, 0);
      ctx.lineTo(0, hr * 1.10);
      ctx.lineTo( hr * 0.95, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.016 * sc;
      ctx.beginPath();
      ctx.arc(-hr * 0.45, -hr * 0.15, hr * 0.55, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc( hr * 0.45, -hr * 0.15, hr * 0.55, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-hr * 0.95, 0);
      ctx.lineTo(0, hr * 1.10);
      ctx.lineTo( hr * 0.95, 0);
      ctx.stroke();
      ctx.fillStyle = MK_GOLD_HI;
      ctx.beginPath();
      ctx.arc(-hr * 0.50, -hr * 0.25, hr * 0.18, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    // Decorative gold rivets along the stock side.
    for (let i = 0; i < 3; i++) {
      const ry = L * (0.10 + i * 0.10);
      ctx.fillStyle = MK_GOLD;
      ctx.beginPath();
      ctx.arc(-stockW * 0.40, ry, 0.020 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.010 * sc; ctx.stroke();
      ctx.fillStyle = MK_GOLD_HI;
      ctx.beginPath();
      ctx.arc(-stockW * 0.41, ry - 0.005 * sc, 0.008 * sc, 0, TAU);
      ctx.fill();
    }

    // ── larger trigger guard (gold ornamental curve) ──
    ctx.strokeStyle = MK_GOLD;
    ctx.lineWidth = 0.034 * sc;
    ctx.beginPath();
    ctx.arc(-0.005 * sc, 0.10 * sc, 0.080 * sc, 0, Math.PI);
    ctx.stroke();
    ctx.strokeStyle = MK_NAVY_D;
    ctx.lineWidth = 0.014 * sc;
    ctx.beginPath();
    ctx.arc(-0.005 * sc, 0.10 * sc, 0.080 * sc, 0, Math.PI);
    ctx.stroke();
    // Trigger (small dark sliver hanging down).
    ctx.fillStyle = MK_NAVY_D;
    ctx.fillRect(-0.014 * sc, 0.10 * sc, 0.028 * sc, 0.050 * sc);

    // ── lock plate (gold rectangle with a brass starburst) ──
    ctx.fillStyle = MK_NAVY;
    rr(ctx, -0.060 * sc, -0.06 * sc, 0.120 * sc, 0.13 * sc, 0.02 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    // Gold starburst medallion on the lock plate.
    {
      ctx.fillStyle = MK_GOLD;
      const cx = 0, cy = 0.005 * sc, r = 0.035 * sc;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const rr2 = (i % 2 === 0) ? r : r * 0.45;
        const px = cx + Math.cos(a) * rr2;
        const py = cy + Math.sin(a) * rr2;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.012 * sc; ctx.stroke();
      ctx.fillStyle = MK_GOLD_HI;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.20, 0, TAU);
      ctx.fill();
    }
    // Brass cock (hammer) on the side.
    ctx.fillStyle = MK_GOLD;
    rr(ctx, 0.038 * sc, -0.07 * sc, 0.024 * sc, 0.075 * sc, 0.008 * sc);
    ctx.fill();
    ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.010 * sc; ctx.stroke();

    // ── long dark-navy barrel ──
    ctx.fillStyle = MK_NAVY;
    rr(ctx, -barrelW * 0.5, -L * 0.50, barrelW, L * 0.55, barrelW * 0.22);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    // Teal/slate highlight stripe along one side of the barrel.
    ctx.fillStyle = `rgba(33,158,188,0.55)`;
    rr(ctx, -barrelW * 0.45, -L * 0.49, barrelW * 0.30, L * 0.52, barrelW * 0.10);
    ctx.fill();
    // Sky-blue catch line along the very top.
    ctx.fillStyle = `rgba(142,202,230,0.60)`;
    rr(ctx, -barrelW * 0.18, -L * 0.49, barrelW * 0.10, L * 0.50, barrelW * 0.04);
    ctx.fill();

    // ── three gold trim bands along the barrel (lock / mid / muzzle) ──
    const drawBand = (yPos, w) => {
      ctx.fillStyle = MK_GOLD;
      rr(ctx, -barrelW * 0.78, yPos, barrelW * 1.56, w, 0.025 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.020 * sc; ctx.stroke();
      ctx.fillStyle = MK_GOLD_HI;
      ctx.fillRect(-barrelW * 0.40, yPos + w * 0.10, barrelW * 0.80, w * 0.20);
      // tiny ornamental notches
      ctx.fillStyle = MK_NAVY_D;
      for (let i = -2; i <= 2; i++) {
        ctx.fillRect(i * barrelW * 0.30, yPos + w * 0.65, 0.008 * sc, w * 0.30);
      }
    };
    drawBand(0.005 * sc, 0.070 * sc);       // breech band (at the lock)
    drawBand(-L * 0.22, 0.055 * sc);        // mid barrel band
    drawBand(-L * 0.50 + 0.005 * sc, 0.080 * sc); // muzzle band (bigger)

    // Ramrod tube — slim parallel strip under (behind) the barrel.
    ctx.fillStyle = MK_SKY;
    rr(ctx, barrelW * 0.22, -L * 0.42, 0.030 * sc, L * 0.38, 0.012 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = 0.014 * sc; ctx.stroke();

    // Dark muzzle bore (small dark circle at the tip).
    ctx.fillStyle = MK_NAVY_D;
    ctx.beginPath();
    ctx.arc(0, -L * 0.50 + 0.025 * sc, barrelW * 0.34, 0, TAU);
    ctx.fill();

    // ── BAYONET attached to the muzzle (steel blade with gold socket) ──
    {
      const bayL = 0.55 * sc;
      const bayW = 0.040 * sc;
      const bayBase = -L * 0.50 - 0.030 * sc;
      // Gold socket where the bayonet meets the muzzle.
      ctx.fillStyle = MK_GOLD;
      rr(ctx, -barrelW * 0.55, bayBase - 0.05 * sc, barrelW * 1.10, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.014 * sc; ctx.stroke();
      // Steel blade — slender triangular shape tapering to a point.
      ctx.fillStyle = MK_SKY_HI;
      ctx.beginPath();
      ctx.moveTo(-bayW, bayBase - 0.05 * sc);
      ctx.lineTo( bayW, bayBase - 0.05 * sc);
      ctx.lineTo( bayW * 0.3, bayBase - bayL);
      ctx.lineTo(-bayW * 0.3, bayBase - bayL);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.016 * sc; ctx.stroke();
      // Bright catch line down the center of the blade.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(-bayW * 0.14, bayBase - 0.06 * sc);
      ctx.lineTo( bayW * 0.06, bayBase - 0.06 * sc);
      ctx.lineTo( bayW * 0.06, bayBase - bayL * 0.95);
      ctx.lineTo(-bayW * 0.14, bayBase - bayL * 0.95);
      ctx.closePath();
      ctx.fill();
      // Gold ribbon tied at the bayonet base (girly accent).
      ctx.fillStyle = MK_ORANGE;
      ctx.beginPath();
      ctx.moveTo(0, bayBase - 0.02 * sc);
      ctx.lineTo(-0.10 * sc, bayBase - 0.10 * sc);
      ctx.lineTo(-0.10 * sc, bayBase + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.012 * sc; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, bayBase - 0.02 * sc);
      ctx.lineTo(0.10 * sc, bayBase - 0.10 * sc);
      ctx.lineTo(0.10 * sc, bayBase + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = MK_GOLD;
      ctx.beginPath();
      ctx.arc(0, bayBase - 0.02 * sc, 0.025 * sc, 0, TAU);
      ctx.fill();
    }
  };

  // Muzzle position in the musket's canonical frame (used by the flash
  // and the smoke puff). Caller draws within the SAME translated/rotated
  // frame as drawMusket.
  const MUZZLE_Y = -L * 0.50 + 0.020 * sc;

  // ── reusable: muzzle flash (additive lighter blend) ───────────────────
  // Drawn at the muzzle in the musket's canonical frame. `a` is 0..1.
  const drawMuzzleFlash = (a) => {
    if (a < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Outer warm gold halo.
    ctx.fillStyle = `rgba(255,183,3,${0.45 * a})`;
    ctx.beginPath();
    ctx.arc(0, MUZZLE_Y, 0.50 * sc * a, 0, TAU);
    ctx.fill();
    // Sharp radiating rays (gold) — 6 long + 6 short, alternating.
    ctx.fillStyle = `rgba(255,183,3,${0.85 * a})`;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * TAU;
      const r = 0.62 * sc * a * (i % 2 ? 0.50 : 1.0);
      const w = 0.06 * sc * a * (i % 2 ? 0.55 : 1.0);
      const c = Math.cos(ang), s = Math.sin(ang);
      ctx.beginPath();
      ctx.moveTo(-s * w * 0.5, MUZZLE_Y + c * w * 0.5);
      ctx.lineTo(c * r,        MUZZLE_Y + s * r);
      ctx.lineTo( s * w * 0.5, MUZZLE_Y - c * w * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    // Inner orange core.
    ctx.fillStyle = `rgba(251,133,0,${0.95 * a})`;
    ctx.beginPath();
    ctx.arc(0, MUZZLE_Y, 0.24 * sc * a, 0, TAU);
    ctx.fill();
    // White-hot center.
    ctx.fillStyle = `rgba(255,250,220,${a})`;
    ctx.beginPath();
    ctx.arc(0, MUZZLE_Y, 0.13 * sc * a, 0, TAU);
    ctx.fill();
    // Pure white pinpoint.
    ctx.fillStyle = `rgba(255,255,255,${0.95 * a})`;
    ctx.beginPath();
    ctx.arc(0, MUZZLE_Y, 0.055 * sc * a, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Smoke puff BEHIND the flash (non-additive, sits in the regular
    // alpha plane so it occludes the flash slightly along the back side).
    const smk = a * (0.85 - recoverPhase * 0.20);
    ctx.fillStyle = `rgba(225,225,225,${0.60 * smk})`;
    ctx.beginPath();
    ctx.ellipse(0, MUZZLE_Y + 0.20 * sc * a,
                0.40 * sc * a, 0.26 * sc * a, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(180,180,180,${0.45 * smk})`;
    ctx.beginPath();
    ctx.arc(0.10 * sc * a, MUZZLE_Y + 0.30 * sc * a,
            0.20 * sc * a, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-0.12 * sc * a, MUZZLE_Y + 0.32 * sc * a,
            0.16 * sc * a, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.75 * smk})`;
    ctx.beginPath();
    ctx.arc(-0.03 * sc * a, MUZZLE_Y + 0.15 * sc * a,
            0.08 * sc * a, 0, TAU);
    ctx.fill();
  };

  // Eye-glow intensity (sights/aim/strike/hit pulse it brighter).
  const eyeGlow = 0.70 + shoulder * 0.20 + firePop * 0.40 + p.flash * 0.30;

  // ── reusable: rounded crown hat ────────────────────────────────────────
  // Drawn in side profile around (hx, headY). Smooth dome silhouette
  // instead of the old triangular tricorn peaks: think a soft-crowned
  // cavalier cap with an upturned brim and a gold trim band.
  const drawTricornSide = (hx) => {
    // Outer hat silhouette (teal) — dome crown + flared brim.
    ctx.fillStyle = MK_TEAL;
    ctx.beginPath();
    ctx.moveTo(hx - 0.42 * sc, headY - 0.04 * sc);
    // Sweep up and over the dome (slight forward asymmetry).
    ctx.quadraticCurveTo(hx - 0.40 * sc, headY - 0.34 * sc,
                         hx + 0.06 * sc, headY - 0.38 * sc);
    ctx.quadraticCurveTo(hx + 0.40 * sc, headY - 0.30 * sc,
                         hx + 0.42 * sc, headY - 0.04 * sc);
    // Flared brim under the dome.
    ctx.lineTo(hx + 0.36 * sc, headY + 0.06 * sc);
    ctx.lineTo(hx - 0.36 * sc, headY + 0.04 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Light-blue crown highlight (curved catch along the top of the dome).
    ctx.fillStyle = MK_SKY;
    ctx.beginPath();
    ctx.moveTo(hx - 0.26 * sc, headY - 0.24 * sc);
    ctx.quadraticCurveTo(hx + 0.04 * sc, headY - 0.34 * sc,
                         hx + 0.22 * sc, headY - 0.24 * sc);
    ctx.quadraticCurveTo(hx + 0.06 * sc, headY - 0.18 * sc,
                         hx - 0.10 * sc, headY - 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    // Dark-navy shadow under the brim.
    ctx.fillStyle = `rgba(2,48,71,0.55)`;
    rr(ctx, hx - 0.36 * sc, headY - 0.02 * sc, 0.74 * sc, 0.07 * sc, 0.025 * sc);
    ctx.fill();
    // Gold trim band along the rounded crown edge.
    ctx.strokeStyle = MK_GOLD;
    ctx.lineWidth = 0.026 * sc;
    ctx.beginPath();
    ctx.moveTo(hx - 0.40 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx - 0.38 * sc, headY - 0.32 * sc,
                         hx + 0.06 * sc, headY - 0.36 * sc);
    ctx.quadraticCurveTo(hx + 0.38 * sc, headY - 0.28 * sc,
                         hx + 0.40 * sc, headY - 0.03 * sc);
    ctx.stroke();
  };

  // Front view — symmetric rounded dome with a soft arched brim.
  const drawTricornFront = (hx) => {
    ctx.fillStyle = MK_TEAL;
    ctx.beginPath();
    ctx.moveTo(hx - 0.46 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx - 0.44 * sc, headY - 0.36 * sc,
                         hx, headY - 0.38 * sc);
    ctx.quadraticCurveTo(hx + 0.44 * sc, headY - 0.36 * sc,
                         hx + 0.46 * sc, headY - 0.04 * sc);
    ctx.lineTo(hx + 0.40 * sc, headY + 0.06 * sc);
    ctx.lineTo(hx - 0.40 * sc, headY + 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Light-blue crown highlight (curved).
    ctx.fillStyle = MK_SKY;
    ctx.beginPath();
    ctx.moveTo(hx - 0.30 * sc, headY - 0.24 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.32 * sc,
                         hx + 0.30 * sc, headY - 0.24 * sc);
    ctx.quadraticCurveTo(hx + 0.16 * sc, headY - 0.18 * sc,
                         hx - 0.16 * sc, headY - 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    // Brim under-shadow (across the face top).
    ctx.fillStyle = `rgba(2,48,71,0.60)`;
    rr(ctx, hx - 0.40 * sc, headY - 0.02 * sc, 0.80 * sc, 0.08 * sc, 0.03 * sc);
    ctx.fill();
    // Gold trim band along the rounded crown edge.
    ctx.strokeStyle = MK_GOLD;
    ctx.lineWidth = 0.026 * sc;
    ctx.beginPath();
    ctx.moveTo(hx - 0.44 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx - 0.42 * sc, headY - 0.34 * sc,
                         hx, headY - 0.36 * sc);
    ctx.quadraticCurveTo(hx + 0.42 * sc, headY - 0.34 * sc,
                         hx + 0.44 * sc, headY - 0.04 * sc);
    ctx.stroke();
  };

  // Back view — symmetric rounded dome (matches front from behind).
  const drawTricornBack = (hx) => {
    ctx.fillStyle = MK_TEAL;
    ctx.beginPath();
    ctx.moveTo(hx - 0.44 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx - 0.42 * sc, headY - 0.36 * sc,
                         hx, headY - 0.38 * sc);
    ctx.quadraticCurveTo(hx + 0.42 * sc, headY - 0.36 * sc,
                         hx + 0.44 * sc, headY - 0.04 * sc);
    ctx.lineTo(hx + 0.38 * sc, headY + 0.06 * sc);
    ctx.lineTo(hx - 0.38 * sc, headY + 0.06 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Light-blue crown highlight (curved).
    ctx.fillStyle = MK_SKY;
    ctx.beginPath();
    ctx.moveTo(hx - 0.22 * sc, headY - 0.26 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.34 * sc,
                         hx + 0.22 * sc, headY - 0.26 * sc);
    ctx.quadraticCurveTo(hx + 0.10 * sc, headY - 0.16 * sc,
                         hx - 0.10 * sc, headY - 0.16 * sc);
    ctx.closePath();
    ctx.fill();
    // Gold trim seam along the rounded crown.
    ctx.strokeStyle = MK_GOLD;
    ctx.lineWidth = 0.024 * sc;
    ctx.beginPath();
    ctx.moveTo(hx - 0.42 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx - 0.40 * sc, headY - 0.34 * sc,
                         hx, headY - 0.36 * sc);
    ctx.quadraticCurveTo(hx + 0.40 * sc, headY - 0.34 * sc,
                         hx + 0.42 * sc, headY - 0.04 * sc);
    ctx.stroke();
  };

  // ── reusable: plume feather ───────────────────────────────────────────
  // Drawn rooted at (cx, cy), curving upward, with a flutter `pSwing` and
  // a length `len` (sc-scaled). Gold base, orange tip, light highlight.
  const drawPlume = (cx, cy, len, pSwing) => {
    const pLen = len;
    const swing = pSwing;
    const tipX  = cx + swing * 0.24 * sc;
    const tipY  = cy - pLen;
    const midX  = cx + swing * 0.14 * sc;
    const midY  = cy - pLen * 0.55;
    // Feather body (gold-to-orange gradient via two passes).
    ctx.fillStyle = MK_GOLD;
    ctx.beginPath();
    ctx.moveTo(cx - 0.05 * sc, cy + 0.02 * sc);
    ctx.quadraticCurveTo(midX - 0.10 * sc, midY,
                         tipX - 0.05 * sc, tipY);
    ctx.lineTo(tipX + 0.05 * sc, tipY);
    ctx.quadraticCurveTo(midX + 0.10 * sc, midY,
                         cx + 0.05 * sc, cy + 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Orange tip (upper third).
    ctx.fillStyle = MK_ORANGE;
    ctx.beginPath();
    ctx.moveTo(midX - 0.07 * sc, midY);
    ctx.quadraticCurveTo(midX - 0.02 * sc, midY - pLen * 0.30,
                         tipX - 0.04 * sc, tipY);
    ctx.lineTo(tipX + 0.04 * sc, tipY);
    ctx.quadraticCurveTo(midX + 0.02 * sc, midY - pLen * 0.30,
                         midX + 0.07 * sc, midY);
    ctx.closePath();
    ctx.fill();
    // Light-gold highlight stripe along the front of the feather.
    ctx.strokeStyle = MK_GOLD_HI;
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(cx - 0.01 * sc, cy);
    ctx.quadraticCurveTo(midX - 0.02 * sc, midY,
                         tipX - 0.02 * sc, tipY + 0.04 * sc);
    ctx.stroke();
    // Subtle dark barbules (thin perpendicular ticks).
    ctx.strokeStyle = `rgba(2,48,71,0.35)`;
    ctx.lineWidth = 0.012 * sc;
    for (let i = 1; i < 5; i++) {
      const t = i / 5;
      const fx = lerp(cx, tipX, t);
      const fy = lerp(cy, tipY, t);
      const nx = (tipX - cx) / pLen, ny = (tipY - cy) / pLen; // unit tangent
      // perpendicular
      const px = -ny, py = nx;
      ctx.beginPath();
      ctx.moveTo(fx - px * 0.06 * sc, fy - py * 0.06 * sc);
      ctx.lineTo(fx + px * 0.06 * sc, fy + py * 0.06 * sc);
      ctx.stroke();
    }
  };

  // ── reusable: orange ponytail ─────────────────────────────────────────
  // `cx, cy` = root behind the head; `sign` = +1 (drape to +x) / -1 (-x);
  // `extra` = additional sway (recoil fan adds an impulse).
  const drawPonytail = (cx, cy, sign, extra) => {
    const sway = (tail + extra) * sc;
    const ex = cx + sign * (0.22 * sc + sway * 1.2);
    const ey = cy + 0.62 * sc;
    const mx = cx + sign * (0.10 * sc + sway * 0.7);
    const my = cy + 0.28 * sc;
    // Outer dark stroke (silhouette).
    ctx.fillStyle = MK_ORANGE;
    ctx.beginPath();
    ctx.moveTo(cx - 0.06 * sc, cy);
    ctx.quadraticCurveTo(mx - sign * 0.06 * sc, my,
                         ex - sign * 0.04 * sc, ey - 0.02 * sc);
    ctx.quadraticCurveTo(ex + sign * 0.02 * sc, ey + 0.04 * sc,
                         ex + sign * 0.08 * sc, ey - 0.08 * sc);
    ctx.quadraticCurveTo(mx + sign * 0.08 * sc, my - 0.04 * sc,
                         cx + 0.06 * sc, cy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.70; ctx.stroke();
    // Darker streak shadow.
    ctx.fillStyle = MK_ORANGE_D;
    ctx.beginPath();
    ctx.moveTo(cx + sign * 0.02 * sc, cy + 0.04 * sc);
    ctx.quadraticCurveTo(mx + sign * 0.02 * sc, my,
                         ex - sign * 0.02 * sc, ey - 0.04 * sc);
    ctx.quadraticCurveTo(mx - sign * 0.02 * sc, my - 0.04 * sc,
                         cx - sign * 0.02 * sc, cy);
    ctx.closePath();
    ctx.fill();
    // Tying band (navy ribbon at the root).
    ctx.fillStyle = MK_NAVY;
    rr(ctx, cx - 0.06 * sc, cy - 0.03 * sc, 0.12 * sc, 0.08 * sc, 0.020 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.45; ctx.stroke();
  };

  // ── reusable: gold buttons + coat lapels (single column down chest) ───
  const drawCoatButtons = (cx, topY, botY) => {
    for (let i = 0; i < 5; i++) {
      const y = lerp(topY, botY, (i + 0.5) / 5);
      ctx.fillStyle = MK_GOLD;
      ctx.beginPath();
      ctx.arc(cx, y, 0.035 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D;
      ctx.lineWidth = 0.012 * sc;
      ctx.stroke();
      ctx.fillStyle = MK_GOLD_HI;
      ctx.beginPath();
      ctx.arc(cx - 0.010 * sc, y - 0.010 * sc, 0.012 * sc, 0, TAU);
      ctx.fill();
    }
  };

  // ── reusable: a clearly-human female face (skin patch + features) ──
  // Wider exposed face than the old "just nose/chin under brim" so the eye
  // area is unmistakably human skin, not magical-gold-glow under shadow.
  const drawSkinSide = (hx) => {
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath();
    ctx.moveTo(hx + 0.02 * sc, headY - 0.08 * sc);
    ctx.quadraticCurveTo(hx + 0.34 * sc, headY - 0.02 * sc,
                         hx + 0.34 * sc, headY + 0.10 * sc);
    ctx.quadraticCurveTo(hx + 0.30 * sc, headY + 0.22 * sc,
                         hx + 0.26 * sc, headY + 0.32 * sc);
    ctx.quadraticCurveTo(hx + 0.14 * sc, headY + 0.38 * sc,
                         hx + 0.02 * sc, headY + 0.32 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Cheek blush.
    ctx.fillStyle = `rgba(232,168,155,0.70)`;
    ctx.beginPath();
    ctx.ellipse(hx + 0.22 * sc, headY + 0.18 * sc, 0.07 * sc, 0.040 * sc, 0, 0, TAU);
    ctx.fill();
    // Nose ridge highlight.
    ctx.fillStyle = '#fff1e0';
    ctx.beginPath();
    ctx.moveTo(hx + 0.26 * sc, headY + 0.12 * sc);
    ctx.lineTo(hx + 0.32 * sc, headY + 0.18 * sc);
    ctx.lineTo(hx + 0.24 * sc, headY + 0.18 * sc);
    ctx.closePath();
    ctx.fill();
    // Soft red lip ellipse.
    ctx.fillStyle = '#bc4749';
    ctx.beginPath();
    ctx.ellipse(hx + 0.20 * sc, headY + 0.26 * sc, 0.07 * sc, 0.020 * sc, 0, 0, TAU);
    ctx.fill();
  };

  const drawSkinFront = (hx) => {
    // Wider face oval — upper face visible (eyes + cheeks), not just chin.
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath();
    ctx.moveTo(hx - 0.24 * sc, headY - 0.04 * sc);
    ctx.quadraticCurveTo(hx, headY - 0.10 * sc, hx + 0.24 * sc, headY - 0.04 * sc);
    ctx.lineTo(hx + 0.20 * sc, headY + 0.24 * sc);
    ctx.quadraticCurveTo(hx, headY + 0.36 * sc, hx - 0.20 * sc, headY + 0.24 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    // Cheek blush both sides.
    ctx.fillStyle = `rgba(232,168,155,0.70)`;
    ctx.beginPath();
    ctx.ellipse(hx - 0.14 * sc, headY + 0.17 * sc, 0.055 * sc, 0.035 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(hx + 0.14 * sc, headY + 0.17 * sc, 0.055 * sc, 0.035 * sc, 0, 0, TAU);
    ctx.fill();
    // Nose — subtle shadow triangle.
    ctx.fillStyle = MK_SKIN_SH;
    ctx.beginPath();
    ctx.moveTo(hx - 0.025 * sc, headY + 0.14 * sc);
    ctx.lineTo(hx + 0.025 * sc, headY + 0.14 * sc);
    ctx.lineTo(hx, headY + 0.22 * sc);
    ctx.closePath();
    ctx.fill();
    // Lips — full feminine red.
    ctx.fillStyle = '#bc4749';
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.27 * sc, 0.075 * sc, 0.022 * sc, 0, 0, TAU);
    ctx.fill();
    // Lip-shine highlight.
    ctx.fillStyle = `rgba(255,220,210,0.65)`;
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.265 * sc, 0.030 * sc, 0.007 * sc, 0, 0, TAU);
    ctx.fill();
  };

  // ── human eyes (white sclera + brown iris + brow + lashes) ──
  // Replaces the old gold-glow-under-shadow eyes so the musketeer reads as
  // a human heroine, not a magical sorceress.
  const drawEyeSide = (hx) => {
    const ex = hx + 0.20 * sc, ey = headY + 0.08 * sc;
    ctx.strokeStyle = '#2a1810';
    ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(ex - 0.07 * sc, ey - 0.005 * sc);
    ctx.quadraticCurveTo(ex, ey - 0.045 * sc, ex + 0.06 * sc, ey + 0.005 * sc);
    ctx.stroke();
    ctx.fillStyle = '#f5eee8';
    ctx.beginPath();
    ctx.ellipse(ex, ey + 0.005 * sc, 0.055 * sc, 0.030 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#4e3420';
    ctx.beginPath();
    ctx.arc(ex + 0.012 * sc, ey + 0.008 * sc, 0.026 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex + 0.020 * sc, ey, 0.010 * sc, 0, TAU);
    ctx.fill();
    // brow
    ctx.strokeStyle = 'rgba(80,55,40,0.90)';
    ctx.lineWidth = 0.020 * sc;
    ctx.beginPath();
    ctx.moveTo(ex - 0.06 * sc, ey - 0.07 * sc);
    ctx.quadraticCurveTo(ex, ey - 0.095 * sc, ex + 0.05 * sc, ey - 0.06 * sc);
    ctx.stroke();
  };
  const drawEyesFront = (hx) => {
    for (const dx of [-0.10, 0.10]) {
      const ex = hx + dx * sc, ey = headY + 0.10 * sc;
      ctx.strokeStyle = '#2a1810';
      ctx.lineWidth = 0.020 * sc;
      ctx.beginPath();
      ctx.moveTo(ex - 0.055 * sc, ey - 0.002 * sc);
      ctx.quadraticCurveTo(ex, ey - 0.038 * sc, ex + 0.055 * sc, ey - 0.002 * sc);
      ctx.stroke();
      ctx.fillStyle = '#f5eee8';
      ctx.beginPath();
      ctx.ellipse(ex, ey + 0.006 * sc, 0.050 * sc, 0.028 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#4e3420';
      ctx.beginPath();
      ctx.arc(ex, ey + 0.010 * sc, 0.025 * sc, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex + 0.010 * sc, ey + 0.002 * sc, 0.010 * sc, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(80,55,40,0.90)';
      ctx.lineWidth = 0.018 * sc;
      ctx.beginPath();
      ctx.moveTo(ex - 0.05 * sc, ey - 0.07 * sc);
      ctx.quadraticCurveTo(ex, ey - 0.090 * sc, ex + 0.05 * sc, ey - 0.07 * sc);
      ctx.stroke();
    }
  };

  // ── back of head: round orange-hair skull silhouette ──
  // Used by the back view so the heroine isn't a floating hat over empty
  // space. Sits under the tricorn brim and meets the ponytail root at the
  // nape. Includes side wisps that peek out below the hat, a soft darker
  // shadow side for cel-shading, lighter strand highlights, and a centre
  // part line suggesting the hair gathers into the tail.
  const drawHeadBack = (hx) => {
    // Round orange skull (hair covering the entire back of the head).
    ctx.fillStyle = MK_ORANGE;
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.06 * sc, 0.34 * sc, 0.32 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    // Darker side shadow for depth.
    ctx.fillStyle = MK_ORANGE_D;
    ctx.beginPath();
    ctx.ellipse(hx + 0.14 * sc, headY + 0.12 * sc, 0.15 * sc, 0.22 * sc, 0, 0, TAU);
    ctx.fill();
    // Lighter strand highlights flowing toward the nape.
    ctx.strokeStyle = `rgba(255,210,148,0.55)`;
    ctx.lineWidth = 0.014 * sc;
    for (let i = 0; i < 3; i++) {
      const off = (-0.14 + i * 0.10) * sc;
      ctx.beginPath();
      ctx.moveTo(hx + off, headY - 0.08 * sc);
      ctx.quadraticCurveTo(hx + off * 0.7, headY + 0.10 * sc,
                           hx + off * 0.3, headY + 0.26 * sc);
      ctx.stroke();
    }
    // Centre hair part / gather line down to the ponytail base.
    ctx.strokeStyle = MK_ORANGE_D;
    ctx.lineWidth = 0.020 * sc;
    ctx.beginPath();
    ctx.moveTo(hx, headY - 0.10 * sc);
    ctx.quadraticCurveTo(hx + 0.005 * sc, headY + 0.12 * sc,
                         hx, headY + 0.30 * sc);
    ctx.stroke();
    // Side wisps peeking below the brim (left + right).
    ctx.fillStyle = MK_ORANGE;
    ctx.beginPath();
    ctx.moveTo(hx - 0.32 * sc, headY + 0.02 * sc);
    ctx.quadraticCurveTo(hx - 0.40 * sc, headY + 0.14 * sc,
                         hx - 0.30 * sc, headY + 0.24 * sc);
    ctx.quadraticCurveTo(hx - 0.26 * sc, headY + 0.14 * sc,
                         hx - 0.22 * sc, headY + 0.08 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    ctx.fillStyle = MK_ORANGE;
    ctx.beginPath();
    ctx.moveTo(hx + 0.32 * sc, headY + 0.02 * sc);
    ctx.quadraticCurveTo(hx + 0.40 * sc, headY + 0.14 * sc,
                         hx + 0.30 * sc, headY + 0.24 * sc);
    ctx.quadraticCurveTo(hx + 0.26 * sc, headY + 0.14 * sc,
                         hx + 0.22 * sc, headY + 0.08 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
    // Small peach nape patch where the hair lifts off the neck.
    ctx.fillStyle = MK_SKIN_SH;
    ctx.beginPath();
    ctx.ellipse(hx, headY + 0.36 * sc, 0.10 * sc, 0.05 * sc, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.5; ctx.stroke();
  };

  // ════════════════════════════════════════════════════════════════════════
  // ── VIEW DISPATCH ─────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  if (p.view === 'side') {

    // (Back-skirt flutter / cloak removed — clean dress silhouette only.)

    // ── back ponytail tail (visible behind head) ──
    drawPonytail(-0.20 * sc, headY + 0.32 * sc, -1, -recoilFan * 0.30);

    // ── legs ──
    const legSpread = 0.20 * sc;
    const legSwing  = sw * 0.30 * sc * p.moving;
    const drawSideLeg = (side, swingX, isBack) => {
      const hipX     = side * legSpread;
      const footX    = side * legSpread + swingX;
      const kneeBend = side * legSpread + swingX * 0.55;
      const kneeY    = (hipY + baseY) * 0.5 + Math.abs(swingX) * 0.10;
      // Thicker peach legs (girly but sturdy chibi proportions).
      ctx.fillStyle = isBack ? MK_SKIN_SH : MK_SKIN;
      capsule(ctx, hipX, hipY + 0.08 * sc, kneeBend, kneeY, 0.14 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      capsule(ctx, kneeBend, kneeY, footX, baseY - 0.38 * sc, 0.12 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // subtle peach shadow on the back of the calf (near leg only)
      if (!isBack) {
        ctx.fillStyle = `rgba(232,168,155,0.50)`;
        capsule(ctx, kneeBend - 0.04 * sc, kneeY + 0.04 * sc,
                     footX - 0.04 * sc, baseY - 0.40 * sc, 0.050 * sc);
        ctx.fill();
      }
      // tall navy boot
      ctx.fillStyle = MK_NAVY;
      rr(ctx, footX - 0.22 * sc, baseY - 0.40 * sc, 0.46 * sc, 0.42 * sc, 0.06 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // navy boot sole
      ctx.fillStyle = MK_NAVY_D;
      rr(ctx, footX - 0.24 * sc, baseY - 0.06 * sc, 0.50 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      // gold cuff at the top of the boot
      ctx.fillStyle = MK_GOLD;
      rr(ctx, footX - 0.22 * sc, baseY - 0.42 * sc, 0.46 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.014 * sc; ctx.stroke();
      // foot-plant dust
      const plantA = Math.max(0, (isBack ? -sw : sw)) * p.moving;
      if (plantA > 0.15) {
        ctx.fillStyle = `rgba(180,180,170,${0.20 * plantA})`;
        ctx.beginPath();
        ctx.ellipse(footX - 0.08 * sc * (isBack ? -1 : 1), baseY + 0.02 * sc,
                    0.32 * sc * plantA, 0.09 * sc * plantA, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawSideLeg(-1, -legSwing, true);

    // ── hourglass bodice (side profile, cinched at the waist) ──
    // Back side: gentle in-curve at the small of the back.
    // Belly side: bust bulges forward, tucks sharply into the waist.
    const coatHemY = hipY + 0.20 * sc;  // SHORT skirt hem (was hipY + 0.34)
    const waistBackX  = -0.20 * sc;
    const waistFrontX =  0.26 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.30 * sc, shoY);                                       // back shoulder
    ctx.quadraticCurveTo(-0.42 * sc, shoY + 0.34 * sc,                 // back upper bulge
                         waistBackX, hipY);                             // back waist (cinch)
    ctx.lineTo(waistFrontX, hipY);                                      // belly waist (cinch)
    ctx.quadraticCurveTo(0.54 * sc, shoY + 0.30 * sc,                  // bust bulge (front)
                         0.42 * sc, shoY);                              // front shoulder
    ctx.quadraticCurveTo(0.04 * sc, shoY - 0.18 * sc, -0.30 * sc, shoY); // collar
    ctx.closePath();
    const tg = ctx.createLinearGradient(-0.4 * sc, shoY, 0.4 * sc, hipY);
    tg.addColorStop(0, MK_SKY);
    tg.addColorStop(0.55, MK_TEAL);
    tg.addColorStop(1, MK_TEAL_D);
    ctx.fillStyle = tg;
    ctx.fill();
    // back-side shadow band (re-traces just the back half of the bodice).
    ctx.fillStyle = `rgba(2,48,71,0.45)`;
    ctx.beginPath();
    ctx.moveTo(-0.30 * sc, shoY);
    ctx.quadraticCurveTo(-0.42 * sc, shoY + 0.34 * sc,
                         waistBackX, hipY);
    ctx.lineTo(-0.04 * sc, hipY);
    ctx.lineTo(-0.06 * sc, shoY - 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.10;
    ctx.beginPath();
    ctx.moveTo(-0.30 * sc, shoY);
    ctx.quadraticCurveTo(-0.42 * sc, shoY + 0.34 * sc,
                         waistBackX, hipY);
    ctx.lineTo(waistFrontX, hipY);
    ctx.quadraticCurveTo(0.54 * sc, shoY + 0.30 * sc,
                         0.42 * sc, shoY);
    ctx.quadraticCurveTo(0.04 * sc, shoY - 0.18 * sc, -0.30 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // Gold buttons down the front of the bodice.
    drawCoatButtons(0.20 * sc, shoY + 0.16 * sc, hipY - 0.08 * sc);
    // Light-blue sweetheart neckline.
    ctx.strokeStyle = MK_SKY;
    ctx.lineWidth = 0.030 * sc;
    ctx.beginPath();
    ctx.moveTo(0.04 * sc, shoY - 0.02 * sc);
    ctx.quadraticCurveTo(0.22 * sc, shoY + 0.18 * sc, 0.34 * sc, shoY + 0.04 * sc);
    ctx.stroke();

    // ── A-line short skirt (flared from waist, above-knee, fluttering) ──
    {
      ctx.fillStyle = MK_TEAL_D;
      ctx.beginPath();
      ctx.moveTo(waistBackX, hipY + 0.02 * sc);
      ctx.quadraticCurveTo(-0.42 * sc + flutter * 0.4 - recoilFan * 0.30 * sc,
                            (hipY + coatHemY) * 0.5,
                            -0.46 * sc + flutter * 0.6 - recoilFan * 0.40 * sc,
                            coatHemY);
      ctx.quadraticCurveTo(-0.04 * sc, coatHemY + 0.12 * sc,
                            0.40 * sc + flutter * 0.2, coatHemY - 0.04 * sc);
      ctx.quadraticCurveTo(0.42 * sc, (hipY + coatHemY) * 0.5,
                            waistFrontX, hipY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.9; ctx.stroke();
      // teal mid-tone overlay (the lit, belly-side half)
      ctx.fillStyle = MK_TEAL;
      ctx.beginPath();
      ctx.moveTo(0, hipY + 0.02 * sc);
      ctx.quadraticCurveTo(0.10 * sc, (hipY + coatHemY) * 0.5,
                           0.36 * sc + flutter * 0.2, coatHemY - 0.06 * sc);
      ctx.quadraticCurveTo(0.40 * sc, (hipY + coatHemY) * 0.5,
                           waistFrontX, hipY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      // Gold trim seam along the bottom hem.
      ctx.strokeStyle = MK_GOLD;
      ctx.lineWidth = 0.026 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.42 * sc + flutter * 0.4 - recoilFan * 0.30 * sc,
                 coatHemY - 0.02 * sc);
      ctx.quadraticCurveTo(-0.04 * sc, coatHemY + 0.10 * sc,
                            0.38 * sc + flutter * 0.2, coatHemY - 0.06 * sc);
      ctx.stroke();
    }

    // ── narrow belt + buckle at the cinched waist ──
    ctx.fillStyle = MK_NAVY;
    rr(ctx, waistBackX - 0.02 * sc, hipY - 0.06 * sc,
        (waistFrontX - waistBackX) + 0.04 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = MK_GOLD;
    rr(ctx, 0.04 * sc, hipY - 0.04 * sc, 0.18 * sc, 0.14 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = MK_NAVY;
    ctx.beginPath();
    ctx.arc(0.16 * sc, hipY + 0.04 * sc, 0.040 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = MK_GOLD_HI;
    ctx.fillRect(0.08 * sc, hipY - 0.02 * sc, 0.06 * sc, 0.020 * sc);

    // ── front (near) leg over the coat ──
    drawSideLeg(1, legSwing, false);

    // ── arms + musket ───────────────────────────────────────────────
    // Back-hand (trigger) grips behind the lock; front-hand (off-hand)
    // grips the forestock further along the barrel.  At rest the musket
    // is at the hip pointing slightly forward-down; on aim it lifts to
    // shoulder horizontal; on strike it kicks back briefly.
    const armAng = lerp(0.42, 0.00, shoulder) + strikePhase * (1 - recoverPhase) * -0.10;
    // Back-hand position in screen-local coords.
    const backShX = -0.06 * sc, backShY = shoY + 0.18 * sc;
    const frontShX = 0.34 * sc, frontShY = shoY + 0.14 * sc;
    const backHandX = lerp(0.10 * sc, -0.04 * sc, shoulder)
                    - strikePhase * (1 - recoverPhase) * 0.10 * sc;
    const backHandY = lerp(hipY + 0.06 * sc, shoY + 0.18 * sc, shoulder)
                    + strikePhase * (1 - recoverPhase) * 0.04 * sc;
    // Front-hand on the forestock — half-way along the barrel.
    const barrelL = L;
    const cosA = Math.cos(armAng), sinA = Math.sin(armAng);
    const frontHandX = backHandX + cosA * (-barrelL * 0.32);
    const frontHandY = backHandY + sinA * (-barrelL * 0.32);
    // Muzzle screen position (just for completeness; flash is drawn in
    // the musket's own local frame below).
    // const muzzleX = backHandX + cosA * (-barrelL * 0.50);
    // const muzzleY = backHandY + sinA * (-barrelL * 0.50);

    // Back upper arm (behind torso) — thicker for chibi balance.
    ctx.fillStyle = MK_TEAL;
    capsule(ctx, backShX, backShY, backHandX, backHandY, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // Sleeve shadow on the underside.
    ctx.fillStyle = `rgba(2,48,71,0.40)`;
    capsule(ctx, backShX + 0.02 * sc, backShY + 0.04 * sc,
                 backHandX + 0.02 * sc, backHandY + 0.04 * sc, 0.07 * sc);
    ctx.fill();
    // Cuff + hand.
    ctx.save();
    ctx.translate(backHandX, backHandY);
    ctx.rotate(Math.atan2(backHandY - backShY, backHandX - backShX));
    ctx.fillStyle = MK_SKY;
    rr(ctx, -0.13 * sc, -0.085 * sc, 0.22 * sc, 0.17 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    // Gold trim along cuff.
    ctx.strokeStyle = MK_GOLD; ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.10 * sc, -0.085 * sc);
    ctx.lineTo(-0.10 * sc, 0.085 * sc);
    ctx.stroke();
    // Skin hand.
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.065 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    // ── head + hat go above arm so tilt doesn't hide eyes ──
    // Head tilt: small forward-and-down on aim (sighting down barrel).
    // The entire head/hat/plume scales up around the chin pivot for chibi cuteness.
    ctx.save();
    const headTiltX = shoulder * 0.04 * sc;
    const headTiltY = shoulder * 0.02 * sc;
    ctx.translate(headTiltX, headTiltY);
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      // Skin face slice (under hat).
      drawSkinSide(0);
      // Tricorn hat over the head.
      drawTricornSide(0);
      // Plume rises from the side of the hat.
      ctx.save();
      ctx.translate(-0.20 * sc, headY - 0.30 * sc);
      drawPlume(0, 0, 0.60 * sc, plume);
      ctx.restore();
      // Eye glow under hat brim.
      drawEyeSide(0);
      ctx.restore();
    }
    ctx.restore();

    // ── front arm + musket (no shoulder mantle — cloak/trim removed) ──
    // Front (off-hand) upper arm — thicker for chibi balance.
    ctx.fillStyle = MK_TEAL;
    capsule(ctx, frontShX, frontShY, frontHandX, frontHandY, 0.15 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // sleeve shadow
    ctx.fillStyle = `rgba(2,48,71,0.40)`;
    capsule(ctx, frontShX + 0.05 * sc, frontShY + 0.04 * sc,
                 frontHandX + 0.05 * sc, frontHandY + 0.04 * sc, 0.07 * sc);
    ctx.fill();
    // Cuff + hand on the forestock.
    ctx.save();
    ctx.translate(frontHandX, frontHandY);
    ctx.rotate(Math.atan2(frontHandY - frontShY, frontHandX - frontShX));
    ctx.fillStyle = MK_SKY;
    rr(ctx, -0.12 * sc, -0.08 * sc, 0.22 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.strokeStyle = MK_GOLD; ctx.lineWidth = 0.022 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.10 * sc, -0.08 * sc);
    ctx.lineTo(-0.10 * sc, 0.08 * sc);
    ctx.stroke();
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.070 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    // ── the musket itself ──
    ctx.save();
    ctx.translate(backHandX, backHandY);
    ctx.rotate(armAng + Math.PI / 2);   // canonical UP → armAng direction
    drawMusket();
    // Muzzle flash + smoke during the STRIKE window (firePop drives both).
    drawMuzzleFlash(firePop);
    ctx.restore();

  // ── FRONT VIEW ─────────────────────────────────────────────────────────
  } else if (p.view === 'front') {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    // (Old long coat side-flaps removed — replaced by the new short
    //  hourglass dress silhouette below.)

    // ── legs (alternating lifts) ──
    const legSpreadF = 0.20 * sc;
    const liftL = Math.max(0, sw)  * 0.20 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.20 * sc * p.moving;
    const drawFrontLeg = (side, footLift) => {
      const x = side * legSpreadF;
      const footPt = baseY - footLift;
      // Thicker peach legs (chibi proportions).
      ctx.fillStyle = MK_SKIN;
      capsule(ctx, x, hipY + 0.10 * sc, x, footPt - 0.40 * sc, 0.13 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      // soft shadow down the outer side
      ctx.fillStyle = `rgba(232,168,155,0.50)`;
      capsule(ctx, x + side * 0.06 * sc, hipY + 0.16 * sc,
                   x + side * 0.06 * sc, footPt - 0.44 * sc, 0.050 * sc);
      ctx.fill();
      // navy knee-high boot
      ctx.fillStyle = MK_NAVY;
      rr(ctx, x - 0.18 * sc, footPt - 0.40 * sc, 0.36 * sc, 0.42 * sc, 0.06 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = MK_NAVY_D;
      rr(ctx, x - 0.20 * sc, footPt - 0.06 * sc, 0.40 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      // gold cuff on top of boot
      ctx.fillStyle = MK_GOLD;
      rr(ctx, x - 0.18 * sc, footPt - 0.42 * sc, 0.36 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.014 * sc; ctx.stroke();
      if (footLift < 0.02 * sc && p.moving > 0.2) {
        ctx.fillStyle = `rgba(180,180,170,${0.22 * p.moving})`;
        ctx.beginPath();
        ctx.ellipse(x, baseY + 0.02 * sc, 0.30 * sc, 0.08 * sc, 0, 0, TAU);
        ctx.fill();
      }
    };
    drawFrontLeg(-1, liftL);
    drawFrontLeg(1, liftR);

    // ── hourglass bodice (wide bust → cinched waist) ──
    // Top: shoY at ±0.44 (broad shoulders); bust bulge to ±0.50 around
    // the upper third; waist cinch to ±0.22 at hipY (belt line).
    const waistY = hipY;
    const waistHalfW = 0.22 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.44 * sc, shoY);
    ctx.quadraticCurveTo(-0.50 * sc, shoY + 0.20 * sc,
                         -0.40 * sc, shoY + 0.42 * sc);
    ctx.quadraticCurveTo(-0.28 * sc, waistY - 0.10 * sc,
                         -waistHalfW, waistY);
    ctx.lineTo(waistHalfW, waistY);
    ctx.quadraticCurveTo(0.28 * sc, waistY - 0.10 * sc,
                          0.40 * sc, shoY + 0.42 * sc);
    ctx.quadraticCurveTo(0.50 * sc, shoY + 0.20 * sc,
                          0.44 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.20 * sc, -0.44 * sc, shoY);
    ctx.closePath();
    const tgF = ctx.createLinearGradient(-0.44 * sc, shoY, 0.44 * sc, hipY);
    tgF.addColorStop(0, MK_SKY);
    tgF.addColorStop(0.5, MK_TEAL);
    tgF.addColorStop(1, MK_TEAL_D);
    ctx.fillStyle = tgF;
    ctx.fill();
    // right-side shadow band (re-traces the right half of the bodice).
    ctx.fillStyle = `rgba(2,48,71,0.35)`;
    ctx.beginPath();
    ctx.moveTo(0.44 * sc, shoY);
    ctx.quadraticCurveTo(0.50 * sc, shoY + 0.20 * sc,
                          0.40 * sc, shoY + 0.42 * sc);
    ctx.quadraticCurveTo(0.28 * sc, waistY - 0.10 * sc,
                          waistHalfW, waistY);
    ctx.lineTo(0.10 * sc, waistY);
    ctx.lineTo(0.12 * sc, shoY - 0.02 * sc);
    ctx.closePath();
    ctx.fill();
    // outline the whole hourglass bodice
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 1.10;
    ctx.beginPath();
    ctx.moveTo(-0.44 * sc, shoY);
    ctx.quadraticCurveTo(-0.50 * sc, shoY + 0.20 * sc,
                         -0.40 * sc, shoY + 0.42 * sc);
    ctx.quadraticCurveTo(-0.28 * sc, waistY - 0.10 * sc,
                         -waistHalfW, waistY);
    ctx.lineTo(waistHalfW, waistY);
    ctx.quadraticCurveTo(0.28 * sc, waistY - 0.10 * sc,
                          0.40 * sc, shoY + 0.42 * sc);
    ctx.quadraticCurveTo(0.50 * sc, shoY + 0.20 * sc,
                          0.44 * sc, shoY);
    ctx.quadraticCurveTo(0, shoY - 0.20 * sc, -0.44 * sc, shoY);
    ctx.closePath();
    ctx.stroke();
    // Light-blue sweetheart neckline / lapels along the chest opening.
    ctx.strokeStyle = MK_SKY;
    ctx.lineWidth = 0.034 * sc;
    ctx.beginPath();
    ctx.moveTo(-0.22 * sc, shoY - 0.02 * sc);
    ctx.quadraticCurveTo(0, shoY + 0.16 * sc, 0.22 * sc, shoY - 0.02 * sc);
    ctx.stroke();
    // Gold buttons down the centre of the bodice.
    drawCoatButtons(0, shoY + 0.22 * sc, waistY - 0.10 * sc);

    // ── A-line short skirt (flares from cinched waist to above-knee hem) ──
    {
      const hemY = hipY + 0.20 * sc;   // SHORT — was hipY + 0.32
      const hemHalfW = 0.50 * sc;       // FLARED — was 0.46
      ctx.fillStyle = MK_TEAL_D;
      ctx.beginPath();
      ctx.moveTo(-waistHalfW, hipY + 0.04 * sc);
      ctx.quadraticCurveTo(-0.40 * sc + flutter * 0.3,
                           (hipY + hemY) * 0.5,
                           -hemHalfW + flutter * 0.5, hemY);
      ctx.quadraticCurveTo(0, hemY + 0.12 * sc,
                            hemHalfW - flutter * 0.5, hemY);
      ctx.quadraticCurveTo(0.40 * sc - flutter * 0.3,
                           (hipY + hemY) * 0.5,
                            waistHalfW, hipY + 0.04 * sc);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.9; ctx.stroke();
      // Lighter teal lit-side overlay (left half of the skirt catches light).
      ctx.fillStyle = MK_TEAL;
      ctx.beginPath();
      ctx.moveTo(0, hipY + 0.04 * sc);
      ctx.quadraticCurveTo(-0.18 * sc + flutter * 0.3,
                           (hipY + hemY) * 0.5,
                           -hemHalfW + flutter * 0.5, hemY);
      ctx.quadraticCurveTo(-0.25 * sc, hemY + 0.08 * sc, 0, hemY + 0.02 * sc);
      ctx.closePath();
      ctx.fill();
      // Gold trim along the hem.
      ctx.strokeStyle = MK_GOLD;
      ctx.lineWidth = 0.026 * sc;
      ctx.beginPath();
      ctx.moveTo(-hemHalfW + 0.02 * sc + flutter * 0.3, hemY - 0.04 * sc);
      ctx.quadraticCurveTo(0, hemY + 0.10 * sc,
                            hemHalfW - 0.02 * sc - flutter * 0.3, hemY - 0.04 * sc);
      ctx.stroke();
      // Centre seam down the skirt.
      ctx.strokeStyle = MK_NAVY;
      ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(0, hipY + 0.04 * sc);
      ctx.lineTo(0, hemY + 0.04 * sc);
      ctx.stroke();
    }

    // ── narrow belt + buckle at the cinched waist ──
    ctx.fillStyle = MK_NAVY;
    rr(ctx, -0.30 * sc, hipY - 0.06 * sc, 0.60 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
    ctx.fillStyle = MK_GOLD;
    rr(ctx, -0.10 * sc, hipY - 0.04 * sc, 0.20 * sc, 0.14 * sc, 0.025 * sc);
    ctx.fill();
    ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.022 * sc; ctx.stroke();
    ctx.fillStyle = MK_NAVY;
    ctx.beginPath();
    ctx.arc(0, hipY + 0.03 * sc, 0.038 * sc, 0, TAU);
    ctx.fill();
    ctx.fillStyle = MK_GOLD_HI;
    ctx.fillRect(-0.06 * sc, hipY - 0.02 * sc, 0.04 * sc, 0.018 * sc);

    // ── ponytail drapes behind from one side ──
    drawPonytail(-0.18 * sc, headY + 0.38 * sc, -1, -recoilFan * 0.30);

    // ── arms + musket diagonal across body ──
    // At rest the musket is held diagonally across the chest. On ATTACK it
    // rotates toward pointing at the camera (we see the muzzle from straight
    // on as a bright halo). Reuse the canonical "barrel UP" musket and
    // rotate it.
    const armAngF = lerp(-Math.PI / 4, Math.PI / 2 - 0.18, shoulder);
    // Two-hand grip in front of the chest.
    const backShXF = 0.40 * sc, backShYF = shoY + 0.20 * sc;
    const frontShXF = -0.40 * sc, frontShYF = shoY + 0.20 * sc;
    const backHandXF  = lerp(0.22 * sc, 0.06 * sc, shoulder);
    const backHandYF  = lerp(hipY + 0.04 * sc, shoY + 0.30 * sc, shoulder);
    const frontHandXF = lerp(-0.10 * sc, -0.12 * sc, shoulder);
    const frontHandYF = lerp(shoY + 0.30 * sc, shoY + 0.10 * sc, shoulder);

    // Back arm (trigger) — thicker.
    ctx.fillStyle = MK_TEAL;
    capsule(ctx, backShXF, backShYF, backHandXF, backHandYF, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    // hand
    ctx.save();
    ctx.translate(backHandXF, backHandYF);
    ctx.rotate(Math.atan2(backHandYF - backShYF, backHandXF - backShXF));
    ctx.fillStyle = MK_SKY;
    rr(ctx, -0.12 * sc, -0.08 * sc, 0.22 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.07 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();
    // Front arm (off-hand) — thicker.
    ctx.fillStyle = MK_TEAL;
    capsule(ctx, frontShXF, frontShYF, frontHandXF, frontHandYF, 0.14 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
    ctx.save();
    ctx.translate(frontHandXF, frontHandYF);
    ctx.rotate(Math.atan2(frontHandYF - frontShYF, frontHandXF - frontShXF));
    ctx.fillStyle = MK_SKY;
    rr(ctx, -0.12 * sc, -0.08 * sc, 0.22 * sc, 0.16 * sc, 0.04 * sc);
    ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.7; ctx.stroke();
    ctx.fillStyle = MK_SKIN;
    ctx.beginPath(); ctx.arc(0.08 * sc, 0, 0.07 * sc, 0, TAU); ctx.fill();
    ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.55; ctx.stroke();
    ctx.restore();

    // Musket — rotated to point ~at the camera during aim.
    ctx.save();
    ctx.translate(backHandXF, backHandYF);
    ctx.rotate(armAngF + Math.PI / 2);
    drawMusket();
    drawMuzzleFlash(firePop);
    ctx.restore();

    // Head + hat go ABOVE the front arm so the eyes aren't hidden.
    // Whole head + hat + plume + eyes scales up around the chin pivot.
    ctx.save();
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      drawSkinFront(0);
      drawTricornFront(0);
      // Plume rises from the side of the tricorn (right side of head).
      ctx.save();
      ctx.translate(0.20 * sc, headY - 0.30 * sc);
      drawPlume(0, 0, 0.56 * sc, plume);
      ctx.restore();
      drawEyesFront(0);
      ctx.restore();
    }
    ctx.restore();

  // ── BACK VIEW ──────────────────────────────────────────────────────────
  } else {
    const sway = Math.sin(p.gait * TAU) * p.moving * 0.05 * sc;
    ctx.translate(sway, 0);

    // ── legs (back) ──
    const legSpreadB = 0.20 * sc;
    const liftL = Math.max(0, sw)  * 0.18 * sc * p.moving;
    const liftR = Math.max(0, -sw) * 0.18 * sc * p.moving;
    const drawBackLeg = (side, footLift) => {
      const x = side * legSpreadB;
      const footPt = baseY - footLift;
      // Thicker peach legs from behind (chibi proportions).
      ctx.fillStyle = MK_SKIN;
      capsule(ctx, x, hipY + 0.10 * sc, x, footPt - 0.40 * sc, 0.13 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.85; ctx.stroke();
      ctx.fillStyle = `rgba(232,168,155,0.50)`;
      capsule(ctx, x - side * 0.05 * sc, hipY + 0.16 * sc,
                   x - side * 0.05 * sc, footPt - 0.42 * sc, 0.050 * sc);
      ctx.fill();
      // navy boot back
      ctx.fillStyle = MK_NAVY;
      rr(ctx, x - 0.18 * sc, footPt - 0.40 * sc, 0.36 * sc, 0.42 * sc, 0.06 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      ctx.fillStyle = MK_NAVY_D;
      rr(ctx, x - 0.20 * sc, footPt - 0.06 * sc, 0.40 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      // gold cuff
      ctx.fillStyle = MK_GOLD;
      rr(ctx, x - 0.18 * sc, footPt - 0.42 * sc, 0.36 * sc, 0.06 * sc, 0.02 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.014 * sc; ctx.stroke();
    };
    drawBackLeg(-1, liftL);
    drawBackLeg(1, liftR);

    // ── hourglass back panel + A-line short skirt ──
    // Single continuous silhouette: wide shoulders, cinched at the waist
    // (hipY), then flared A-line short skirt above the knee.
    {
      const ky0 = shoY + 0.02 * sc;       // top of bodice
      const waistY = hipY;                  // cinch
      const waistHalfW = 0.22 * sc;         // cinched waist half-width
      const kyB = hipY + 0.20 * sc;         // SHORT hem (was hipY + 0.34)
      const hemHalfW = 0.50 * sc;           // flared hem half-width
      // Full silhouette (bodice + skirt) in one path.
      ctx.fillStyle = MK_TEAL;
      ctx.beginPath();
      // shoulder line (left side, top)
      ctx.moveTo(-0.46 * sc, ky0);
      // back bulge → cinch into waist (left)
      ctx.quadraticCurveTo(-0.52 * sc, shoY + 0.38 * sc,
                           -waistHalfW, waistY);
      // skirt flare from waist out to hem (left)
      ctx.quadraticCurveTo(-0.40 * sc + flutter * 0.3,
                           (waistY + kyB) * 0.5,
                           -hemHalfW + flutter * 0.5, kyB);
      // curved hem across the bottom
      ctx.quadraticCurveTo(0, kyB + 0.14 * sc + flutter * 0.4,
                            hemHalfW - flutter * 0.5, kyB);
      // skirt flare back up to waist (right)
      ctx.quadraticCurveTo(0.40 * sc - flutter * 0.3,
                           (waistY + kyB) * 0.5,
                            waistHalfW, waistY);
      // cinch out to shoulder (right)
      ctx.quadraticCurveTo(0.52 * sc, shoY + 0.38 * sc,
                            0.46 * sc, ky0);
      // collar / shoulder line across top
      ctx.quadraticCurveTo(0, ky0 - 0.14 * sc, -0.46 * sc, ky0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW; ctx.stroke();
      // Gold spine seam down the centre of the bodice + skirt.
      ctx.strokeStyle = MK_GOLD;
      ctx.lineWidth = 0.034 * sc;
      ctx.beginPath();
      ctx.moveTo(0, ky0 + 0.02 * sc);
      ctx.quadraticCurveTo(flutter * 0.3, (shoY + waistY) * 0.5,
                           flutter * 0.4, waistY - 0.02 * sc);
      ctx.moveTo(flutter * 0.4, waistY + 0.10 * sc);
      ctx.lineTo(flutter * 0.4, kyB - 0.04 * sc);
      ctx.stroke();
      // Sky-blue highlight stripe down one side of the back.
      ctx.strokeStyle = MK_SKY;
      ctx.lineWidth = 0.022 * sc;
      ctx.beginPath();
      ctx.moveTo(-0.34 * sc, shoY + 0.18 * sc);
      ctx.quadraticCurveTo(-0.24 * sc, (shoY + waistY) * 0.5,
                           -waistHalfW + 0.04 * sc, waistY - 0.04 * sc);
      ctx.stroke();
      // Gold hem trim along the curved bottom.
      ctx.strokeStyle = MK_GOLD;
      ctx.lineWidth = 0.030 * sc;
      ctx.beginPath();
      ctx.moveTo(-hemHalfW + 0.02 * sc, kyB - 0.04 * sc);
      ctx.quadraticCurveTo(0, kyB + 0.14 * sc + flutter * 0.4,
                            hemHalfW - 0.02 * sc, kyB - 0.04 * sc);
      ctx.stroke();
      // Visible narrow belt cinching the waist (across the back).
      ctx.fillStyle = MK_NAVY;
      rr(ctx, -waistHalfW - 0.02 * sc, waistY - 0.06 * sc,
          waistHalfW * 2 + 0.04 * sc, 0.16 * sc, 0.04 * sc);
      ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = OW * 0.8; ctx.stroke();
      // Small gold belt seam down the centre of the back belt.
      ctx.fillStyle = MK_GOLD;
      rr(ctx, -0.04 * sc, waistY - 0.05 * sc, 0.08 * sc, 0.14 * sc, 0.020 * sc);
      ctx.fill();
      ctx.strokeStyle = MK_NAVY_D; ctx.lineWidth = 0.018 * sc; ctx.stroke();
    }

    // ── musket slung over one shoulder, barrel up-back ──
    {
      ctx.save();
      ctx.translate(0.36 * sc, shoY + 0.18 * sc);
      ctx.rotate(0.55);              // tilted across the back, barrel up-right
      // The musket draws barrel-up; ground its grip near the shoulder.
      drawMusket();
      ctx.restore();
    }

    // ── back of head (orange hair) + tricorn from behind ──
    // Draw the hair-covered skull FIRST so the tricorn sits on top of it.
    // The whole head unit scales up around the chin pivot for chibi cuteness.
    {
      const pY = HEAD_PIVOT_Y();
      ctx.save();
      ctx.translate(0, pY);
      ctx.scale(HEAD_S, HEAD_S);
      ctx.translate(0, -pY);
      drawHeadBack(0);
      drawTricornBack(0);
      // Plume rises from the side (visible from behind).
      ctx.save();
      ctx.translate(0.22 * sc, headY - 0.28 * sc);
      drawPlume(0, 0, 0.56 * sc, plume);
      ctx.restore();
      ctx.restore();
    }

    // ── orange ponytail tied at the nape — drawn AFTER the head so the
    // navy tying band visually sits on the back of the hair, with the
    // tail draping down past the head outline over the coat back.
    drawPonytail(0, headY + 0.36 * sc, 0, 0);
  }

  // ── hit flash (white wash over the whole figure) ──
  if (p.flash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.55 * p.flash})`;
    rr(ctx, -0.66 * sc, headY - 0.55 * sc,
        1.32 * sc, (baseY - headY) + 0.70 * sc, 0.26 * sc);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
  return true;
}

export function markMusketeer(id) {
  const a = anim.get(id);
  if (a) a.wasMusketeer = true;
}

// Fast bullet projectile fired by the Musketeer. A small dark-navy bullet
// body with a brass tip, a bright white-hot leading edge (additive), a
// long fading gold/white motion-blur streak, and a faint smoke trail of
// 2-3 grayish puffs. Used by the bolt branch in renderer.js when
// p.src.card === 'Musketeer'. Same call shape as drawArrow / drawMinionSpit:
//   opts.alpha (num) — overall alpha multiplier (default 1).
export function drawMusketBullet(ctx, x, y, ang, tile, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;
  const L = tile * 0.30;           // bullet body length
  const W = tile * 0.075;          // bullet body width

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // ── long motion-blur streak (gold → white core, fading to transparent) ──
  const tailL = tile * 1.8;
  const grad = ctx.createLinearGradient(-tailL, 0, -L * 0.5, 0);
  grad.addColorStop(0,   `rgba(255,250,220,0)`);
  grad.addColorStop(0.5, `rgba(255,183,3,${0.40 * alpha})`);
  grad.addColorStop(1,   `rgba(255,255,255,${0.85 * alpha})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-tailL, -W * 0.06);
  ctx.lineTo(-L * 0.5, -W * 0.45);
  ctx.lineTo(-L * 0.5,  W * 0.45);
  ctx.lineTo(-tailL,  W * 0.06);
  ctx.closePath();
  ctx.fill();

  // ── faint smoke trail (grayish puffs trailing behind) ─────────────────
  for (let i = 1; i <= 3; i++) {
    const dx = -tile * (0.32 + i * 0.22);
    const dy = (i % 2 ? 1 : -1) * tile * 0.030;
    const r  = tile * (0.035 + i * 0.015);
    ctx.fillStyle = `rgba(220,220,220,${0.18 * alpha / i})`;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, TAU);
    ctx.fill();
  }

  // ── bullet body (dark-navy rounded rectangle) ─────────────────────────
  ctx.fillStyle = `rgba(2,48,71,${alpha})`;
  rr(ctx, -L * 0.5, -W * 0.5, L * 0.78, W, W * 0.45);
  ctx.fill();
  ctx.strokeStyle = `rgba(2,26,38,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.018);
  ctx.stroke();

  // ── brass/gold tip (forward-pointing triangle) ────────────────────────
  ctx.fillStyle = `rgba(255,183,3,${alpha})`;
  ctx.beginPath();
  ctx.moveTo(L * 0.28, -W * 0.5);
  ctx.lineTo(L * 0.55, 0);
  ctx.lineTo(L * 0.28,  W * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(2,48,71,${alpha})`;
  ctx.lineWidth = Math.max(1, tile * 0.018);
  ctx.stroke();
  // Tiny gold highlight on the upper edge.
  ctx.fillStyle = `rgba(255,212,98,${0.90 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(L * 0.30, -W * 0.40);
  ctx.lineTo(L * 0.48, -W * 0.05);
  ctx.lineTo(L * 0.30, -W * 0.10);
  ctx.closePath();
  ctx.fill();

  // ── light-blue catch along the top of the body (cel-shade highlight) ──
  ctx.fillStyle = `rgba(142,202,230,${0.55 * alpha})`;
  rr(ctx, -L * 0.45, -W * 0.42, L * 0.62, W * 0.18, W * 0.10);
  ctx.fill();

  // ── bright white-hot leading edge (additive glow) ─────────────────────
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(255,250,220,${0.95 * alpha})`;
  ctx.beginPath();
  ctx.arc(L * 0.42, 0, tile * 0.055, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  ctx.beginPath();
  ctx.arc(L * 0.44, 0, tile * 0.025, 0, TAU);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

export function drawDeathPoofs(ctx, sx, sy, tile) {
  for (const d of poofs) {
    const t = clamp01(d.t);
    const age = 1 - t;
    // Per-poof scale (Giants are 1.7×; Knights default to 1).
    const psc = d.scale || 1;
    const T = tile * psc;
    const cx = sx(d.x), cy = sy(d.y) - T * 0.55;
    // Archer poof uses a teal-tinted ring (matches its hooded-ranger palette),
    // Goblin poof uses a mid-green ring (matches the leaf-goblin palette),
    // Minion poof uses a dark-navy ring (matches the bat-imp palette),
    // Musketeer poof uses a teal-blue ring (matches the heroine's palette),
    // Cannon poof uses an iron-grey ring (matches the artillery palette);
    // everyone else uses team colour.
    const teamRgb = d.musketeer ? '33,158,188'
                  : (d.minion ? '27,38,59'
                  : (d.goblin ? '106,153,78'
                  : (d.archer ? '0,109,119'
                  : (d.cannon ? '124,130,142'
                  : (d.owner === 0 ? '20,33,61' : '252,163,17')))));

    // expanding shock ring (team-tinted)
    ctx.strokeStyle = `rgba(${teamRgb},${0.70 * t})`;
    ctx.lineWidth = 3 * psc;
    ctx.beginPath();
    ctx.arc(cx, cy, T * (0.5 + age * 1.4), 0, TAU);
    ctx.stroke();

    // dust cloud
    ctx.fillStyle = `rgba(160,160,160,${0.30 * t})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy + T * 0.45, T * (0.7 + age * 0.6),
                T * (0.18 + age * 0.18), 0, 0, TAU);
    ctx.fill();

    // Cannon-specific drifting smoke puffs (drawn before shards so they read
    // as background haze). Drift outward + up, expand and fade as they age.
    if (d.cannon && d.puffs) {
      for (const pf of d.puffs) {
        const r = T * (0.18 + age * pf.speed * 1.4) + T * pf.r0;
        const px = cx + Math.cos(pf.ang) * T * (0.20 + age * pf.speed * 1.6);
        const py = cy + Math.sin(pf.ang) * T * (0.20 + age * pf.speed * 1.0)
                       - age * T * 0.55; // rise
        const alpha = (1 - age / Math.max(0.01, pf.life)) * 0.45;
        if (alpha <= 0.01) continue;
        ctx.fillStyle = `rgba(190,190,190,${alpha})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${alpha * 0.45})`;
        ctx.beginPath();
        ctx.arc(px - r * 0.25, py - r * 0.25, r * 0.45, 0, TAU);
        ctx.fill();
      }
    }

    // spinning armor shards (kind 3 = warm wood/kilt scrap, used by Giant)
    if (d.shards) {
      for (const sh of d.shards) {
        const r = T * (0.10 + age * sh.speed * 1.6);
        const px = cx + Math.cos(sh.ang) * r;
        const py = cy + Math.sin(sh.ang) * r * 0.7 + age * age * T * 0.6;
        const rot = sh.rot0 + sh.spin * age;
        const alpha = t;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(rot);
        if (d.cannon) {
          // Cannon-specific shards: broken oak planks with iron banding,
          // bent iron strap fragments, and small bright-brass bits (ring
          // shards from the barrel reinforcement bands).
          ctx.strokeStyle = `rgba(0,0,0,${0.85 * alpha})`;
          ctx.lineWidth = 1.1 * psc;
          if (sh.kind === 0) {
            // Broken oak plank with a dark grain stripe + scorched corner.
            ctx.fillStyle = `rgba(122,74,35,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.rect(-T * 0.14, -T * 0.045, T * 0.28, T * 0.090);
            ctx.fill(); ctx.stroke();
            // dark grain
            ctx.fillStyle = `rgba(74,43,20,${0.85 * alpha})`;
            ctx.fillRect(-T * 0.14, -T * 0.005, T * 0.28, T * 0.012);
            // scorched corner
            ctx.fillStyle = `rgba(10,10,10,${0.85 * alpha})`;
            ctx.fillRect(T * 0.08, -T * 0.045, T * 0.06, T * 0.090);
            // small iron rivet
            ctx.fillStyle = `rgba(207,211,218,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.arc(-T * 0.08, 0, T * 0.020, 0, TAU);
            ctx.fill();
          } else if (sh.kind === 1) {
            // Bent iron strap — dark elongated quad with a brushed steel
            // catch highlight along the top edge.
            ctx.fillStyle = `rgba(58,63,72,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.16, -T * 0.030);
            ctx.lineTo(T * 0.10, -T * 0.045);
            ctx.lineTo(T * 0.16, T * 0.020);
            ctx.lineTo(-T * 0.10, T * 0.040);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            // steel highlight along the leading edge
            ctx.strokeStyle = `rgba(207,211,218,${0.85 * alpha})`;
            ctx.lineWidth = 1.4 * psc;
            ctx.beginPath();
            ctx.moveTo(-T * 0.15, -T * 0.024);
            ctx.lineTo(T * 0.09, -T * 0.038);
            ctx.stroke();
          } else {
            // Brass ring shard — small curved chunk in warm gold.
            ctx.fillStyle = `rgba(201,145,42,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.10, -T * 0.020);
            ctx.quadraticCurveTo(0, -T * 0.060, T * 0.10, -T * 0.020);
            ctx.lineTo(T * 0.10, T * 0.020);
            ctx.quadraticCurveTo(0, -T * 0.018, -T * 0.10, T * 0.020);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            // bright catch on top
            ctx.fillStyle = `rgba(255,216,122,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.07, -T * 0.018);
            ctx.quadraticCurveTo(0, -T * 0.045, T * 0.07, -T * 0.018);
            ctx.lineTo(T * 0.05, -T * 0.005);
            ctx.quadraticCurveTo(0, -T * 0.030, -T * 0.05, -T * 0.005);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          continue;
        }
        if (d.musketeer) {
          // Musketeer-specific shards: torn teal coat scraps with a light-
          // blue trim band, white/gray gunpowder smoke puffs, brass-gold
          // buttons with a tiny catchlight, and broken dark-navy musket
          // pieces with gold trim bands and a sky-blue stock highlight.
          ctx.strokeStyle = `rgba(2,48,71,${0.90 * alpha})`;
          ctx.lineWidth = 1.0 * psc;
          if (sh.kind === 0) {
            // Teal coat scrap with a light-blue trim band along one edge.
            ctx.fillStyle = `rgba(33,158,188,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.11, -T * 0.05);
            ctx.lineTo(T * 0.10, -T * 0.06);
            ctx.lineTo(T * 0.09, T * 0.05);
            ctx.lineTo(-T * 0.13, T * 0.06);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(142,202,230,${0.85 * alpha})`;
            ctx.fillRect(-T * 0.11, T * 0.03, T * 0.22, T * 0.022);
            // tiny gold button on the scrap
            ctx.fillStyle = `rgba(255,183,3,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.arc(T * 0.00, -T * 0.020, T * 0.020, 0, TAU);
            ctx.fill();
          } else if (sh.kind === 1) {
            // Gunpowder smoke puff — soft gray cloud with a white catch.
            ctx.fillStyle = `rgba(220,220,220,${0.80 * alpha})`;
            ctx.beginPath();
            ctx.arc(0, 0, T * 0.10, 0, TAU);
            ctx.fill();
            ctx.fillStyle = `rgba(180,180,180,${0.70 * alpha})`;
            ctx.beginPath();
            ctx.arc(T * 0.05, T * 0.03, T * 0.06, 0, TAU);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(-T * 0.05, -T * 0.02, T * 0.05, 0, TAU);
            ctx.fill();
            ctx.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
            ctx.beginPath();
            ctx.arc(-T * 0.03, -T * 0.04, T * 0.025, 0, TAU);
            ctx.fill();
          } else if (sh.kind === 2) {
            // Brass-gold button with a navy outline and a bright catch.
            ctx.fillStyle = `rgba(255,183,3,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.arc(0, 0, T * 0.050, 0, TAU);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(251,133,0,${0.85 * alpha})`;
            ctx.fillRect(-T * 0.030, T * 0.005, T * 0.060, T * 0.014);
            ctx.fillStyle = `rgba(255,255,255,${0.90 * alpha})`;
            ctx.beginPath();
            ctx.arc(-T * 0.018, -T * 0.018, T * 0.015, 0, TAU);
            ctx.fill();
          } else {
            // Broken musket piece — dark-navy barrel fragment with a gold
            // trim band at one end and a sky-blue stock highlight.
            ctx.fillStyle = `rgba(2,48,71,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.rect(-T * 0.16, -T * 0.028, T * 0.32, T * 0.056);
            ctx.fill(); ctx.stroke();
            // gold trim band
            ctx.fillStyle = `rgba(255,183,3,${0.95 * alpha})`;
            ctx.fillRect(T * 0.06, -T * 0.028, T * 0.034, T * 0.056);
            // sky-blue highlight stripe
            ctx.fillStyle = `rgba(142,202,230,${0.65 * alpha})`;
            ctx.fillRect(-T * 0.14, -T * 0.022, T * 0.18, T * 0.011);
            // tiny dark bore at the snapped end
            ctx.fillStyle = `rgba(2,26,38,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.arc(-T * 0.14, 0, T * 0.014, 0, TAU);
            ctx.fill();
          }
          ctx.restore();
          continue;
        }
        if (d.minion) {
          // Minion-specific shards: ragged wing-membrane scraps (dark navy
          // with a light-slate leading edge), dark "feather" slivers, small
          // off-white bone fragments, and tiny broken horn flakes.
          ctx.strokeStyle = `rgba(13,27,42,${0.90 * alpha})`;
          ctx.lineWidth = 1.0 * psc;
          if (sh.kind === 0) {
            // Wing-membrane scrap — torn quadrilateral with a slate strut
            // along the leading edge.
            ctx.fillStyle = `rgba(27,38,59,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.13, -T * 0.04);
            ctx.lineTo(T * 0.11, -T * 0.07);
            ctx.lineTo(T * 0.14, T * 0.04);
            ctx.lineTo(-T * 0.05, T * 0.07);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            // light-slate strut along the top edge (visible "finger" bone)
            ctx.strokeStyle = `rgba(119,141,169,${0.90 * alpha})`;
            ctx.lineWidth = 1.4 * psc;
            ctx.beginPath();
            ctx.moveTo(-T * 0.13, -T * 0.04);
            ctx.lineTo(T * 0.11, -T * 0.07);
            ctx.stroke();
            // mid-slate vein
            ctx.strokeStyle = `rgba(65,90,119,${0.70 * alpha})`;
            ctx.lineWidth = 0.7 * psc;
            ctx.beginPath();
            ctx.moveTo(-T * 0.08, -T * 0.02);
            ctx.lineTo(T * 0.08, T * 0.03);
            ctx.stroke();
          } else if (sh.kind === 1) {
            // Dark feather / bat-fur tuft — almond shape with a center spine.
            ctx.fillStyle = `rgba(13,27,42,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.12, 0);
            ctx.quadraticCurveTo(0, -T * 0.06, T * 0.10, 0);
            ctx.quadraticCurveTo(0, T * 0.06, -T * 0.12, 0);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.strokeStyle = `rgba(65,90,119,${0.80 * alpha})`;
            ctx.lineWidth = 0.8 * psc;
            ctx.beginPath();
            ctx.moveTo(-T * 0.10, 0);
            ctx.lineTo(T * 0.08, 0);
            ctx.stroke();
          } else if (sh.kind === 2) {
            // Off-white bone sliver — a small angular spike with a dark
            // shadow side and a bright catch on top.
            ctx.fillStyle = `rgba(224,225,221,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.11, -T * 0.025);
            ctx.lineTo(T * 0.12, -T * 0.018);
            ctx.lineTo(T * 0.14, T * 0.012);
            ctx.lineTo(-T * 0.10, T * 0.030);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(65,90,119,${0.55 * alpha})`;
            ctx.fillRect(-T * 0.10, T * 0.008, T * 0.22, T * 0.018);
          } else {
            // Broken horn flake — a small dark-navy curving wedge with a
            // light-slate highlight along the convex edge.
            ctx.fillStyle = `rgba(27,38,59,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.10, T * 0.04);
            ctx.quadraticCurveTo(-T * 0.02, -T * 0.08, T * 0.12, -T * 0.02);
            ctx.lineTo(T * 0.10, T * 0.02);
            ctx.quadraticCurveTo(-T * 0.02, -T * 0.02, -T * 0.08, T * 0.05);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.strokeStyle = `rgba(119,141,169,${0.90 * alpha})`;
            ctx.lineWidth = 0.9 * psc;
            ctx.beginPath();
            ctx.moveTo(-T * 0.06, -T * 0.01);
            ctx.quadraticCurveTo(0, -T * 0.05, T * 0.08, -T * 0.02);
            ctx.stroke();
            // tiny off-white shine dot
            ctx.fillStyle = `rgba(224,225,221,${0.85 * alpha})`;
            ctx.beginPath();
            ctx.arc(T * 0.02, -T * 0.04, T * 0.018, 0, TAU);
            ctx.fill();
          }
          ctx.restore();
          continue;
        }
        if (d.goblin) {
          // Goblin-specific shards: torn cream sack-cloth, green skin chunks,
          // red bandana shreds and tiny snapped-dagger slivers.
          ctx.strokeStyle = `rgba(56,102,65,${0.90 * alpha})`;
          ctx.lineWidth = 1.0 * psc;
          if (sh.kind === 0) {
            ctx.fillStyle = `rgba(242,232,207,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.10, -T * 0.04);
            ctx.lineTo(T * 0.08, -T * 0.05);
            ctx.lineTo(T * 0.10, T * 0.05);
            ctx.lineTo(-T * 0.08, T * 0.05);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(56,102,65,${0.55 * alpha})`;
            ctx.fillRect(-T * 0.08, T * 0.02, T * 0.16, T * 0.020);
          } else if (sh.kind === 1) {
            ctx.fillStyle = `rgba(106,153,78,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.arc(0, 0, T * 0.075, 0, TAU);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(167,201,87,${0.90 * alpha})`;
            ctx.beginPath();
            ctx.arc(-T * 0.020, -T * 0.020, T * 0.030, 0, TAU);
            ctx.fill();
          } else if (sh.kind === 2) {
            ctx.fillStyle = `rgba(188,71,73,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.12, -T * 0.025);
            ctx.lineTo(T * 0.12, -T * 0.030);
            ctx.lineTo(T * 0.10, T * 0.030);
            ctx.lineTo(-T * 0.12, T * 0.025);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          } else {
            ctx.fillStyle = `rgba(242,232,207,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.05, -T * 0.022);
            ctx.lineTo(T * 0.12, -T * 0.008);
            ctx.lineTo(T * 0.16, 0);
            ctx.lineTo(T * 0.12, T * 0.008);
            ctx.lineTo(-T * 0.05, T * 0.022);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(56,102,65,${0.95 * alpha})`;
            ctx.fillRect(-T * 0.09, -T * 0.030, T * 0.05, T * 0.060);
            ctx.fillStyle = `rgba(188,71,73,${0.85 * alpha})`;
            ctx.beginPath();
            ctx.arc(T * 0.14, 0, T * 0.022, 0, TAU);
            ctx.fill();
          }
          ctx.restore();
          continue;
        }
        if (d.archer) {
          // Archer-specific shards: mint cloth scraps, dark-teal hood
          // fragments, snapped arrow shafts, and loose fletching feathers.
          ctx.strokeStyle = `rgba(10,44,47,${0.85 * alpha})`;
          ctx.lineWidth = 1.1 * psc;
          if (sh.kind === 0) {
            // mint cloak scrap
            ctx.fillStyle = `rgba(131,197,190,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.10, -T * 0.05);
            ctx.lineTo(T * 0.10, -T * 0.06);
            ctx.lineTo(T * 0.08, T * 0.05);
            ctx.lineTo(-T * 0.12, T * 0.06);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(0,109,119,${0.85 * alpha})`;
            ctx.fillRect(-T * 0.10, T * 0.03, T * 0.20, T * 0.025);
          } else if (sh.kind === 1) {
            // dark teal hood fragment
            ctx.fillStyle = `rgba(0,109,119,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.09, -T * 0.04);
            ctx.lineTo(T * 0.10, -T * 0.05);
            ctx.lineTo(0, T * 0.08);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          } else if (sh.kind === 2) {
            // snapped arrow shaft + tiny steel head
            ctx.fillStyle = `rgba(226,149,120,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.rect(-T * 0.14, -T * 0.020, T * 0.24, T * 0.040);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(154,160,173,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(T * 0.10, -T * 0.035);
            ctx.lineTo(T * 0.16, 0);
            ctx.lineTo(T * 0.10, T * 0.035);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          } else {
            // loose fletching feather (cream with red tip)
            ctx.fillStyle = `rgba(237,246,249,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(-T * 0.12, 0);
            ctx.quadraticCurveTo(0, -T * 0.07, T * 0.10, 0);
            ctx.quadraticCurveTo(0, T * 0.07, -T * 0.12, 0);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = `rgba(188,71,73,${0.95 * alpha})`;
            ctx.beginPath();
            ctx.moveTo(T * 0.04, -T * 0.04);
            ctx.lineTo(T * 0.12, 0);
            ctx.lineTo(T * 0.04, T * 0.04);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          continue;
        }
        ctx.fillStyle = `rgba(229,229,229,${0.9 * alpha})`;
        ctx.strokeStyle = `rgba(0,0,0,${0.85 * alpha})`;
        ctx.lineWidth = 1.4 * psc;
        if (sh.kind === 0) {
          ctx.beginPath();
          ctx.rect(-T * 0.10, -T * 0.06, T * 0.20, T * 0.12);
          ctx.fill(); ctx.stroke();
        } else if (sh.kind === 1) {
          ctx.beginPath();
          ctx.rect(-T * 0.08, -T * 0.03, T * 0.16, T * 0.06);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = `rgba(252,163,17,${0.95 * alpha})`;
          ctx.beginPath();
          ctx.arc(0, 0, T * 0.035, 0, TAU);
          ctx.fill();
        } else if (sh.kind === 2) {
          ctx.beginPath();
          ctx.moveTo(-T * 0.10, T * 0.07);
          ctx.lineTo(T * 0.10, T * 0.05);
          ctx.lineTo(0, -T * 0.09);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
        } else {
          // Wood/kilt scrap — warm-toned plank with a crimson sliver.
          ctx.fillStyle = `rgba(247,127,0,${0.95 * alpha})`;
          ctx.beginPath();
          ctx.rect(-T * 0.12, -T * 0.05, T * 0.24, T * 0.10);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = `rgba(214,40,40,${0.90 * alpha})`;
          ctx.beginPath();
          ctx.rect(-T * 0.05, -T * 0.04, T * 0.10, T * 0.08);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // gold glint sparkles
    ctx.fillStyle = `rgba(253,216,122,${0.85 * t})`;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + age * 1.6;
      const r = T * (0.35 + age * 0.7);
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r * 0.7;
      const sz = T * 0.045 * (1 - age * 0.5);
      ctx.beginPath();
      ctx.moveTo(px - sz, py); ctx.lineTo(px, py - sz);
      ctx.lineTo(px + sz, py); ctx.lineTo(px, py + sz);
      ctx.closePath();
      ctx.fill();
    }

    // bright central flash at the start
    if (t > 0.6) {
      const f = (t - 0.6) / 0.4;
      ctx.fillStyle = `rgba(255,255,255,${0.6 * f})`;
      ctx.beginPath();
      ctx.arc(cx, cy, T * 0.4 * f, 0, TAU);
      ctx.fill();
    }
  }
}

// Roaring spinning meteor — in-flight Fireball spell projectile travelling from
// the caster's King tower toward the aim point. (x,y) is the projectile's
// screen-space position; `ang` is the screen-space travel angle (local +x is
// "forward"); `t` is a wall-clock seconds accumulator driving the petal spin,
// spark twinkle and trail wobble. Anatomy, back-to-front (smoke first, then a
// single additive block for everything bright):
//   smoke trail   — 5 dark-gray puffs trailing along -x (NON-additive, so the
//                   gray reads as gray instead of being erased by 'lighter')
//   flame trail   — 4 fading yellow→orange puffs hugging the ball's wake
//   flame petals  — 6 rotating "tongues" radiating outward, base #ff8800 →
//                   transparent tip
//   body          — radial gradient #ffd000 core → #ff7b00 edge
//   inner ball    — bright #ffea00 → #ffdd00
//   white-hot     — pure-white pinpoint with a pale-yellow halo
//   sparks        — 5 twinkling white+yellow dots on slow orbits
// All eight palette colors below are sampled across the layers.
export function drawFireballProjectile(ctx, x, y, ang, tile, t, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;

  // ── 10-color YELLOW→ORANGE Fireball palette (rgb tuples for rgba use) ──
  const C_FF7B00 = '255,123,0';   // deepest orange — outermost flame, trail tail
  const C_FF8800 = '255,136,0';   // petal base
  const C_FF9500 = '255,149,0';   // mid flame outer body
  const C_FFA200 = '255,162,0';   // body gradient mid
  const C_FFAA00 = '255,170,0';   // mid flame body
  const C_FFB700 = '255,183,0';   // body gradient inner ring
  const C_FFC300 = '255,195,0';   // bright body
  const C_FFD000 = '255,208,0';   // hot body
  const C_FFDD00 = '255,221,0';   // bright trail puffs
  const C_FFEA00 = '255,234,0';   // hottest gold — inner ball + sparks
  // Pure white pinpoint + dark-gray smoke
  const C_WHITE  = '255,255,255';
  const C_SMOKE  = '26,26,26';    // ~#1a1a1a

  const T = t || 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ── SMOKE TRAIL (non-additive, drawn first so it sits behind the flames) ──
  // Dark gray puffs trailing well behind the ball along local -x. Each puff
  // is bigger and more faded the further back it sits, with a tiny sinusoidal
  // wobble driven by t (the trail "breathes" as the meteor flies).
  for (let i = 1; i <= 5; i++) {
    const dx = -tile * (0.55 + i * 0.34);
    const dy = Math.sin(T * 7 + i * 1.3) * tile * 0.055;
    const r  = tile * (0.10 + i * 0.052);
    ctx.fillStyle = `rgba(${C_SMOKE},${(0.26 / Math.sqrt(i)) * alpha})`;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, TAU);
    ctx.fill();
  }

  // ── ADDITIVE BLOOM (every bright layer below uses 'lighter') ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // FLAME TRAIL PUFFS — closer = brighter gold, further = deep orange. They
  // sit slightly outside the smoke, in the gap between smoke and the ball.
  const trailCols = [C_FFDD00, C_FFC300, C_FFAA00, C_FF7B00];
  for (let i = 1; i <= 4; i++) {
    const dx = -tile * (0.20 + i * 0.20);
    const dy = Math.sin(T * 13 - i * 0.9) * tile * 0.035;
    const fade = 1 - (i - 1) / 4.2;
    const r = tile * (0.22 - i * 0.030);
    ctx.fillStyle = `rgba(${trailCols[i - 1]},${0.65 * fade * alpha})`;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, TAU);
    ctx.fill();
  }

  // OUTER FLAME PETALS — 6 rotating wispy tongues radiating from the core,
  // each shaped like a leaf with a saturated base and transparent tip. The
  // whole crown spins continuously, and individual petals "breathe" in/out
  // slightly out of phase with each other so the silhouette looks alive.
  const R0 = tile * 0.32;             // outer flame ring radius
  const nPet = 6;
  const rot = T * 4.5;                // continuous spin
  for (let i = 0; i < nPet; i++) {
    const a = (i / nPet) * TAU + rot;
    const breathe = 1 + 0.18 * Math.sin(T * 6 + i * 1.4);
    const len = R0 * 1.05 * breathe;
    const wid = R0 * 0.58;
    ctx.save();
    ctx.rotate(a);
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0.0, `rgba(${C_FF8800},${0.80 * alpha})`);
    grad.addColorStop(0.45, `rgba(${C_FF9500},${0.55 * alpha})`);
    grad.addColorStop(1.0, `rgba(${C_FF7B00},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, -wid * 0.5);
    ctx.quadraticCurveTo(len * 0.55, -wid * 0.22, len, 0);
    ctx.quadraticCurveTo(len * 0.55, wid * 0.22, 0, wid * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ORANGE FLAME LAYERS — soft radial body bridging petals to inner ball.
  const bodyGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, R0 * 1.15);
  bodyGrad.addColorStop(0.00, `rgba(${C_FFD000},${0.85 * alpha})`);
  bodyGrad.addColorStop(0.30, `rgba(${C_FFB700},${0.70 * alpha})`);
  bodyGrad.addColorStop(0.60, `rgba(${C_FFA200},${0.40 * alpha})`);
  bodyGrad.addColorStop(0.85, `rgba(${C_FF9500},${0.18 * alpha})`);
  bodyGrad.addColorStop(1.00, `rgba(${C_FF7B00},0)`);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(0, 0, R0 * 1.15, 0, TAU);
  ctx.fill();

  // BRIGHT YELLOW INNER BALL — solid hot core just inside the white pinpoint.
  const R1 = tile * 0.16;
  const innerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, R1);
  innerGrad.addColorStop(0.0, `rgba(${C_FFEA00},${alpha})`);
  innerGrad.addColorStop(0.6, `rgba(${C_FFDD00},${0.92 * alpha})`);
  innerGrad.addColorStop(1.0, `rgba(${C_FFAA00},${0.40 * alpha})`);
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(0, 0, R1, 0, TAU);
  ctx.fill();

  // WHITE-HOT PINPOINT — tiny pure-white nucleus with a yellow halo.
  const R2 = tile * 0.08;
  ctx.fillStyle = `rgba(${C_FFEA00},${0.80 * alpha})`;
  ctx.beginPath();
  ctx.arc(0, 0, R2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(${C_WHITE},${alpha})`;
  ctx.beginPath();
  ctx.arc(0, 0, R2 * 0.65, 0, TAU);
  ctx.fill();

  // SPARKS — 5 twinkling pinpricks on offset orbits, white core + yellow
  // halo, sized + alpha-modulated by an out-of-phase twinkle.
  const nS = 5;
  for (let i = 0; i < nS; i++) {
    const a = (i / nS) * TAU + T * (2.6 + i * 0.55);
    const orbit = tile * (0.21 + 0.05 * Math.sin(T * 8.5 + i * 1.7));
    const sxk = Math.cos(a) * orbit;
    const syk = Math.sin(a) * orbit;
    const twk = 0.45 + 0.55 * Math.sin(T * 11 + i * 2.1);
    const sr  = tile * 0.024 * (0.7 + twk * 0.7);
    ctx.fillStyle = `rgba(${C_FFEA00},${0.55 * twk * alpha})`;
    ctx.beginPath();
    ctx.arc(sxk, syk, sr * 1.9, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(${C_WHITE},${0.95 * twk * alpha})`;
    ctx.beginPath();
    ctx.arc(sxk, syk, sr, 0, TAU);
    ctx.fill();
  }

  ctx.restore(); // end additive bloom
  ctx.restore(); // end transform
}

// Massive blooming explosion — ground impact for the Fireball spell. Called
// every frame the effect is alive, with `age` going from 0 (just landed) to 1
// (vanished, ttl 0.35s). `radius` is the spell's world-space AoE radius (so
// `R = radius * tile` is the impact disk in screen pixels), `t` is a
// wall-clock seconds accumulator for the dust billow / petal flutter.
// Anatomy, drawn back-to-front:
//   ground scorch — faint dark elliptical mark, lingers longest, NON-additive
//   dust cloud    — gray billow rising + spreading, NON-additive (low alpha)
//   ADDITIVE block:
//     heat halo   — soft warm bloom around the whole impact
//     shockwave   — gold ring expanding past R and fading
//     petals      — 8 long flame tongues bursting radially, peak mid-life
//     body        — orange-yellow disk at the impact center
//     flash       — instant white-hot disk that flares + shrinks
//     embers      — 16 sparks flying outward, decelerating + falling
// Devastating for the full 0.35s ttl, then collapses leaving the scorch.
export function drawFireballImpact(ctx, x, y, tile, age, radius, t, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;
  age = clamp01(age);
  const R = radius * tile;
  const T = t || 0;

  // ── 10-color YELLOW→ORANGE Fireball palette (rgb tuples) ──
  const C_FF7B00 = '255,123,0';
  const C_FF8800 = '255,136,0';
  const C_FF9500 = '255,149,0';
  const C_FFA200 = '255,162,0';
  const C_FFAA00 = '255,170,0';
  const C_FFB700 = '255,183,0';
  const C_FFC300 = '255,195,0';
  const C_FFD000 = '255,208,0';
  const C_FFDD00 = '255,221,0';
  const C_FFEA00 = '255,234,0';
  const C_WHITE  = '255,255,255';
  const C_SMOKE  = '26,26,26';

  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ── GROUND SCORCH (NON-additive, lingers, sits slightly south of center) ──
  // Dark elliptical mark — black core fading through deep orange edge. Stays
  // visible the entire ttl with a slow alpha falloff.
  {
    const a = (0.55 - 0.30 * age) * alpha;
    if (a > 0.001) {
      const cy0 = R * 0.12;
      const grad = ctx.createRadialGradient(0, cy0, 0, 0, cy0, R * 1.05);
      grad.addColorStop(0.0, `rgba(8,4,0,${a})`);
      grad.addColorStop(0.55, `rgba(35,18,4,${a * 0.55})`);
      grad.addColorStop(1.0, `rgba(${C_FF7B00},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, cy0, R * 1.00, R * 0.55, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ── RISING DUST CLOUD (NON-additive, low alpha gray, billowing up + out) ──
  // Central dome rises + grows, plus 7 satellite billows orbiting around it.
  {
    const dustA = (1 - age) * 0.50 * alpha;
    if (dustA > 0.002) {
      const rise = -R * 0.28 * easeOut(age);
      const dustR = R * (0.85 + 0.65 * easeOut(age));
      const dGrad = ctx.createRadialGradient(0, rise, R * 0.15, 0, rise, dustR);
      dGrad.addColorStop(0.0, `rgba(78,62,55,${dustA * 0.95})`);
      dGrad.addColorStop(0.55, `rgba(48,40,36,${dustA * 0.55})`);
      dGrad.addColorStop(1.0, `rgba(${C_SMOKE},0)`);
      ctx.fillStyle = dGrad;
      ctx.beginPath();
      ctx.ellipse(0, rise, dustR, dustR * 0.72, 0, 0, TAU);
      ctx.fill();

      const nB = 7;
      for (let i = 0; i < nB; i++) {
        const a = (i / nB) * TAU + T * 0.5 + i * 0.27;
        const wob = 1 + 0.22 * Math.sin(T * 2.2 + i * 1.3);
        const ringR = R * (0.55 + 0.30 * easeOut(age)) * wob;
        const bx = Math.cos(a) * ringR;
        const by = Math.sin(a) * ringR * 0.55 + rise * 0.6;
        const br = R * (0.18 + 0.10 * Math.sin(T * 3 + i * 1.7))
                     * (0.75 + 0.55 * easeOut(age));
        ctx.fillStyle = `rgba(55,46,40,${dustA * 0.45})`;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, TAU);
        ctx.fill();
        // hint of underglow on the lower side of each billow
        if (by > rise * 0.5) {
          ctx.fillStyle = `rgba(${C_FF7B00},${dustA * 0.18})`;
          ctx.beginPath();
          ctx.arc(bx, by + br * 0.25, br * 0.55, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  // ── ADDITIVE BLOOM (every bright layer below uses 'lighter') ──
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // HEAT GLOW HALO — wide, soft warm bloom around the whole impact area.
  {
    const haloA = (1 - age * 0.85) * 0.55 * alpha;
    if (haloA > 0.002) {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.7);
      grad.addColorStop(0.0, `rgba(${C_FFAA00},${haloA})`);
      grad.addColorStop(0.55, `rgba(${C_FF8800},${haloA * 0.45})`);
      grad.addColorStop(1.0, `rgba(${C_FF7B00},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.7, 0, TAU);
      ctx.fill();
    }
  }

  // SHOCKWAVE — expanding gold ring (two bands, outer wider, inner brighter).
  {
    const ringT = easeOut(age);
    const ringR = R * (0.38 + 1.15 * ringT);
    const ringW = R * 0.18 * (1 - age * 0.65);
    const ringA = (1 - age) * 0.85 * alpha;
    if (ringA > 0.01 && ringW > 0.6) {
      ctx.strokeStyle = `rgba(${C_FFC300},${ringA})`;
      ctx.lineWidth = ringW;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${C_FFEA00},${ringA * 0.75})`;
      ctx.lineWidth = ringW * 0.40;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, TAU);
      ctx.stroke();
    }
  }

  // FLAME PETALS — 8 long radial tongues; grow fast, peak mid-life, collapse.
  // Each petal is a yellow-core → orange-tip leaf shape, rotated to its
  // radial angle. Slight per-petal stagger so the bloom looks organic.
  {
    const grow = age < 0.32 ? easeOut(age / 0.32)
                            : 1 - easeInOut((age - 0.32) / 0.68);
    const nP = 8;
    for (let i = 0; i < nP; i++) {
      const a = (i / nP) * TAU + Math.sin(i * 1.3) * 0.18;
      const flut = 0.88 + 0.18 * Math.sin(T * 6 + i * 1.7);
      const len = R * (0.55 + 0.55 * grow) * flut;
      const wid = R * 0.36 * grow;
      if (len < 1 || wid < 1) continue;
      ctx.save();
      ctx.rotate(a);
      const grad = ctx.createLinearGradient(0, 0, len, 0);
      grad.addColorStop(0.0, `rgba(${C_FFEA00},${0.85 * alpha})`);
      grad.addColorStop(0.30, `rgba(${C_FFB700},${0.65 * alpha})`);
      grad.addColorStop(0.65, `rgba(${C_FF8800},${0.40 * alpha})`);
      grad.addColorStop(1.0, `rgba(${C_FF7B00},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, -wid * 0.50);
      ctx.quadraticCurveTo(len * 0.55, -wid * 0.32, len, 0);
      ctx.quadraticCurveTo(len * 0.55, wid * 0.32, 0, wid * 0.50);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // ORANGE FIREBALL BODY — radial gold→orange disk filling the impact zone.
  {
    const bodyT = age < 0.18 ? 1 : Math.max(0, 1 - (age - 0.18) * 1.45);
    if (bodyT > 0.01) {
      const bodyR = R * (0.55 + 0.25 * (1 - age));
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, bodyR);
      grad.addColorStop(0.0, `rgba(${C_FFEA00},${bodyT * alpha})`);
      grad.addColorStop(0.30, `rgba(${C_FFD000},${0.90 * bodyT * alpha})`);
      grad.addColorStop(0.60, `rgba(${C_FFA200},${0.55 * bodyT * alpha})`);
      grad.addColorStop(1.0, `rgba(${C_FF7B00},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, bodyR, 0, TAU);
      ctx.fill();
    }
  }

  // WHITE-HOT FLASH — instant flare that peaks at age ~0.05 and shrinks fast.
  {
    const flashT = age < 0.05
      ? lerp(0.6, 1, age / 0.05)
      : Math.max(0, 1 - (age - 0.05) * 7.5);
    if (flashT > 0.01) {
      const flashR = R * (0.45 + 0.55 * (1 - Math.min(1, age * 3)));
      if (flashR > 0.5) {
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, flashR);
        grad.addColorStop(0.0, `rgba(${C_WHITE},${flashT * alpha})`);
        grad.addColorStop(0.55, `rgba(255,250,180,${0.65 * flashT * alpha})`);
        grad.addColorStop(1.0, `rgba(${C_FFEA00},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, flashR, 0, TAU);
        ctx.fill();
      }
    }
  }

  // EMBERS — 16 sparks flying outward in random directions, decelerating
  // outward (1 - (1-age)^2 shape) and sagging slightly downward (gravity).
  // Bright white-yellow near the start, fading to orange as they cool.
  {
    const emberA = (1 - age) * alpha;
    if (emberA > 0.01) {
      const nE = 16;
      for (let i = 0; i < nE; i++) {
        const a = (i / nE) * TAU + Math.sin(i * 3.7) * 0.35;
        const sp = 0.70 + ((i * 7919) % 100) / 100 * 0.55;
        const dist = sp * R * easeOut(age) * 1.18;
        const ex = Math.cos(a) * dist;
        const ey = Math.sin(a) * dist * 0.85 + R * 0.42 * age * age;
        const er = tile * 0.045 * (1 - age * 0.55);
        if (er < 0.4) continue;
        // color cools white → yellow → orange
        const mix = 1 - age;
        const g = Math.floor(lerp(170, 250, mix));
        const b = Math.floor(lerp(0, 200, mix));
        // short tail behind the ember
        const trX = ex - Math.cos(a) * tile * 0.13 * (1 - age);
        const trY = ey - Math.sin(a) * tile * 0.11 * (1 - age);
        ctx.fillStyle = `rgba(${C_FFC300},${emberA * 0.55})`;
        ctx.beginPath();
        ctx.arc(trX, trY, er * 0.62, 0, TAU);
        ctx.fill();
        // head
        ctx.fillStyle = `rgba(255,${g},${b},${emberA})`;
        ctx.beginPath();
        ctx.arc(ex, ey, er, 0, TAU);
        ctx.fill();
        // hot pinpoint at center of head while still bright
        if (mix > 0.5) {
          ctx.fillStyle = `rgba(${C_WHITE},${emberA * 0.9})`;
          ctx.beginPath();
          ctx.arc(ex, ey, er * 0.45, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  ctx.restore(); // end additive bloom
  ctx.restore(); // end transform
}

// Internal helper used by both Arrows-spell renderers below. Draws a single
// arrow at the local origin, pointing along +x, total length `len`. The caller
// is responsible for save / translate / rotate. Uses the Arrows-spell palette
// only (P = { C_RED, C_WHITE, C_LIGHT, C_MID, C_DARK } as rgb tuples). Kept
// flat / non-additive so it reads as a physical projectile, not energy.
function _drawArrowsSpellArrow(ctx, len, alpha, P) {
  const W    = len * 0.085;      // shaft thickness
  const tipL = len * 0.22;       // head length along shaft
  const tipW = len * 0.15;       // head base width
  const fX   = -len * 0.5;       // butt end (fletching anchor)
  const flL  = len * 0.24;       // feather length
  const flW  = len * 0.17;       // feather spread

  // Shaft — mid-blue body, dark-navy underside cel-shade, light-blue top hi.
  ctx.fillStyle = `rgba(${P.C_MID},${alpha})`;
  ctx.fillRect(fX, -W * 0.5, len, W);
  ctx.fillStyle = `rgba(${P.C_DARK},${0.92 * alpha})`;
  ctx.fillRect(fX, W * 0.05, len, W * 0.45);
  ctx.fillStyle = `rgba(${P.C_LIGHT},${0.85 * alpha})`;
  ctx.fillRect(fX, -W * 0.46, len, W * 0.18);

  // Iron arrowhead — dark-navy triangle with a near-white highlight on the
  // upper edge (so the head reads as polished steel rather than a flat shape).
  const tipBase = len * 0.5 - tipL;
  const tipTip  = len * 0.5 + len * 0.07;
  ctx.fillStyle = `rgba(${P.C_DARK},${alpha})`;
  ctx.beginPath();
  ctx.moveTo(tipBase, -tipW * 0.5);
  ctx.lineTo(tipTip, 0);
  ctx.lineTo(tipBase, tipW * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(${P.C_WHITE},${0.85 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(tipBase + len * 0.012, -tipW * 0.40);
  ctx.lineTo(tipTip  - len * 0.035, -tipW * 0.06);
  ctx.lineTo(tipBase + tipL * 0.55, -tipW * 0.15);
  ctx.closePath();
  ctx.fill();

  // Fletching — top near-white feather, tiny mid-blue inner sliver (sells the
  // 3-feather profile from the side), bottom bold-red feather.
  ctx.fillStyle = `rgba(${P.C_WHITE},${alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + len * 0.05, -W * 0.30);
  ctx.lineTo(fX - flL,        -flW * 0.55);
  ctx.lineTo(fX - flL * 0.20, -flW * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(${P.C_MID},${0.95 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + len * 0.04, 0);
  ctx.lineTo(fX - flL * 0.85, 0);
  ctx.lineTo(fX - flL * 0.25, W * 0.20);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `rgba(${P.C_RED},${alpha})`;
  ctx.beginPath();
  ctx.moveTo(fX + len * 0.05, W * 0.30);
  ctx.lineTo(fX - flL,        flW * 0.55);
  ctx.lineTo(fX - flL * 0.20, flW * 0.05);
  ctx.closePath();
  ctx.fill();

  // Tiny dark socket where the head meets the shaft.
  ctx.fillStyle = `rgba(${P.C_DARK},${0.85 * alpha})`;
  ctx.fillRect(tipBase - len * 0.015, -W * 0.55, len * 0.03, W * 1.10);
}

// Tight wedge-bundle of arrows — in-flight Arrows spell projectile travelling
// from the caster's King tower toward the aim point. (x,y) is the screen
// position; `ang` is the screen-space travel direction (local +x = forward);
// `t` is a wall-clock seconds accumulator that drives the cluster's lateral
// wobble and the motion-streak breathing. Anatomy, back-to-front:
//   motion blur — 5 semi-transparent near-white tapering streaks fanning
//                 behind the cluster (non-additive — this is a physical
//                 payload, not an energy spell)
//   arrow wedge — 7 individual arrows arranged in a tight diamond/wedge:
//                 1 leading + 2 mid + 2 back + 2 tail, lateral offsets
//                 chosen so the leading edge tightens and the trailing
//                 edge fans out slightly. Each arrow has a small per-arrow
//                 rotation jitter and a t-driven lateral wobble so the
//                 bundle doesn't look like a rigid stamp.
// All arrows use the shared 5-color Arrows palette via _drawArrowsSpellArrow.
export function drawArrowsProjectile(ctx, x, y, ang, tile, t, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;

  // ── 5-color Arrows palette (rgb tuples for rgba use) ──
  const C_RED   = '230,57,70';      // #e63946 bold red fletching tips
  const C_WHITE = '241,250,238';    // #f1faee highlights, motion blur
  const C_LIGHT = '168,218,220';    // #a8dadc shaft highlight, sky tint
  const C_MID   = '69,123,157';     // #457b9d shaft mid-tone
  const C_DARK  = '29,53,87';       // #1d3557 shaft shadow, iron + outlines
  const P = { C_RED, C_WHITE, C_LIGHT, C_MID, C_DARK };

  const T = t || 0;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // ── MOTION-BLUR STREAKS (drawn first so arrows sit on top) ──
  // 5 tapering near-white wedges fanning behind the cluster along local -x.
  // Outer streaks are dimmer; tail length breathes slightly with T so the
  // trail looks alive without distracting from the arrows themselves.
  const tailL = tile * 1.35;
  const fanY  = tile * 0.50;
  for (let i = 0; i < 5; i++) {
    const off  = (i / 4 - 0.5) * fanY;
    const a    = 0.30 * (1 - Math.abs(i - 2) / 2 * 0.55);
    const tail = tailL * (0.85 + Math.sin(T * 6 + i * 1.7) * 0.10);
    const x0   = -tile * 0.30 - tail;
    const x1   = -tile * 0.30;
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, `rgba(${C_WHITE},0)`);
    grad.addColorStop(1, `rgba(${C_WHITE},${a * alpha})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0, off - tile * 0.020);
    ctx.lineTo(x1, off - tile * 0.060);
    ctx.lineTo(x1, off + tile * 0.060);
    ctx.lineTo(x0, off + tile * 0.020);
    ctx.closePath();
    ctx.fill();
  }

  // ── ARROW WEDGE (7 arrows; leading edge tight, trailing edge fanned) ──
  // Specs are normalized to `tile`: fx = forward offset (negative = behind
  // the leading tip), ly = lateral offset (perpendicular to travel), rot =
  // small per-arrow tilt. Indices 0..6 are increasingly trailing.
  const arrowL = tile * 0.62;
  const specs  = [
    { fx:  0.00, ly:  0.00, rot:  0.00 },   // leading tip
    { fx: -0.20, ly: -0.18, rot: -0.04 },   // mid-left
    { fx: -0.20, ly:  0.18, rot:  0.04 },   // mid-right
    { fx: -0.40, ly: -0.34, rot: -0.07 },   // back-left
    { fx: -0.40, ly:  0.34, rot:  0.07 },   // back-right
    { fx: -0.58, ly: -0.16, rot: -0.02 },   // tail-left
    { fx: -0.58, ly:  0.16, rot:  0.02 },   // tail-right
  ];
  for (let i = 0; i < specs.length; i++) {
    const s   = specs[i];
    const wob = Math.sin(T * 11 + i * 1.9) * tile * 0.020;
    ctx.save();
    ctx.translate(s.fx * tile, s.ly * tile + wob);
    ctx.rotate(s.rot);
    // Subtle alpha falloff toward the trailing arrows so the leading tip
    // reads as the "front" of the bundle.
    const aa = alpha * (1.0 - 0.08 * (i / (specs.length - 1)));
    _drawArrowsSpellArrow(ctx, arrowL, aa, P);
    ctx.restore();
  }

  ctx.restore(); // end transform
}

// Wide rain of arrows — ground impact for the Arrows spell. Called every
// frame the effect is alive, with `age` going from 0 (just landed) to 1
// (vanished, ttl 0.35s). `radius` is the spell's world-space AoE radius
// (R = radius * tile gives the impact disc in screen pixels — 3.5 tiles for
// Arrows, so noticeably wider than the Fireball's 2.5). `t` is a wall-clock
// seconds accumulator (used here only for tiny puff jitter — every arrow's
// POSITION must stay stable across frames so we derive them from a
// deterministic hash of the per-impact screen anchor (x, y, i), which the
// renderer passes unchanged for the entire ttl).
// Anatomy, back-to-front:
//   rain-shadow footprint — faint dark squashed ellipse covering the AoE,
//                           non-additive, fades over the ttl
//   initial impact burst  — at age 0..0.20, a starburst of arrow shapes
//                           radiating from center; sells the "thud"
//   per-arrow strikes     — 32 arrows with stable polar positions inside
//                           the disc. Each has a stable landing time:
//                           below it, the arrow is still falling (drawn
//                           descending nose-first along its own axis with
//                           a soft motion streak); above it, the arrow is
//                           STUCK in the ground (drawn with the iron tip
//                           slightly buried so only the shaft + fletching
//                           pokes up). At the moment of impact a small
//                           gray-tan dust puff blooms and fades.
//   global fade-out       — after age 0.5, everything fades to invisible
//                           by age 1 so the rain doesn't pop off.
export function drawArrowsImpact(ctx, x, y, tile, age, radius, t, opts = {}) {
  const alpha = opts.alpha != null ? opts.alpha : 1;
  age = clamp01(age);
  const R = radius * tile;
  const T = t || 0; // only used for tiny puff size jitter; positions are stable

  // ── 5-color Arrows palette (rgb tuples) ──
  const C_RED   = '230,57,70';
  const C_WHITE = '241,250,238';
  const C_LIGHT = '168,218,220';
  const C_MID   = '69,123,157';
  const C_DARK  = '29,53,87';
  const P = { C_RED, C_WHITE, C_LIGHT, C_MID, C_DARK };

  // Stable per-impact pseudo-random in [0,1) from screen-space anchors and
  // an integer index. The renderer passes the same (x, y) every frame of
  // this impact, so the arrow positions / land times / angles stay locked
  // for the whole 0.35s ttl without any per-effect state being threaded
  // through. Classic shader-style hash; quality is plenty for sub-tile
  // jitter at the scales we draw.
  const rand = (i) => {
    const v = Math.sin(i * 12.9898 + x * 78.233 + y * 31.171) * 43758.5453;
    return v - Math.floor(v);
  };

  // Global fade-out: full alpha for the first half of the ttl, then ramps
  // to zero by age 1 so the rain vanishes cleanly with the effect.
  const globalA = (age < 0.5 ? 1 : Math.max(0, 1 - (age - 0.5) / 0.5)) * alpha;

  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // ── RAIN-SHADOW FOOTPRINT (non-additive, faint dark squashed ellipse) ──
  // Conveys the "wide area is about to get hit" beat for the full ttl,
  // fading along with the effect.
  {
    const sA = (1 - age * 0.80) * 0.22 * alpha;
    if (sA > 0.002) {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      grad.addColorStop(0.0, `rgba(${C_DARK},${sA})`);
      grad.addColorStop(0.7, `rgba(${C_DARK},${sA * 0.45})`);
      grad.addColorStop(1.0, `rgba(${C_DARK},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, R, R * 0.62, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ── INITIAL IMPACT BURST (center, age 0..0.20) ──
  // Short-lived starburst of arrow shapes radiating outward from the
  // center. Each shape's distance from origin grows with easeOut so the
  // burst pops fast then arrests, fading by age 0.20.
  if (age < 0.20) {
    const bAge    = age / 0.20;
    const burstA  = (1 - bAge) * globalA * 0.95;
    const burstL  = tile * 0.40;
    const dist    = R * 0.10 + R * 0.45 * easeOut(bAge);
    const centerD = dist - burstL * 0.5;
    const nB = 10;
    for (let i = 0; i < nB; i++) {
      const a  = (i / nB) * TAU + Math.sin(i * 1.3) * 0.10;
      const ax = Math.cos(a) * centerD;
      const ay = Math.sin(a) * centerD * 0.62; // squashed for ground perspective
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(a);
      _drawArrowsSpellArrow(ctx, burstL, burstA, P);
      ctx.restore();
    }
  }

  // ── INDIVIDUAL ARROW STRIKES (the rain) ──
  // 32 arrows at stable polar positions inside the disc (sqrt of rand for
  // area-uniform density, so the rain doesn't crowd the center). Each
  // arrow has:
  //   - stuckAng : steep down-and-slightly-forward angle ([70°..110°] from
  //                +x). The arrow falls along its OWN axis and ends stuck
  //                at this same angle, so falling→stuck is continuous.
  //   - landT    : per-arrow landing time in [0.04..0.36]. Earlier landings
  //                read as the "first wave" of the rain.
  //   - arrL     : tiny length jitter so the rain doesn't look uniform.
  // The bury offset (arrL * 0.08 along local +x past the impact point) is
  // applied to BOTH the falling and stuck states so there is no pop at
  // the moment of landing.
  const N = 32;
  for (let i = 0; i < N; i++) {
    // Polar position inside the disc (sqrt for uniform density). The ay
    // component is squashed by 0.62 to match the rain-shadow ellipse,
    // selling a top-down ground footprint.
    const ra = rand(i * 2);
    const rb = rand(i * 2 + 1);
    const pa = ra * TAU;
    const pr = Math.sqrt(rb) * R * 0.96;
    const ax = Math.cos(pa) * pr;
    const ay = Math.sin(pa) * pr * 0.62;

    const arrL     = tile * (0.42 + 0.08 * rand(i * 2 + 17));
    const stuckAng = Math.PI * (0.39 + 0.22 * rand(i * 2 + 33));
    const landT    = 0.04 + 0.32 * rand(i * 2 + 51);

    // Tip rest position (slightly buried past the surface so falling→stuck
    // transitions without a jump).
    const buryDx = arrL * 0.08 * Math.cos(stuckAng);
    const buryDy = arrL * 0.08 * Math.sin(stuckAng);
    const restX  = ax + buryDx;
    const restY  = ay + buryDy;

    if (age < landT) {
      // ── STILL FALLING ──
      // Arrow descends along its own axis toward its rest tip position.
      const fAge = age / landT;
      const fall = tile * 1.7;
      const tipX = restX - (1 - fAge) * fall * Math.cos(stuckAng);
      const tipY = restY - (1 - fAge) * fall * Math.sin(stuckAng);
      ctx.save();
      ctx.translate(tipX, tipY);
      ctx.rotate(stuckAng);
      ctx.translate(-arrL * 0.5, 0); // tip ends up at the translate point
      // Soft white motion streak behind the butt (longer at the start of
      // the fall, tapering to nothing as the arrow lands).
      const trailL = tile * 0.65 * (0.40 + 0.60 * (1 - fAge));
      const x0 = -arrL * 0.5 - trailL;
      const x1 = -arrL * 0.5;
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, `rgba(${C_WHITE},0)`);
      grad.addColorStop(1, `rgba(${C_WHITE},${0.55 * globalA})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, -arrL * 0.025);
      ctx.lineTo(x1, -arrL * 0.060);
      ctx.lineTo(x1,  arrL * 0.060);
      ctx.lineTo(x0,  arrL * 0.025);
      ctx.closePath();
      ctx.fill();
      _drawArrowsSpellArrow(ctx, arrL, globalA, P);
      ctx.restore();
    } else {
      // ── STUCK IN GROUND ──
      // Dust puff blooms at landing and fades over ~0.18s. Tiny T-driven
      // size jitter keeps puffs from looking like rubber stamps.
      const puffAge = clamp01((age - landT) / 0.18);
      if (puffAge < 1) {
        const puffA = (1 - puffAge) * 0.45 * globalA;
        const wob   = 1 + 0.10 * Math.sin(T * 8 + i * 1.7);
        const pr0   = tile * 0.10 * (1 + puffAge * 1.6) * wob;
        ctx.fillStyle = `rgba(180,160,130,${puffA})`;
        ctx.beginPath();
        ctx.ellipse(ax, ay, pr0, pr0 * 0.55, 0, 0, TAU);
        ctx.fill();
      }
      // Arrow with tip slightly past the surface point (iron tip buried,
      // shaft + fletching pokes up).
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(stuckAng);
      ctx.translate(-arrL * 0.5 + arrL * 0.08, 0);
      _drawArrowsSpellArrow(ctx, arrL, globalA, P);
      ctx.restore();
    }
  }

  ctx.restore(); // end transform
}

// ── Cannon (defensive building) ──────────────────────────────────────────────
// A wooden gun-carriage on a cobble base, with a brass-banded iron barrel
// that *smoothly rotates* to track its target. The whole rig is stationary
// (no gait, no bob, no lean), but it ANIMATES on three timelines:
//
//   aim       — `aimAng` lerps toward the latest target angle each frame, at
//               a capped turn-rate (≈3 rad/s). This is what gives the cannon
//               its "tracking" feel and matches the in-game HasRotationOnTimeline
//               flag from buildings.csv (TurretMovement=15).
//   recoil    — engine bumps u.cooldown to hitSpeed on each shot; the rising
//               edge starts a 0.30 s recoil animation: barrel jerks back,
//               then settles. Muzzle flash + smoke puff are driven off this.
//   spawn     — same rune-ring entrance every other unit gets (u.deployTimer).
//
// Lifetime: the engine self-destructs a Cannon at 30 s regardless of HP. The
// sprite reads `u.lifetime` to dim slightly + tint amber in the last ~6 s so
// the upcoming despawn is legible. Death poof is wired via markCannon() +
// sweepAnim() (rubble chunks, scorched wood, dirty grey smoke).
//
// Per-unit rig state lives in a local `cannonRig` map keyed by unit id; it
// tracks aimAng, attack-timeline carry-over (atkT), hit flash, and a few
// transient smoke puffs ejected at each muzzle burst (so smoke keeps drifting
// after the shot even when the cooldown is over).
const cannonRig = new Map();

// Palette — warm wood + brass barrel + soot. Team color appears only on the
// banner so the cannon itself reads as a neutral piece of artillery owned by
// the player flying that flag.
const CN_WOOD_HI  = '#a96b3a';   // top-lit oak
const CN_WOOD    = '#7a4a23';    // body mid-tone
const CN_WOOD_LO = '#4a2b14';    // shadow side / inside the carriage
const CN_IRON_HI = '#cfd3da';
const CN_IRON    = '#7c828e';
const CN_IRON_LO = '#3a3f48';
const CN_BRASS_HI= '#ffd87a';
const CN_BRASS   = '#c9912a';
const CN_BRASS_LO= '#7a5410';
const CN_STONE_HI= '#cfc6b5';
const CN_STONE   = '#9a907c';
const CN_STONE_LO= '#5a5142';
const CN_BLACK   = '#0a0a0a';
const CN_OL      = '#000000';

// Smooth angle towards a target, shortest direction, capped by max delta.
function _turnToward(cur, want, maxStep) {
  let d = want - cur;
  // Wrap to [-π, π] so we always take the shorter arc.
  while (d >  Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  if (d >  maxStep) d =  maxStep;
  if (d < -maxStep) d = -maxStep;
  return cur + d;
}

// Public entry — call once per frame for every alive Cannon.
//   gx, gy   : screen-space ground anchor (cannon's tile position)
//   tile     : pixels per tile
//   u        : the unit (carries hp/maxHp/deployTimer/cooldown/lifetime/maxLifetime/owner)
//   targetSc : optional { x, y } in SCREEN coords — the unit the cannon is
//              aiming at; the barrel rotates toward it. May be null (idle).
//   dtReal   : real-time delta from beginFrame(); used for smooth aim + smoke.
export function drawCannon(ctx, gx, gy, tile, u, targetSc, dtReal) {
  // ── rig: fetch or create persistent per-unit anim state ───────────────────
  let a = cannonRig.get(u.id);
  if (!a) {
    // Initial barrel angle: face the enemy field (P0 cannons aim up, P1 down).
    const startAng = u.owner === 0 ? -Math.PI / 2 : Math.PI / 2;
    a = {
      aimAng: startAng,
      atkT: 0,
      lastCd: u.cooldown,
      flashT: 0,
      lastHp: u.hp,
      smoke: [],            // [{x,y,r,age,life}, ...] world-space drift
      seen: true,
      owner: u.owner,
      lx: u.x, ly: u.y,     // remembered for sweepAnim death poof
    };
    cannonRig.set(u.id, a);
  }
  a.seen = true;
  a.lx = u.x; a.ly = u.y;

  // Attack rising-edge detector (matches getAnim's pattern for troops).
  if (u.cooldown > a.lastCd + 1e-6) {
    a.atkT = SWING;
    // Spawn 2 puffs at the muzzle tip (positions resolved later via current
    // aim angle). We just record the angle/time; world-space position is
    // baked in once we know the muzzle location below.
    a._wantPuff = 2;
  }
  a.lastCd = u.cooldown;
  if (a.atkT > 0) a.atkT = Math.max(0, a.atkT - dtReal);

  // Hit flash (matches troops).
  if (u.hp < a.lastHp - 0.5) a.flashT = FLASH;
  a.lastHp = u.hp;
  if (a.flashT > 0) a.flashT = Math.max(0, a.flashT - dtReal);

  // Smooth aim — turn at ≤3 rad/s toward the target's screen-space angle.
  // While deploying, lock the angle (cannon is "building itself"); also lock
  // if no target so the barrel doesn't snap to zero between volleys.
  if (targetSc && u.deployTimer <= 0) {
    const wantAng = Math.atan2(targetSc.y - gy, targetSc.x - gx);
    a.aimAng = _turnToward(a.aimAng, wantAng, 3.0 * dtReal);
  }

  // ── scale / spawn growth (matches troops' easeOut entrance) ───────────────
  // Tuned so the 2.5D top-down sprite reads as ~3 tiles wide × ~3 tiles tall
  // on screen. The wooden trestle footprint is `halfW * 2 = sc * 2` ≈ 3 tiles
  // (matches the engine's 3×3 collision footprint, def.radius = 1.5).
  const S = tile * 1.50;
  const spawnF = u.deployTimer > 0 ? clamp01(1 - u.deployTimer / 1.0) : 1;
  const grow = lerp(0.4, 1, easeOut(spawnF));
  const sc = S * grow;

  // Lifetime tint: dim + amber in the last 6 s so the upcoming despawn reads.
  const lifeRemain = u.lifetime != null ? u.lifetime : 30;
  const lifeFade = lifeRemain < 6
    ? clamp01((6 - lifeRemain) / 6)  // 0 → 1 as lifetime drains
    : 0;

  // Recoil — mortar pulls back along its aim vector, then settles.
  const s = 1 - a.atkT / SWING;   // 0..1 progression through the swing
  let recoil = 0, muzzleFlash = 0;
  if (a.atkT > 0) {
    if (s < 0.25) { recoil = easeOut(s / 0.25); muzzleFlash = recoil; }
    else { recoil = 1 - easeOut((s - 0.25) / 0.75); muzzleFlash = 0; }
  }
  const teamRgb = u.owner === 0 ? '70,177,255' : '255,107,102';
  const teamCol = u.owner === 0 ? '#46b1ff' : '#ff6b66';
  const teamDim = u.owner === 0 ? '#1d6fae' : '#b53f3b';

  // Stable per-id pseudo-random tints so a given Cannon always looks
  // identical across frames (wood-grain knot positions etc.).
  const idHash = (i) => {
    const v = Math.sin(i * 12.9898 + (u.id || 1) * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };

  ctx.save();
  ctx.globalAlpha = lerp(0.30, 1, easeOut(spawnF));
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // ── ground shadow (compact, under the trestle's feet) ────────────────────
  ctx.fillStyle = `rgba(0,0,0,${0.52 * (1 - lifeFade * 0.20)})`;
  ctx.beginPath();
  ctx.ellipse(gx + sc * 0.04, gy + sc * 0.10, sc * 0.85, sc * 0.32, 0, 0, TAU);
  ctx.fill();

  // ── spawn rune ring (only during deployTimer) ────────────────────────────
  if (spawnF < 1) {
    const inv = 1 - spawnF;
    ctx.strokeStyle = `rgba(${teamRgb},${0.85 * inv})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(gx, gy + sc * 0.05, sc * (0.90 + spawnF * 0.5), sc * 0.36 * (0.90 + spawnF * 0.5), 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,216,122,${0.95 * inv})`;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * TAU + spawnF * 0.5;
      const rx = sc * (0.85 + spawnF * 0.45);
      const ry = sc * 0.34 * (0.85 + spawnF * 0.45);
      ctx.beginPath();
      ctx.arc(gx + Math.cos(ang) * rx, gy + Math.sin(ang) * ry, 0.10 * sc, 0, TAU);
      ctx.fill();
    }
  }

  // ── 2.5D TOP-DOWN LAYOUT (sq. 3×3 footprint, rotating barrel) ────────────
  // The world ground footprint is a 3×3-tile square centred on (gx, gy). The
  // screen projection squishes its world-Z (depth) axis by `persp` so the
  // top of the trestle reads as an oval, matching the game's other 2.5D
  // sprites (towers etc.).
  //
  // Vertical landmarks on screen (smaller y = higher = farther into scene):
  //   gy + sc*0.10 : ground line / front-bottom of base
  //   gy - sc*0.45 : pivot point on the saddle (where barrel rotates)
  //   gy - sc*1.20 : top-back of base / saddle back edge
  //   gy - sc*1.70 : top of HP-bar headroom (handled by renderer)
  //
  // Total span: from gy+0.10 to ~gy-1.20 = sc*1.30 ≈ 2 tiles for the sprite;
  // the HP bar sits another ~tile above, putting the full silhouette at ~3
  // tiles wide × ~3 tiles tall — the 3×3 square the user asked for.
  const halfW       = sc * 0.70;        // half-width (foundation 0.7× = ~2 tiles)
  const persp       = 0.55;             // 2.5D Y-squish (towers + other 2.5D)
  const baseTopBackY  = gy - sc * 1.20; // back-top of saddle (deepest into scene)
  const baseTopFrontY = gy - sc * 0.45; // front-top of saddle (top of the visible rim)
  const baseFrontBotY = gy + sc * 0.10; // bottom of the wood "skirt" (ground line)
  const pivotX        = gx;
  const pivotY        = (baseTopBackY + baseTopFrontY) * 0.5 - sc * 0.04;

  // ── wooden trestle base (NOT rotated, drawn 2.5D top-down) ──────────────
  // ── 1. back-corner posts (drawn first so the saddle paints over them) ──
  const postW = sc * 0.14;
  for (const sxs of [-1, 1]) {
    const px = gx + sxs * halfW * 0.80;
    ctx.fillStyle = CN_WOOD_LO;
    rr(ctx, px - postW * 0.5, baseTopBackY - sc * 0.02, postW, sc * 0.20, sc * 0.02);
    ctx.fill();
    ctx.strokeStyle = CN_OL;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // ── 2. saddle top — a Y-squished rectangle (the lit upper surface) ──
  // Trapezoidal: back edge narrower than front (perspective).
  ctx.fillStyle = CN_WOOD;
  ctx.beginPath();
  ctx.moveTo(gx - halfW * 0.78, baseTopBackY);
  ctx.lineTo(gx + halfW * 0.78, baseTopBackY);
  ctx.lineTo(gx + halfW * 0.96, baseTopFrontY);
  ctx.lineTo(gx - halfW * 0.96, baseTopFrontY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Top-lit highlight along the back edge (sun from above-back)
  ctx.fillStyle = CN_WOOD_HI;
  ctx.beginPath();
  ctx.moveTo(gx - halfW * 0.78, baseTopBackY);
  ctx.lineTo(gx + halfW * 0.78, baseTopBackY);
  ctx.lineTo(gx + halfW * 0.82, baseTopBackY + sc * 0.10);
  ctx.lineTo(gx - halfW * 0.82, baseTopBackY + sc * 0.10);
  ctx.closePath();
  ctx.fill();

  // Wood-grain stripes (subtle, follow the perspective)
  ctx.strokeStyle = CN_WOOD_LO;
  ctx.lineWidth = 1.0;
  for (let i = 0; i < 3; i++) {
    const t = 0.30 + i * 0.22;
    const xL = gx + (-halfW * 0.78) * (1 - t) + (-halfW * 0.96) * t + idHash(i + 10) * 3;
    const xR = gx + ( halfW * 0.78) * (1 - t) + ( halfW * 0.96) * t + idHash(i + 20) * 3;
    const yy = baseTopBackY + (baseTopFrontY - baseTopBackY) * t;
    ctx.beginPath();
    ctx.moveTo(xL, yy);
    ctx.lineTo(xR, yy);
    ctx.stroke();
  }

  // X-cross brace VISIBLE on the saddle top (sawhorse signature)
  ctx.strokeStyle = CN_WOOD_LO;
  ctx.lineWidth = sc * 0.08;
  ctx.beginPath();
  ctx.moveTo(gx - halfW * 0.74, baseTopBackY + sc * 0.04);
  ctx.lineTo(gx + halfW * 0.90, baseTopFrontY - sc * 0.04);
  ctx.moveTo(gx + halfW * 0.74, baseTopBackY + sc * 0.04);
  ctx.lineTo(gx - halfW * 0.90, baseTopFrontY - sc * 0.04);
  ctx.stroke();

  // ── 3. front face of the saddle (visible vertical strip, the wood thickness) ──
  ctx.fillStyle = CN_WOOD_LO;
  ctx.beginPath();
  ctx.moveTo(gx - halfW * 0.96, baseTopFrontY);
  ctx.lineTo(gx + halfW * 0.96, baseTopFrontY);
  ctx.lineTo(gx + halfW * 0.96, baseFrontBotY);
  ctx.lineTo(gx - halfW * 0.96, baseFrontBotY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Vertical front-leg strapping (3 dark iron bands, evenly spaced)
  ctx.fillStyle = CN_IRON_LO;
  for (const xOff of [-0.55, 0.0, 0.55]) {
    const sx0 = gx + halfW * xOff - sc * 0.025;
    rr(ctx, sx0, baseTopFrontY - sc * 0.02, sc * 0.05, baseFrontBotY - baseTopFrontY + sc * 0.04, sc * 0.01);
    ctx.fill();
  }

  // Team-colored iron plate on the centre of the front face (the small dark
  // square in the reference; team-tinted so sides are identifiable from above).
  const plateW = sc * 0.34, plateH = sc * 0.20;
  const plateY = (baseTopFrontY + baseFrontBotY) * 0.5 - plateH * 0.5;
  ctx.fillStyle = teamDim;
  rr(ctx, gx - plateW / 2, plateY, plateW, plateH, sc * 0.025);
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // rivet quartet
  ctx.fillStyle = CN_IRON_HI;
  for (const [dx, dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
    ctx.beginPath();
    ctx.arc(gx + dx * plateW * 0.36, plateY + (dy > 0 ? plateH * 0.75 : plateH * 0.25), sc * 0.022, 0, TAU);
    ctx.fill();
  }
  // bright team emblem dot
  ctx.fillStyle = teamCol;
  ctx.beginPath();
  ctx.arc(gx, plateY + plateH / 2, sc * 0.05, 0, TAU);
  ctx.fill();

  // ── 4. mortar barrel — ROTATES to aim, short & fat, 2.5D top-down view ──
  // The barrel lies on the saddle, rotating around (pivotX, pivotY). The
  // ctx.scale(1, persp) below applies the same Y-squish as the base so a
  // barrel pointing toward/away from the camera looks foreshortened.
  ctx.save();
  ctx.translate(pivotX, pivotY);
  ctx.rotate(a.aimAng);
  ctx.scale(1, persp);
  // Recoil pulls back along the LOCAL -x axis (away from muzzle).
  ctx.translate(-recoil * sc * 0.10, 0);

  // SHORT FAT mortar — body width DOUBLED (was 0.40 → 0.80 half-thickness).
  const barL  = sc * 1.00;     // overall barrel length (in world)
  const barR  = sc * 0.80;     // body half-thickness (2× wider than before)
  const xBack = -sc * 0.30;
  const xFront = xBack + barL;
  const flareW = sc * 0.16;
  const flareR = barR + sc * 0.08;

  // Drop shadow under the barrel (offset down + right in screen, so in
  // local-frame coords after rotate+scale, just nudge along +y).
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  rr(ctx, xBack + sc * 0.04, -barR + sc * 0.10, barL, barR * 2, barR * 0.45);
  ctx.fill();

  // Barrel body — gradient from light top to dark bottom (sun from above)
  const bg = ctx.createLinearGradient(0, -barR, 0, barR);
  bg.addColorStop(0.00, CN_IRON_HI);
  bg.addColorStop(0.30, CN_IRON);
  bg.addColorStop(1.00, CN_IRON_LO);
  ctx.fillStyle = bg;
  rr(ctx, xBack, -barR, barL, barR * 2, barR * 0.45);
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 2.0;
  rr(ctx, xBack, -barR, barL, barR * 2, barR * 0.45);
  ctx.stroke();

  // Two brass reinforcing rings — mortars have a beefy, banded look.
  for (const fr of [0.30, 0.75]) {
    const cxR = xBack + barL * fr;
    const wRing = sc * 0.09;
    const ringG = ctx.createLinearGradient(0, -barR, 0, barR);
    ringG.addColorStop(0.00, CN_BRASS_HI);
    ringG.addColorStop(0.55, CN_BRASS);
    ringG.addColorStop(1.00, CN_BRASS_LO);
    ctx.fillStyle = ringG;
    rr(ctx, cxR - wRing / 2, -barR - sc * 0.018, wRing, barR * 2 + sc * 0.036, sc * 0.02);
    ctx.fill();
    ctx.strokeStyle = CN_OL;
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }

  // Muzzle flare collar — wide brass lip at the front of the barrel.
  const muzzleGr = ctx.createLinearGradient(0, -flareR, 0, flareR);
  muzzleGr.addColorStop(0.0, CN_BRASS_HI);
  muzzleGr.addColorStop(0.5, CN_BRASS);
  muzzleGr.addColorStop(1.0, CN_BRASS_LO);
  ctx.fillStyle = muzzleGr;
  rr(ctx, xFront - flareW, -flareR, flareW, flareR * 2, sc * 0.04);
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Dark bore (the muzzle hole) — drawn as an ellipse just inside the lip.
  ctx.fillStyle = CN_BLACK;
  ctx.beginPath();
  ctx.ellipse(xFront - flareW * 0.40, 0, sc * 0.12, barR * 0.78, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = `rgba(80,80,80,0.6)`;
  ctx.lineWidth = 1.0;
  ctx.stroke();
  // Muzzle inner glow when firing
  if (muzzleFlash > 0) {
    const fG = ctx.createRadialGradient(
      xFront - flareW * 0.40, 0, sc * 0.01,
      xFront - flareW * 0.40, 0, sc * 0.30
    );
    fG.addColorStop(0, `rgba(255,255,235,${0.95 * muzzleFlash})`);
    fG.addColorStop(0.5, `rgba(255,180,40,${0.75 * muzzleFlash})`);
    fG.addColorStop(1, `rgba(255,80,0,0)`);
    ctx.fillStyle = fG;
    ctx.beginPath();
    ctx.arc(xFront - flareW * 0.40, 0, sc * 0.30, 0, TAU);
    ctx.fill();
  }

  // Trunnion cap — small brass disc at the barrel's pivot point on top of
  // the carriage (visible especially when barrel rotates sideways).
  ctx.fillStyle = CN_BRASS;
  ctx.beginPath();
  ctx.arc(xBack + sc * 0.18, 0, sc * 0.10, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = CN_OL;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = CN_BRASS_HI;
  ctx.beginPath();
  ctx.arc(xBack + sc * 0.18 - sc * 0.025, -sc * 0.025, sc * 0.035, 0, TAU);
  ctx.fill();

  // Brushed-metal top highlight along the upper edge of the barrel
  ctx.strokeStyle = `rgba(255,255,255,0.50)`;
  ctx.lineWidth = sc * 0.04;
  ctx.beginPath();
  ctx.moveTo(xBack + sc * 0.06, -barR + sc * 0.05);
  ctx.lineTo(xFront - flareW - sc * 0.06, -barR + sc * 0.05);
  ctx.stroke();

  // Muzzle flash burst (additive) — bursts forward of the bore.
  if (muzzleFlash > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const flashX = xFront + sc * 0.04;
    const flashRad = sc * 0.50 * muzzleFlash;
    const rg = ctx.createRadialGradient(flashX, 0, sc * 0.02, flashX, 0, flashRad);
    rg.addColorStop(0.0, `rgba(255,255,230,${0.95 * muzzleFlash})`);
    rg.addColorStop(0.3, `rgba(255,200,90,${0.80 * muzzleFlash})`);
    rg.addColorStop(0.7, `rgba(255,110,20,${0.45 * muzzleFlash})`);
    rg.addColorStop(1.0, `rgba(255,40,0,0)`);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(flashX, 0, flashRad, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,220,${0.85 * muzzleFlash})`;
    ctx.lineWidth = sc * 0.06 * muzzleFlash;
    for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const len = sc * (ang === 0 ? 0.70 : 0.40) * muzzleFlash;
      ctx.beginPath();
      ctx.moveTo(flashX, 0);
      ctx.lineTo(flashX + Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Record muzzle-tip in local coords; we convert to world after restore.
  if (a._wantPuff) {
    a._puffWantX = xFront + sc * 0.08;
    a._puffWantY = 0;
  }

  ctx.restore(); // end barrel rotation + perspective

  // ── world-space smoke puffs (drift away from muzzle in aim direction) ───
  if (a._wantPuff) {
    const lx = a._puffWantX;
    const ly = a._puffWantY;
    const cos = Math.cos(a.aimAng), sn = Math.sin(a.aimAng);
    const wx = pivotX + lx * cos - ly * persp * sn;
    const wy = pivotY + lx * sn + ly * persp * cos;
    for (let i = 0; i < a._wantPuff; i++) {
      const jitter = (Math.random() - 0.5) * 0.18;
      const dirAng = a.aimAng + jitter;
      a.smoke.push({
        x: wx,
        y: wy,
        vx: Math.cos(dirAng) * (sc * 0.50 + Math.random() * sc * 0.30),
        vy: Math.sin(dirAng) * (sc * 0.50 + Math.random() * sc * 0.30) - sc * 0.20,
        r0: sc * (0.22 + Math.random() * 0.10),
        age: 0,
        life: 0.55 + Math.random() * 0.25,
      });
    }
    a._wantPuff = 0;
  }
  for (let i = a.smoke.length - 1; i >= 0; i--) {
    const sm = a.smoke[i];
    sm.age += dtReal;
    if (sm.age >= sm.life) { a.smoke.splice(i, 1); continue; }
    const f = sm.age / sm.life;
    sm.x += sm.vx * dtReal * (1 - f * 0.5);
    sm.y += sm.vy * dtReal * (1 - f * 0.7) - dtReal * sc * 0.55;
    const r = sm.r0 * (1 + f * 1.8);
    const alpha = (1 - f) * 0.55;
    ctx.fillStyle = `rgba(200,200,200,${alpha})`;
    ctx.beginPath();
    ctx.arc(sm.x, sm.y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.5})`;
    ctx.beginPath();
    ctx.arc(sm.x - r * 0.25, sm.y - r * 0.25, r * 0.45, 0, TAU);
    ctx.fill();
  }

  // ── lifetime amber wash (last 6 s) ───────────────────────────────────────
  if (lifeFade > 0) {
    ctx.fillStyle = `rgba(255,140,40,${0.18 * lifeFade})`;
    ctx.beginPath();
    ctx.ellipse(gx, pivotY, halfW * 0.95, halfW * 0.95 * persp + sc * 0.30, 0, 0, TAU);
    ctx.fill();
  }

  // ── hit flash overlay ────────────────────────────────────────────────────
  if (a.flashT > 0) {
    const f = a.flashT / FLASH;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,240,210,${0.55 * f})`;
    ctx.beginPath();
    ctx.ellipse(gx, pivotY, halfW * 0.95, halfW * 0.95 * persp + sc * 0.30, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore(); // global alpha / spawn fade
}

// Flag the rig as "Cannon" so sweepAnim() can generate a Cannon-flavoured
// poof (rubble chunks + smoke) when the unit dies or its lifetime expires.
export function markCannon(id) {
  const a = cannonRig.get(id);
  if (a) a.wasCannon = true;
}

// Cannonball projectile — drawn in renderer.js for p.src.card === 'Cannon'.
// A dark iron sphere with a brass-gold rim catch, motion-blur streak behind,
// and a faint smoke trail. (`ang` is the screen-space travel angle.)
export function drawCannonball(ctx, x, y, ang, tile, opts = {}) {
  const r = tile * 0.20;
  const c = Math.cos(ang), s = Math.sin(ang);

  // Smoke trail (3 puffs receding behind the ball)
  for (let i = 1; i <= 3; i++) {
    const bx = x - c * r * (1.0 + i * 0.85);
    const by = y - s * r * (1.0 + i * 0.85);
    const br = r * (0.85 + i * 0.20);
    const a = 0.32 - i * 0.085;
    ctx.fillStyle = `rgba(160,160,160,${a})`;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, TAU);
    ctx.fill();
  }

  // Motion-blur streak — short trail behind the ball
  if (opts.motion !== false) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    const grad = ctx.createLinearGradient(-r * 2.0, 0, 0, 0);
    grad.addColorStop(0.0, 'rgba(80,80,80,0)');
    grad.addColorStop(1.0, 'rgba(40,40,40,0.55)');
    ctx.fillStyle = grad;
    rr(ctx, -r * 2.0, -r * 0.45, r * 2.0, r * 0.90, r * 0.45);
    ctx.fill();
    ctx.restore();
  }

  // Iron ball body with light from upper-left.
  const bg = ctx.createRadialGradient(
    x - r * 0.35, y - r * 0.35, r * 0.05,
    x, y, r
  );
  bg.addColorStop(0.0, '#8a8e96');
  bg.addColorStop(0.5, '#3a3f48');
  bg.addColorStop(1.0, '#0e1116');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Bright specular catchlight (upper-left)
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(x - r * 0.40, y - r * 0.40, r * 0.18, 0, TAU);
  ctx.fill();

  // Brass-gold leading edge (additive) — sells "freshly fired hot shot"
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const lead = ctx.createRadialGradient(
    x + c * r * 0.7, y + s * r * 0.7, r * 0.05,
    x + c * r * 0.7, y + s * r * 0.7, r * 0.55
  );
  lead.addColorStop(0.0, 'rgba(255,210,120,0.85)');
  lead.addColorStop(0.6, 'rgba(255,140,30,0.40)');
  lead.addColorStop(1.0, 'rgba(255,80,0,0)');
  ctx.fillStyle = lead;
  ctx.beginPath();
  ctx.arc(x + c * r * 0.7, y + s * r * 0.7, r * 0.55, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ── Princess & King Towers ───────────────────────────────────────────────────
// Square stone keeps drawn in 2.5D (same perspective convention as the cannon
// — back narrower & higher than front so the flat square roof renders as a
// trapezoid). A rectangular front wall sits under the roof's front edge;
// crenellated parapet walls ring all four roof edges with taller corner
// turrets at the four corners. A central stone brazier on the roof carries
// the activated-state flame (replaces the old open-chamber glow). Single
// dispatch on t.kind: the king is bigger, has gold conical spires on its
// corner turrets and a taller banner pole.
// Everything that varies per tower (stone-block tint, banner flutter phase,
// crack paths, rubble layout) is hash-derived from t.id so the look is
// stable across frames without any persistent rig state.
//
// State branches:
//   !t.alive            -> rubble pile (broken chunks, smoke, snapped pole,
//                          torn flag draped over the heap)
//   alive && activated  -> bright stonework, brazier burning + warm bloom,
//                          lanterns glow (additive), gold rune ring +
//                          pulsing halo at the base, banner flutters at
//                          full amplitude
//   alive && !activated -> dim/desaturated (king only — princess is always
//                          activated by the engine), brazier cold (ashes),
//                          lanterns dark, weak banner flutter, drifting
//                          "Zz" sleepy marker
//
// HP-driven cracks: under 50% HP small cracks appear on the front wall;
// under 20% they grow and tiny rubble bits tumble down the front face.
//
// `opts` accepts { team, dim } — the renderer passes the bound team-colour
// pair; we fall back to the COL constants if not supplied.
const TOWER_PALETTE = {
  BLACK: '#000000',
  NAVY : '#14213d',
  GOLD : '#fca311',
  LIGHT: '#e5e5e5',
  WHITE: '#ffffff',
};

export function drawTower(ctx, cx, cy, tile, t, opts = {}) {
  const isKing = t.kind === 'king';
  const sizeT  = isKing ? 3.0 : 2.4;
  const size   = sizeT * tile;
  const half   = size / 2;
  const x0 = cx - half, y0 = cy - half;
  const x1 = cx + half, y1 = cy + half;
  const W  = size,      H  = size;

  const { BLACK, NAVY: NAVYC, GOLD: GOLDC, LIGHT, WHITE } = TOWER_PALETTE;

  // Banner / rune team-color tint. Stone itself stays neutral so the two
  // factions are only distinguished by their flag.
  const team    = (opts && opts.team) || (t.owner === 0 ? '#46b1ff' : '#ff6b66');
  const dimT    = (opts && opts.dim ) || (t.owner === 0 ? '#1d6fae' : '#b53f3b');
  const teamRgb = t.owner === 0 ? '70,177,255' : '255,107,102';

  // Stable per-tower pseudo-random — shader-style sin hash on (i, t.id).
  // Same trick used by drawArrowsImpact so per-tower detail (stone tint,
  // crack paths, rubble chunk positions) is locked across frames.
  const id = t.id || 1;
  const rand = (i) => {
    const v = Math.sin(i * 12.9898 + id * 78.233 + (isKing ? 17.3 : 4.1)) * 43758.5453;
    return v - Math.floor(v);
  };

  const T = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  // ── DEAD STATE: rubble pile ───────────────────────────────────────────
  if (!t.alive) {
    // Wide dark ground shadow under the heap.
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    ctx.ellipse(cx, y1, W * 0.62, H * 0.22, 0, 0, TAU);
    ctx.fill();

    // Slow-drifting smoke columns rising from the rubble (non-additive
    // grey so it reads as dust+smoke rather than fire).
    const nSmoke = isKing ? 6 : 5;
    for (let i = 0; i < nSmoke; i++) {
      const rx     = (rand(100 + i) - 0.5) * W * 0.55;
      const drift  = Math.sin(T * 0.6 + i + id) * 4;
      const climb  = ((T * 0.30 + rand(150 + i)) % 1);
      const ySmoke = y1 - climb * H * 0.65 - H * 0.05;
      const sr     = W * (0.14 + 0.04 * i + climb * 0.10);
      const a      = (0.30 - i * 0.04) * (1 - climb * 0.85);
      if (a > 0.01) {
        ctx.fillStyle = `rgba(150,150,150,${a})`;
        ctx.beginPath();
        ctx.ellipse(cx + rx + drift, ySmoke, sr, sr * 0.55, 0, 0, TAU);
        ctx.fill();
      }
    }

    // Heap mound — dark navy base with a lighter highlighted crown.
    ctx.fillStyle = NAVYC;
    ctx.beginPath();
    ctx.ellipse(cx, y1 - H * 0.04, W * 0.46, H * 0.20, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = LIGHT;
    ctx.beginPath();
    ctx.ellipse(cx - W * 0.06, y1 - H * 0.10, W * 0.34, H * 0.13, 0, 0, TAU);
    ctx.fill();

    // Scattered broken stone chunks.
    const N = isKing ? 13 : 10;
    for (let i = 0; i < N; i++) {
      const rx  = (rand(200 + i) - 0.5) * W * 0.95;
      const ry  = (rand(300 + i) - 0.5) * H * 0.32 - H * 0.02;
      const sw  = W * (0.08 + rand(400 + i) * 0.09);
      const sh  = sw * (0.55 + rand(500 + i) * 0.40);
      const rot = rand(600 + i) * TAU;
      ctx.save();
      ctx.translate(cx + rx, y1 + ry);
      ctx.rotate(rot);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath();
      ctx.ellipse(0, sh * 0.55, sw * 0.65, sh * 0.22, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = LIGHT;
      ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
      ctx.fillStyle = 'rgba(20,33,61,0.55)';
      ctx.fillRect(sw / 2 - sw * 0.28, -sh / 2, sw * 0.28, sh);
      ctx.fillStyle = 'rgba(255,255,255,0.40)';
      ctx.fillRect(-sw / 2, -sh / 2, sw * 0.35, Math.max(1, sh * 0.18));
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }

    // Snapped banner pole, bent toward the ground with a torn flag draped
    // over the rubble. Pole bend is hash-stable so the same dead tower
    // always looks the same.
    const poleLen = (isKing ? 1.6 : 1.3) * tile;
    const poleAng = -0.40 + (rand(700) - 0.5) * 0.55;
    const baseX = cx + W * 0.04;
    const baseY = y1 - H * 0.18;
    const tipX  = baseX + Math.cos(poleAng) * poleLen;
    const tipY  = baseY + Math.sin(poleAng) * poleLen;
    ctx.strokeStyle = NAVYC;
    ctx.lineWidth = isKing ? 3.4 : 2.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    // gold ball, dented
    ctx.fillStyle = GOLDC;
    ctx.beginPath();
    ctx.arc(tipX, tipY, isKing ? 3.5 : 2.8, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = BLACK; ctx.lineWidth = 1; ctx.stroke();
    // torn flag draped down/across the rubble
    const flagDir = Math.sign(Math.cos(poleAng)) || 1;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(poleAng + Math.PI / 2);
    ctx.fillStyle = dimT;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tile * 0.70 * flagDir, -tile * 0.05);
    ctx.lineTo(tile * 0.62 * flagDir,  tile * 0.18);
    ctx.lineTo(tile * 0.40 * flagDir,  tile * 0.10); // jagged tear
    ctx.lineTo(tile * 0.22 * flagDir,  tile * 0.30);
    ctx.lineTo(tile * 0.02 * flagDir,  tile * 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = BLACK; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.fillStyle = GOLDC;
    ctx.fillRect(0, -tile * 0.06, tile * 0.70 * flagDir, tile * 0.04);
    ctx.restore();

    // Faint legacy red diagonal cross (kept dim so the rubble pile is the
    // dominant read but the "destroyed" semantic is still unmistakable).
    ctx.strokeStyle = 'rgba(255,80,80,0.28)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x0 + W * 0.22, y0 + H * 0.52);
    ctx.lineTo(x1 - W * 0.22, y1 - H * 0.18);
    ctx.moveTo(x1 - W * 0.22, y0 + H * 0.52);
    ctx.lineTo(x0 + W * 0.22, y1 - H * 0.18);
    ctx.stroke();
    return;
  }

  // ── ALIVE STATE (2.5D: square keep, flat roof, crenellated parapets) ────
  const activated = !!t.activated;
  const hpFrac    = clamp01(t.hp / t.maxHp);
  // Which side faces the camera? P0 towers face up (away from camera, BACK
  // visible), P1 towers face down (FRONT visible — door + lanterns + arch).
  const showsFront = t.owner === 1;

  // 2.5D SQUARE-KEEP LAYOUT
  // The tower is a square stone keep with a FLAT roof, viewed from above-
  // front — same perspective convention as the other 2.5D sprites (cannon):
  // the back edge of the square roof is narrower and higher than the front,
  // so the roof renders as a trapezoid. The wall body is a rectangular front
  // face under the front edge; crenellated parapet walls ring all four edges
  // of the roof, with taller corner turrets at the four corners.
  //
  // Vertical landmarks (smaller y = higher on screen = farther into scene):
  //   roofBackY  : back edge of roof (deepest into scene)
  //   roofFrontY : front edge of roof = top of front wall face (= wallTop)
  //   wallBot    : bottom of wall (ground line, = y1)
  const persp      = 0.50;                              // back-corner Y-offset / halfW
  const halfW      = W * (isKing ? 0.46 : 0.44);        // front face half-width
  const halfWback  = halfW * 0.78;                      // back narrower (perspective)
  const backDY     = halfW * persp;                     // back-edge Y-offset
  const wallTop    = y0 + H * 0.55;                     // top of front wall face
  const roofFrontY = wallTop;                           // front edge of roof
  const roofBackY  = roofFrontY - backDY;               // back edge of roof
  const wallBot    = y1;
  const wallLeftX  = cx - halfW;
  const wallW      = halfW * 2;
  const bodyH      = wallBot - wallTop;
  // Roof corners (square in world → trapezoid in screen)
  const FLx = wallLeftX,        FLy = roofFrontY;
  const FRx = cx + halfW,       FRy = roofFrontY;
  const BLx = cx - halfWback,   BLy = roofBackY;
  const BRx = cx + halfWback,   BRy = roofBackY;
  // Parapet / crenellation sizing
  const merlonH    = H * 0.10;
  const merlonW    = W * (isKing ? 0.085 : 0.095);
  const lowWallH   = merlonH * 0.50;
  const turretW    = W * (isKing ? 0.11 : 0.095);
  const turretH    = merlonH * (isKing ? 2.05 : 1.55);

  // Ground cast shadow at the tower's base
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(cx + W * 0.04, y1 + 2, halfW * 1.08, halfW * 0.36, 0, 0, TAU);
  ctx.fill();

  // Activated rune ring at the base
  if (activated) {
    _drawTowerRuneRing(ctx, cx + W * 0.04, y1 + 2, W, T, id, teamRgb);
  }

  // Wrap the rest so dormant state can desaturate without touching shadow/ring
  ctx.save();
  if (!activated) ctx.globalAlpha = 0.82;

  // ── 1. WALL FRONT FACE ─────────────────────────────────────────────────
  ctx.fillStyle = LIGHT;
  ctx.fillRect(wallLeftX, wallTop, wallW, bodyH);

  // Lit highlight strip on the left
  {
    const g = ctx.createLinearGradient(wallLeftX, wallTop, wallLeftX + wallW * 0.24, wallTop);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(wallLeftX, wallTop, wallW * 0.24, bodyH);
  }
  // Side-bevel shadow on the right (sells the boxy depth of the front face)
  {
    const g = ctx.createLinearGradient(wallLeftX + wallW * 0.70, wallTop, wallLeftX + wallW, wallTop);
    g.addColorStop(0, 'rgba(20,33,61,0)');
    g.addColorStop(1, 'rgba(20,33,61,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(wallLeftX + wallW * 0.70, wallTop, wallW * 0.30, bodyH);
  }
  // Ground contact shadow at the wall's bottom
  {
    const g = ctx.createLinearGradient(wallLeftX, wallBot - H * 0.18, wallLeftX, wallBot);
    g.addColorStop(0, 'rgba(20,33,61,0)');
    g.addColorStop(1, 'rgba(20,33,61,0.60)');
    ctx.fillStyle = g;
    ctx.fillRect(wallLeftX, wallBot - H * 0.18, wallW, H * 0.18);
  }

  // Stone block grid (brick-stagger, per-block hashed tint)
  const cols = isKing ? 4 : 3;
  const rows = isKing ? 4 : 3;
  const bw   = wallW / cols;
  const bh   = bodyH / rows;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.40)';
  for (let r = 0; r < rows; r++) {
    for (let c = -1; c <= cols; c++) {
      const stagger = (r % 2) * bw * 0.5;
      const bx = wallLeftX + c * bw - stagger;
      const by = wallTop + r * bh;
      const left  = Math.max(bx, wallLeftX);
      const right = Math.min(bx + bw, wallLeftX + wallW);
      const cw    = right - left;
      if (cw <= 0) continue;
      const tint = rand(r * 31 + (c + 7) * 13) - 0.5;
      const a    = Math.abs(tint) * 0.18;
      ctx.fillStyle = tint > 0
        ? `rgba(229,229,229,${a + 0.08})`
        : `rgba(20,33,61,${a + 0.04})`;
      ctx.fillRect(left, by, cw, bh);
      ctx.beginPath();
      ctx.moveTo(left, by);
      ctx.lineTo(right, by);
      if (bx + bw <= wallLeftX + wallW + 0.5) {
        ctx.moveTo(bx + bw, by);
        ctx.lineTo(bx + bw, by + bh);
      }
      ctx.stroke();
    }
  }

  // Wall outline
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 2.2;
  ctx.strokeRect(wallLeftX, wallTop, wallW, bodyH);

  // Gold trim band wraps the wall just below the rim
  const trimY = wallTop + bh * 0.20;
  const trimH = Math.max(5, bh * 0.40);
  ctx.fillStyle = GOLDC;
  ctx.fillRect(wallLeftX, trimY, wallW, trimH);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(wallLeftX, trimY, wallW, Math.max(1, trimH * 0.20));
  ctx.fillStyle = 'rgba(156,107,9,0.70)';
  ctx.fillRect(wallLeftX, trimY + trimH - Math.max(1, trimH * 0.22), wallW, Math.max(1, trimH * 0.22));
  const riv = cols + 2;
  for (let i = 0; i < riv; i++) {
    const rx = wallLeftX + (i + 0.5) * (wallW / riv);
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    ctx.arc(rx, trimY + trimH * 0.5, Math.max(1.4, trimH * 0.20), 0, TAU);
    ctx.fill();
    ctx.fillStyle = GOLDC;
    ctx.beginPath();
    ctx.arc(rx, trimY + trimH * 0.5, Math.max(0.8, trimH * 0.10), 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1.4;
  ctx.strokeRect(wallLeftX, trimY, wallW, trimH);

  // Door (front face) or arrow slits (back face)
  const doorW = wallW * (isKing ? 0.22 : 0.24);
  const doorH = bodyH * (isKing ? 0.52 : 0.58);
  const doorX = cx - doorW / 2;
  const doorY = wallBot - doorH - bh * 0.18;
  const fr    = Math.max(2, W * 0.024);
  if (showsFront) {
    ctx.fillStyle = GOLDC;
    ctx.beginPath();
    ctx.moveTo(doorX - fr, doorY + doorW / 2);
    ctx.lineTo(doorX - fr, doorY + doorH);
    ctx.lineTo(doorX + doorW + fr, doorY + doorH);
    ctx.lineTo(doorX + doorW + fr, doorY + doorW / 2);
    ctx.arc(doorX + doorW / 2, doorY + doorW / 2, doorW / 2 + fr, 0, Math.PI, true);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = BLACK; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = NAVYC;
    ctx.beginPath();
    ctx.moveTo(doorX, doorY + doorW / 2);
    ctx.lineTo(doorX, doorY + doorH);
    ctx.lineTo(doorX + doorW, doorY + doorH);
    ctx.lineTo(doorX + doorW, doorY + doorW / 2);
    ctx.arc(doorX + doorW / 2, doorY + doorW / 2, doorW / 2, 0, Math.PI, true);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GOLDC;
    for (let i = 0; i < 3; i++) {
      const ry = doorY + doorH - (i + 0.5) * (doorH / 3);
      ctx.beginPath();
      ctx.arc(doorX - fr * 0.4, ry, fr * 0.45, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(doorX + doorW + fr * 0.4, ry, fr * 0.45, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = BLACK;
    ctx.fillRect(cx - doorW * 0.06, doorY + doorH * 0.20, doorW * 0.12, doorH * 0.55);
    if (activated) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.78 + Math.sin(T * 4 + id) * 0.22;
      const lg = ctx.createRadialGradient(
        cx, doorY + doorH * 0.55, 0,
        cx, doorY + doorH * 0.55, doorW * 1.5
      );
      lg.addColorStop(0,   `rgba(252,163,17,${0.85 * pulse})`);
      lg.addColorStop(0.5, `rgba(252,163,17,${0.32 * pulse})`);
      lg.addColorStop(1,   'rgba(252,163,17,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.ellipse(cx, doorY + doorH * 0.55, doorW * 1.4, doorH * 0.95, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  } else {
    // BACK FACE: 3 tall arrow slits high on the wall
    const slitH = bodyH * (isKing ? 0.40 : 0.44);
    const slitW = Math.max(2, W * 0.035);
    const slitY = doorY + doorH * 0.10;
    for (const k of [-1, 0, 1]) {
      const sxK = cx + k * wallW * (isKing ? 0.22 : 0.24);
      ctx.fillStyle = GOLDC;
      ctx.fillRect(sxK - slitW * 0.9, slitY - 1, slitW * 1.8, slitH + 2);
      ctx.strokeStyle = BLACK; ctx.lineWidth = 1; ctx.strokeRect(
        sxK - slitW * 0.9, slitY - 1, slitW * 1.8, slitH + 2
      );
      ctx.fillStyle = BLACK;
      ctx.fillRect(sxK - slitW / 2, slitY, slitW, slitH);
      if (activated) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const pulse = 0.78 + Math.sin(T * 4 + id + k) * 0.22;
        ctx.fillStyle = `rgba(252,163,17,${0.85 * pulse})`;
        ctx.fillRect(sxK - slitW / 2, slitY + slitH * 0.10, slitW, slitH * 0.85);
        const lg = ctx.createRadialGradient(
          sxK, slitY + slitH * 0.50, 0,
          sxK, slitY + slitH * 0.50, slitW * 4
        );
        lg.addColorStop(0, `rgba(252,163,17,${0.55 * pulse})`);
        lg.addColorStop(1, 'rgba(252,163,17,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.ellipse(sxK, slitY + slitH * 0.55, slitW * 3.5, slitH * 0.60, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // HP-driven cracks across the wall (at <50% HP)
  if (hpFrac < 0.5) {
    const sev  = 1 - hpFrac / 0.5;
    const nCk  = Math.floor(2 + sev * 4);
    ctx.strokeStyle = `rgba(0,0,0,${0.55 + sev * 0.35})`;
    ctx.lineWidth = 1 + sev * 1.2;
    for (let i = 0; i < nCk; i++) {
      const sxp = wallLeftX + wallW * (0.12 + rand(800 + i) * 0.76);
      const syp = wallTop + bodyH * (0.10 + rand(900 + i) * 0.55);
      ctx.beginPath();
      ctx.moveTo(sxp, syp);
      let px2 = sxp, py2 = syp;
      const segs = 3 + Math.floor(sev * 3);
      for (let k = 0; k < segs; k++) {
        const da  = (rand(1000 + i * 11 + k) - 0.5) * 1.2;
        const len = W * (0.06 + rand(1100 + i * 11 + k) * 0.12);
        const ang = Math.PI * 0.5 + da;
        px2 += Math.cos(ang) * len;
        py2 += Math.sin(ang) * len;
        ctx.lineTo(px2, py2);
      }
      ctx.stroke();
    }
    if (hpFrac < 0.2) {
      ctx.fillStyle = NAVYC;
      for (let i = 0; i < 5; i++) {
        const ph   = rand(1200 + i);
        const fall = ((T * 0.55 + ph) % 1);
        const bx2  = wallLeftX + wallW * (0.15 + rand(1300 + i) * 0.70);
        const by2  = wallTop + bodyH * (0.20 + fall * 0.70);
        const s    = 2 + rand(1400 + i) * 2;
        ctx.fillRect(bx2 - s / 2, by2 - s / 2, s, s);
      }
    }
  }

  // ── 2. ROOF (flat square top, trapezoidal in screen) ───────────────────
  // The four corners FL/FR/BR/BL define a square in world space; the camera
  // tilt foreshortens the depth axis so on screen it's a trapezoid with the
  // back narrower & higher than the front. Drawn AFTER the wall so the roof
  // covers the wall's top edge — selling the "the wall has thickness" read.
  ctx.fillStyle = LIGHT;
  ctx.beginPath();
  ctx.moveTo(FLx, FLy);
  ctx.lineTo(FRx, FRy);
  ctx.lineTo(BRx, BRy);
  ctx.lineTo(BLx, BLy);
  ctx.closePath();
  ctx.fill();

  // Sun-lit gradient on the roof: brighter near the back (sun from above-back).
  {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(FLx, FLy);
    ctx.lineTo(FRx, FRy);
    ctx.lineTo(BRx, BRy);
    ctx.lineTo(BLx, BLy);
    ctx.closePath();
    ctx.clip();
    const g = ctx.createLinearGradient(cx, roofBackY, cx, roofFrontY);
    g.addColorStop(0.0, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    g.addColorStop(1.0, 'rgba(20,33,61,0.20)');
    ctx.fillStyle = g;
    ctx.fillRect(FLx - 2, roofBackY - 1, wallW + 4, backDY + 2);
    ctx.restore();
  }

  // Flagstone mortar grid in perspective: row lines parallel to front edge,
  // column lines converging from front to back. Clipped to the roof quad so
  // strokes don't bleed past the parapet boundary.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(FLx, FLy);
  ctx.lineTo(FRx, FRy);
  ctx.lineTo(BRx, BRy);
  ctx.lineTo(BLx, BLy);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = 1.0;
  const nRowsRoof = isKing ? 4 : 3;
  for (let r = 1; r < nRowsRoof; r++) {
    const u  = r / nRowsRoof;
    const lx = FLx * (1 - u) + BLx * u;
    const rx = FRx * (1 - u) + BRx * u;
    const ly = FLy * (1 - u) + BLy * u;
    const ry = FRy * (1 - u) + BRy * u;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(rx, ry);
    ctx.stroke();
  }
  const nColsRoof = isKing ? 4 : 3;
  for (let c = 1; c < nColsRoof; c++) {
    const u  = c / nColsRoof;
    const fx = FLx * (1 - u) + FRx * u;
    const bx = BLx * (1 - u) + BRx * u;
    ctx.beginPath();
    ctx.moveTo(fx, roofFrontY);
    ctx.lineTo(bx, roofBackY);
    ctx.stroke();
  }
  // Per-flagstone hashed tint (subtle, locked by tower id)
  for (let r = 0; r < nRowsRoof; r++) {
    for (let c = 0; c < nColsRoof; c++) {
      const u0 = r / nRowsRoof, u1 = (r + 1) / nRowsRoof;
      const v0 = c / nColsRoof, v1 = (c + 1) / nColsRoof;
      // Average centre of the cell
      const fxC = FLx * (1 - (v0 + v1) / 2) + FRx * ((v0 + v1) / 2);
      const bxC = BLx * (1 - (v0 + v1) / 2) + BRx * ((v0 + v1) / 2);
      const uM  = (u0 + u1) / 2;
      const cxC = fxC * (1 - uM) + bxC * uM;
      const cyC = roofFrontY * (1 - uM) + roofBackY * uM;
      const tint = rand(r * 17 + c * 29 + 3) - 0.5;
      const a    = Math.abs(tint) * 0.16;
      ctx.fillStyle = tint > 0
        ? `rgba(229,229,229,${a + 0.06})`
        : `rgba(20,33,61,${a + 0.04})`;
      ctx.beginPath();
      ctx.arc(cxC, cyC, Math.min(wallW / nColsRoof, backDY / nRowsRoof) * 0.42, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();

  // Roof outline (over the grid, so the perimeter reads cleanly)
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(FLx, FLy);
  ctx.lineTo(FRx, FRy);
  ctx.lineTo(BRx, BRy);
  ctx.lineTo(BLx, BLy);
  ctx.closePath();
  ctx.stroke();

  // ── 3. ROOF CENTREPIECE: stone brazier ─────────────────────────────────
  // Replaces the old open-chamber glow source. Sits at the centre of the
  // roof; when activated it burns with warm flame + additive bloom. Drawn
  // BEFORE the parapets so the (closer-to-camera) front parapet's merlons
  // properly occlude the brazier's flame stem when they overlap.
  const brR    = W * (isKing ? 0.11 : 0.10);
  const brX    = cx;
  const brY    = roofFrontY - backDY * 0.42;        // slight forward of centre
  // base ring (darker stone, ellipse footprint)
  ctx.fillStyle = NAVYC;
  ctx.beginPath();
  ctx.ellipse(brX, brY, brR, brR * 0.50, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  // light stone rim around the bowl mouth
  ctx.fillStyle = LIGHT;
  ctx.fillRect(brX - brR * 0.92, brY - brR * 0.46, brR * 1.84, brR * 0.20);
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1.1;
  ctx.strokeRect(brX - brR * 0.92, brY - brR * 0.46, brR * 1.84, brR * 0.20);
  // gold band around the bowl
  ctx.fillStyle = GOLDC;
  ctx.fillRect(brX - brR * 0.92, brY - brR * 0.26, brR * 1.84, brR * 0.09);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(brX - brR * 0.92, brY - brR * 0.26, brR * 1.84, Math.max(1, brR * 0.04));
  if (activated) {
    // inner ember pit
    ctx.fillStyle = '#2a0a00';
    ctx.beginPath();
    ctx.ellipse(brX, brY - brR * 0.10, brR * 0.78, brR * 0.36, 0, 0, TAU);
    ctx.fill();
    // flame body (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const flick = 0.85 + Math.sin(T * 7 + id) * 0.15;
    ctx.fillStyle = `rgba(252,100,17,${0.88 * flick})`;
    ctx.beginPath();
    ctx.ellipse(brX, brY - brR * 0.70, brR * 0.68, brR * 0.90, 0, 0, TAU);
    ctx.fill();
    // hot inner core
    ctx.fillStyle = `rgba(255,225,150,${0.92 * flick})`;
    ctx.beginPath();
    ctx.ellipse(brX, brY - brR * 0.56, brR * 0.34, brR * 0.58, 0, 0, TAU);
    ctx.fill();
    // outer bloom
    const lg = ctx.createRadialGradient(brX, brY - brR * 0.4, 0, brX, brY - brR * 0.4, brR * 5);
    lg.addColorStop(0,   `rgba(252,163,17,${0.55 * flick})`);
    lg.addColorStop(0.5, `rgba(252,163,17,${0.22 * flick})`);
    lg.addColorStop(1,   'rgba(252,163,17,0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(brX, brY - brR * 0.4, brR * 5, 0, TAU);
    ctx.fill();
    // a few hash-stable spark dots floating up
    ctx.fillStyle = `rgba(255,210,120,${0.85 * flick})`;
    for (let i = 0; i < 4; i++) {
      const ph = rand(2000 + i);
      const rise = ((T * 1.1 + ph) % 1);
      const sx2 = brX + (rand(2100 + i) - 0.5) * brR * 1.4;
      const sy2 = brY - brR * 0.5 - rise * brR * 2.2;
      const ar  = 1.6 * (1 - rise);
      if (ar > 0.2) {
        ctx.beginPath();
        ctx.arc(sx2, sy2, ar, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  } else {
    // cold ashes when dormant
    ctx.fillStyle = 'rgba(40,30,30,0.85)';
    ctx.beginPath();
    ctx.ellipse(brX, brY - brR * 0.08, brR * 0.62, brR * 0.28, 0, 0, TAU);
    ctx.fill();
  }

  // ── 4. CRENELLATED PARAPETS along each roof edge ───────────────────────
  // Each of the 4 roof edges gets a low continuous wall ribbon (the parapet
  // walkway shield) with merlons (raised blocks) standing up from it at
  // regular intervals. Crenel gaps between merlons reveal whatever is
  // painted behind them (back parapet visible through front gaps, etc.).
  // Painter order: BACK first (deepest), then sides, then FRONT (closest).
  // Each merlon stands straight UP in screen space regardless of which
  // edge it sits on — a minor cheat that reads cleanly at this scale.
  const drawParapet = (sX, sY, eX, eY, mCount) => {
    // 1) Low wall ribbon: a thin parallelogram lifted lowWallH upward from
    //    the edge (top is parallel to the base edge, shifted up by lowWallH).
    ctx.fillStyle = LIGHT;
    ctx.beginPath();
    ctx.moveTo(sX, sY);
    ctx.lineTo(eX, eY);
    ctx.lineTo(eX, eY - lowWallH);
    ctx.lineTo(sX, sY - lowWallH);
    ctx.closePath();
    ctx.fill();
    // top-light strip along the lit top edge of the ribbon
    ctx.fillStyle = 'rgba(255,255,255,0.50)';
    ctx.beginPath();
    ctx.moveTo(sX, sY - lowWallH);
    ctx.lineTo(eX, eY - lowWallH);
    ctx.lineTo(eX, eY - lowWallH + Math.max(1, lowWallH * 0.22));
    ctx.lineTo(sX, sY - lowWallH + Math.max(1, lowWallH * 0.22));
    ctx.closePath();
    ctx.fill();
    // ribbon outline
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sX, sY);
    ctx.lineTo(eX, eY);
    ctx.lineTo(eX, eY - lowWallH);
    ctx.lineTo(sX, sY - lowWallH);
    ctx.closePath();
    ctx.stroke();
    // 2) Merlons spaced along the edge (excluding the two ends, which the
    //    corner turrets cover). Each merlon stands UP from the top of the
    //    low wall ribbon (= edge - lowWallH).
    for (let i = 1; i <= mCount; i++) {
      const u  = i / (mCount + 1);
      const bx = sX * (1 - u) + eX * u;
      const by = sY * (1 - u) + eY * u - lowWallH;
      const mW = merlonW;
      const mH = merlonH;
      // body
      ctx.fillStyle = LIGHT;
      ctx.fillRect(bx - mW * 0.5, by - mH, mW, mH);
      // right shadow (consistent sun direction with the corner turrets)
      ctx.fillStyle = 'rgba(20,33,61,0.55)';
      ctx.fillRect(bx + mW * 0.28, by - mH, mW * 0.22, mH);
      // top-left lit edge
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillRect(bx - mW * 0.5, by - mH, mW * 0.48, Math.max(1, mH * 0.18));
      // outline
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(bx - mW * 0.5, by - mH, mW, mH);
    }
  };
  // BACK parapet — deepest into the scene, drawn first
  drawParapet(BLx, BLy, BRx, BRy, isKing ? 4 : 3);
  // SIDE parapets (recede front→back; either order is fine, they don't overlap)
  drawParapet(BLx, BLy, FLx, FLy, isKing ? 3 : 2);  // LEFT
  drawParapet(BRx, BRy, FRx, FRy, isKing ? 3 : 2);  // RIGHT
  // FRONT parapet — closest to camera, drawn last so its merlons overlap
  // anything behind them (back parapet, brazier flame stem, banner base).
  drawParapet(FLx, FLy, FRx, FRy, isKing ? 4 : 3);

  // ── 5. CORNER TURRETS at the four roof corners ─────────────────────────
  // Taller blocks at the 4 corners cap each parapet's ends. King towers add
  // a gold conical spire on top of each turret.
  // Order: back corners first (deepest), then front (so the front turrets
  // cleanly cover any side-parapet pixels that intrude into their square).
  const cornerSpots = [
    [BLx, BLy], [BRx, BRy], [FLx, FLy], [FRx, FRy],
  ];
  for (const [tx, ty] of cornerSpots) {
    // body
    ctx.fillStyle = LIGHT;
    ctx.fillRect(tx - turretW * 0.5, ty - turretH, turretW, turretH);
    // right shadow (sells the boxy thickness of the turret)
    ctx.fillStyle = 'rgba(20,33,61,0.60)';
    ctx.fillRect(tx + turretW * 0.26, ty - turretH, turretW * 0.24, turretH);
    // top-left lit edge
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(tx - turretW * 0.5, ty - turretH, turretW * 0.46, Math.max(1, turretH * 0.10));
    // a single horizontal block-line mid-way (a touch of stonework detail)
    ctx.strokeStyle = 'rgba(0,0,0,0.32)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(tx - turretW * 0.5, ty - turretH * 0.50);
    ctx.lineTo(tx + turretW * 0.5, ty - turretH * 0.50);
    ctx.stroke();
    // outline
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(tx - turretW * 0.5, ty - turretH, turretW, turretH);
    if (isKing) {
      // gold conical spire on top
      const tipY = ty - turretH - turretW * 0.80;
      ctx.fillStyle = GOLDC;
      ctx.beginPath();
      ctx.moveTo(tx - turretW * 0.52, ty - turretH);
      ctx.lineTo(tx + turretW * 0.52, ty - turretH);
      ctx.lineTo(tx, tipY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(tx - turretW * 0.52, ty - turretH);
      ctx.lineTo(tx, tipY);
      ctx.lineTo(tx - turretW * 0.18, ty - turretH);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(tx - turretW * 0.52, ty - turretH);
      ctx.lineTo(tx + turretW * 0.52, ty - turretH);
      ctx.lineTo(tx, tipY);
      ctx.closePath();
      ctx.stroke();
      // tiny gold ball at the apex
      ctx.fillStyle = GOLDC;
      ctx.beginPath();
      ctx.arc(tx, tipY - 2, 2.2, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // princess: two tiny mini-crenels on top of each turret
      for (let k = 0; k < 2; k++) {
        const bxk = tx - turretW * 0.5 + (k * 0.55 + 0.05) * turretW;
        ctx.fillStyle = LIGHT;
        ctx.fillRect(bxk, ty - turretH - turretH * 0.16, turretW * 0.40, turretH * 0.16);
        ctx.strokeStyle = BLACK;
        ctx.lineWidth = 1.0;
        ctx.strokeRect(bxk, ty - turretH - turretH * 0.16, turretW * 0.40, turretH * 0.16);
      }
    }
  }

  // Banner pole anchors at the BACK-CENTRE of the roof, just inside the
  // back parapet's low wall, so the pole rises up through (and past) the
  // back parapet's merlons and the corner turrets.
  let bannerTop = roofBackY - lowWallH - merlonH * 0.10;

  // ── Banner pole + fluttering team flag ──
  const poleX    = cx + (isKing ? -W * 0.02 : 0);
  const poleBase = bannerTop;
  const poleH    = (isKing ? 1.55 : 1.15) * tile;
  const poleTop  = poleBase - poleH;
  ctx.lineCap = 'round';
  ctx.strokeStyle = NAVYC;
  ctx.lineWidth = isKing ? 3 : 2.4;
  ctx.beginPath();
  ctx.moveTo(poleX, poleBase);
  ctx.lineTo(poleX, poleTop);
  ctx.stroke();
  // thin light highlight down the left edge of the pole
  ctx.strokeStyle = 'rgba(229,229,229,0.85)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(poleX - (isKing ? 1.0 : 0.8), poleBase);
  ctx.lineTo(poleX - (isKing ? 1.0 : 0.8), poleTop);
  ctx.stroke();
  // gold ball at the top
  ctx.fillStyle = GOLDC;
  ctx.beginPath();
  ctx.arc(poleX, poleTop, isKing ? 4 : 3.2, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = BLACK; ctx.lineWidth = 1; ctx.stroke();
  // small gold ring securing the flag head
  ctx.fillStyle = GOLDC;
  ctx.fillRect(poleX - 2, poleTop + (isKing ? 6 : 5), 4, 2);

  // Flag: swallow-tail, mid-frequency multi-sine flutter. Dormant king gets
  // reduced amplitude so the flag still subtly stirs but reads as "asleep".
  const amp     = activated ? 1.0 : 0.30;
  const flagH   = poleH * 0.55;
  const flagW   = (isKing ? 1.65 : 1.30) * tile;
  const flagY0  = poleTop + (isKing ? 8 : 6);
  const seg     = 6;
  const topPts  = [];
  const botPts  = [];
  for (let i = 0; i <= seg; i++) {
    const u    = i / seg;
    const wave = (Math.sin(T * 3.0 + id + u * 4.5) * 0.40 +
                  Math.sin(T * 5.7 + id * 1.3 + u * 6.5) * 0.20) * amp;
    const offX = u * flagW;
    const offY = wave * flagH * 0.40;
    topPts.push([poleX + offX, flagY0 + offY]);
    botPts.push([poleX + offX, flagY0 + flagH + offY * 0.85]);
  }
  // swallow-tail: notch the trailing edge inward to a midpoint
  const tailMidY = (topPts[seg][1] + botPts[seg][1]) / 2;
  ctx.fillStyle = team;
  ctx.beginPath();
  ctx.moveTo(topPts[0][0], topPts[0][1]);
  for (let i = 1; i <= seg; i++) ctx.lineTo(topPts[i][0], topPts[i][1]);
  ctx.lineTo(topPts[seg][0] - flagW * 0.22, tailMidY);
  for (let i = seg; i >= 0; i--) ctx.lineTo(botPts[i][0], botPts[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // gold trim on the leading edge (against the pole)
  ctx.strokeStyle = GOLDC;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(topPts[0][0], topPts[0][1]);
  ctx.lineTo(botPts[0][0], botPts[0][1]);
  ctx.stroke();
  // travelling white specular stripe, clipped to the flag shape
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topPts[0][0], topPts[0][1]);
  for (let i = 1; i <= seg; i++) ctx.lineTo(topPts[i][0], topPts[i][1]);
  ctx.lineTo(topPts[seg][0] - flagW * 0.22, tailMidY);
  for (let i = seg; i >= 0; i--) ctx.lineTo(botPts[i][0], botPts[i][1]);
  ctx.closePath();
  ctx.clip();
  const spx = poleX + ((Math.sin(T * 1.6 + id) + 1) * 0.5) * flagW;
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.beginPath();
  ctx.moveTo(spx - flagW * 0.06, flagY0 - flagH * 0.10);
  ctx.lineTo(spx + flagW * 0.06, flagY0 - flagH * 0.10);
  ctx.lineTo(spx + flagW * 0.12, flagY0 + flagH * 1.20);
  ctx.lineTo(spx - flagW * 0.02, flagY0 + flagH * 1.20);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ── Wall-mounted lanterns either side of the door (front face only) ──
  // The back face has no door, so no lanterns — keeps the rear silhouette
  // visually quieter and reinforces the front/back read.
  if (showsFront) {
    const lanScale = tile * (isKing ? 0.20 : 0.18);
    const lanY     = doorY + doorH * 0.40;
    _drawTowerLantern(ctx, doorX - fr * 1.9 - W * 0.04, lanY, lanScale, activated, T, id + 0);
    _drawTowerLantern(ctx, doorX + doorW + fr * 1.9 + W * 0.04, lanY, lanScale, activated, T, id + 1);
  }

  // ── Dormant king "Zz" marker — drifts gently ──
  if (isKing && !activated) {
    const sleepOff = Math.sin(T * 1.4 + id) * 2.5;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2.5;
    ctx.font = `bold ${Math.round(tile * 0.60)}px ui-monospace,monospace`;
    ctx.textAlign = 'center';
    ctx.strokeText('Zz', cx + W * 0.30, roofBackY - turretH - tile * 0.10 + sleepOff);
    ctx.fillText  ('Zz', cx + W * 0.30, roofBackY - turretH - tile * 0.10 + sleepOff);
  }

  ctx.restore(); // end dormant-alpha wrap
}

// Wall-mounted lantern: dark navy box + gold cap, golden pane lit when
// the tower is activated, additive flickering bloom around it. Dim/dark
// when dormant (still visible as a physical lantern, just unlit).
function _drawTowerLantern(ctx, lx, ly, sc, lit, T, id) {
  const { BLACK, NAVY: NAVYC, GOLD: GOLDC, WHITE } = TOWER_PALETTE;
  // bracket / chain to the wall
  ctx.strokeStyle = NAVYC;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(lx, ly - sc * 1.6);
  ctx.lineTo(lx, ly - sc * 2.1);
  ctx.stroke();
  // gold cap
  ctx.fillStyle = GOLDC;
  ctx.fillRect(lx - sc * 1.15, ly - sc * 1.6, sc * 2.3, sc * 0.35);
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  ctx.strokeRect(lx - sc * 1.15, ly - sc * 1.6, sc * 2.3, sc * 0.35);
  // dark navy lantern body
  ctx.fillStyle = NAVYC;
  ctx.fillRect(lx - sc, ly - sc * 1.25, sc * 2, sc * 2.0);
  ctx.strokeRect(lx - sc, ly - sc * 1.25, sc * 2, sc * 2.0);
  // glass pane
  const flick = 0.85 + Math.sin(T * 9 + id * 1.7) * 0.15;
  ctx.fillStyle = lit
    ? `rgba(253,216,122,${0.85 * flick})`
    : 'rgba(10,20,40,0.95)';
  ctx.fillRect(lx - sc * 0.6, ly - sc * 0.95, sc * 1.2, sc * 1.5);
  if (lit) {
    // gold crossbar inside the pane (silhouetted)
    ctx.fillStyle = `rgba(252,163,17,${0.9 * flick})`;
    ctx.fillRect(lx - sc * 0.6, ly - sc * 0.20, sc * 1.2, sc * 0.10);
    ctx.fillRect(lx - sc * 0.05, ly - sc * 0.95, sc * 0.10, sc * 1.5);
    // tiny white catch
    ctx.fillStyle = `rgba(255,255,255,${0.85 * flick})`;
    ctx.fillRect(lx - sc * 0.40, ly - sc * 0.80, sc * 0.18, sc * 0.18);
    // additive bloom around the lantern
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, sc * 5.5);
    g.addColorStop(0,   `rgba(252,163,17,${0.60 * flick})`);
    g.addColorStop(0.5, `rgba(252,163,17,${0.20 * flick})`);
    g.addColorStop(1,   'rgba(252,163,17,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, sc * 5.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  } else {
    // small white dot showing the unlit pane is still glass, not a hole
    ctx.fillStyle = 'rgba(150,170,200,0.40)';
    ctx.fillRect(lx - sc * 0.40, ly - sc * 0.80, sc * 0.16, sc * 0.16);
  }
}

// Activated-state base ring: 8 stable gold rune marks + slow team-tinted
// haze + a pulsing additive gold ellipse. Drawn behind the body.
function _drawTowerRuneRing(ctx, cx, cy, W, T, id, teamRgb) {
  const { GOLD: GOLDC } = TOWER_PALETTE;
  const rx = W * 0.62, ry = W * 0.21;
  // team-tinted haze beneath everything
  {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
    g.addColorStop(0, `rgba(${teamRgb},0.18)`);
    g.addColorStop(1, `rgba(${teamRgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    ctx.fill();
  }
  // pulsing additive gold ring
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pulse = (Math.sin(T * 2.4 + id) + 1) * 0.5;
  ctx.strokeStyle = `rgba(252,163,17,${0.30 + pulse * 0.35})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * (0.95 + pulse * 0.08), ry * (0.95 + pulse * 0.08), 0, 0, TAU);
  ctx.stroke();
  // 8 stable gold rune dots around the ring, slow rotation
  ctx.fillStyle = `rgba(253,216,122,${0.85 + pulse * 0.15})`;
  const N = 8;
  for (let i = 0; i < N; i++) {
    const a  = (i / N) * TAU + T * 0.20;
    const px = cx + Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;
    ctx.beginPath();
    ctx.arc(px, py, 1.8, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // bright gold rune dots non-additive on top (so they read even when the
  // background underneath happens to already be bright)
  ctx.fillStyle = GOLDC;
  for (let i = 0; i < N; i++) {
    const a  = (i / N) * TAU + T * 0.20;
    const px = cx + Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;
    ctx.beginPath();
    ctx.arc(px, py, 1.0, 0, TAU);
    ctx.fill();
  }
}
