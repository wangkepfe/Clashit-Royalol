// Readable canvas 2D rendering. Player 0 = bottom (blue), Player 1 = top (red).
// y is flipped so y=0 (P0 back line) is at the bottom of the screen.
import { CARDS, DECK } from './cards.js';
import {
  beginFrame, getAnim,
  drawKnight, markKnight,
  drawGiant, markGiant,
  drawArcher, markArcher, drawArrow,
  drawGoblin, markGoblin,
  drawMinion, markMinion, drawMinionSpit,
  drawMusketeer, markMusketeer, drawMusketBullet,
  drawCannon, markCannon, drawCannonball,
  drawFireballProjectile, drawFireballImpact,
  drawArrowsProjectile, drawArrowsImpact,
  drawTower,
  sweepAnim, drawDeathPoofs,
} from './sprites.js';
import { drawBackground } from './background.js';
import { padPx } from './arena-geom.js';

// Team colours for units/towers. The arena itself is the baked background.
const COL = {
  p0: '#46b1ff',
  p1: '#ff6b66',
  p0dim: '#1d6fae',
  p1dim: '#b53f3b',
};

// Per-card visuals: short unambiguous label + role shape.
// shape: 'tank' | 'melee' | 'ranged' | 'air'
export const CARD_VIS = {
  Knight: { label: 'Kn', shape: 'melee' },
  Archers: { label: 'Ac', shape: 'ranged' },
  Goblins: { label: 'Gb', shape: 'melee' },
  Giant: { label: 'Gi', shape: 'tank' },
  Minions: { label: 'Mi', shape: 'air' },        // kept for fallback if forced
  Cannon: { label: 'Cn', shape: 'building' },    // defensive ground building
  Musketeer: { label: 'Mu', shape: 'ranged' },
  Fireball: { label: 'Fb', shape: 'spell' },
  Arrows: { label: 'Ar', shape: 'spell' },
};

export function arenaPixelSize(state, tile) {
  const p = padPx(tile) * 2;
  return { w: state.config.arena.width * tile + p, h: state.config.arena.height * tile + p };
}

export function legendData() {
  // Only show cards that are actually in the live deck. Minions stays defined
  // in CARDS (for fallback rendering if someone forces a deploy via tooling)
  // but is intentionally hidden from the in-app legend.
  return DECK.map((name) => {
    const d = CARDS[name];
    return {
      name,
      label: CARD_VIS[name].label,
      kind: d.kind,
      cost: d.cost,
      shape: CARD_VIS[name].shape,
    };
  });
}

function unitRadius(maxHp) {
  const r = 0.42 + (Math.min(maxHp, 3968) / 3968) * 0.7;
  return Math.max(0.42, Math.min(1.12, r));
}

export function draw(ctx, state, tile, opts = {}) {
  const A = state.config.arena;
  const W = A.width * tile;
  const H = A.height * tile;
  const PAD = padPx(tile);
  const CW = W + PAD * 2, CH = H + PAD * 2;
  const sx = (x) => PAD + x * tile;
  const sy = (y) => PAD + H - y * tile;
  const dtReal = beginFrame();

  // Resolve a unit's attack target so the sprite rig can face it (ranged
  // units pivot to aim; melee don't keep facing the wrong way after stopping).
  // Returns null when there is no target or the target has vanished.
  const findTarget = (id) => {
    if (id == null) return null;
    for (const x of state.units)  if (x.id === id) return x;
    for (const x of state.towers) if (x.id === id && x.alive) return x;
    return null;
  };

  // ── arena background (baked Clash-Royale scene, animated loop) ────────────
  // `opts.bgFrame` pins a specific frame (used as a static still before the
  // user starts the match); otherwise the wall-clock loop drives animation.
  drawBackground(ctx, CW, CH, opts.bgFrame);

  // ── recent-play markers (so you can see what a bot just did) ──────────────
  if (state.logEnabled) {
    for (const ev of state.events) {
      if (ev.type !== 'play' && ev.type !== 'spell') continue;
      const age = state.tick - ev.tick;
      if (age < 0 || age > 26) continue;
      const f = 1 - age / 26;
      const c = ev.owner === 0 ? COL.p0 : COL.p1;
      ctx.globalAlpha = f;
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(ev.x), sy(ev.y), tile * (1.6 - f), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = c;
      ctx.font = `bold ${Math.round(tile * 0.7)}px ui-monospace,monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(
        (CARD_VIS[ev.card] && CARD_VIS[ev.card].label) || '?',
        sx(ev.x),
        sy(ev.y) - tile * (1.4 - f)
      );
      ctx.globalAlpha = 1;
    }
  }

  // ── effects (beams, spells, impacts) ──────────────────────────────────────
  for (const e of state.effects) {
    if (e.kind === 'spell') {
      // Dispatch on the spell's card name so each spell can render its own
      // bespoke impact bloom. `e.card` is set by applySpell() in cards.js.
      // age: 0 = just landed, 1 = vanished (ttl runs 0.35s → 0).
      if (e.card === 'Fireball') {
        const age = 1 - Math.max(0, e.ttl / 0.35);
        drawFireballImpact(
          ctx, sx(e.x), sy(e.y), tile, age, e.radius,
          performance.now() / 1000
        );
      } else if (e.card === 'Arrows') {
        // Wide rain-of-arrows ground hit. `age` runs 0 → 1 over the 0.35s
        // ttl; arrow positions are derived from (sx(e.x), sy(e.y), i) so
        // they stay locked for the whole effect.
        const age = 1 - Math.max(0, e.ttl / 0.35);
        drawArrowsImpact(
          ctx, sx(e.x), sy(e.y), tile, age, e.radius,
          performance.now() / 1000
        );
      } else {
        // Generic orange ring fallback for any unknown spell card.
        const f = Math.max(0, e.ttl / 0.35);
        ctx.fillStyle = `rgba(255,150,30,${0.30 * f})`;
        ctx.strokeStyle = `rgba(255,210,90,${0.9 * f})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx(e.x), sy(e.y), e.radius * tile, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else if (e.kind === 'hit') {
      const c = e.owner === 0 ? COL.p0 : COL.p1;
      if (e.ranged && e.fromX != null) {
        ctx.strokeStyle = c;
        ctx.globalAlpha = Math.max(0, e.ttl / 0.12);
        ctx.lineWidth = 1.5;
        beam(ctx, sx(e.fromX), sy(e.fromY), sx(e.x), sy(e.y));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = `rgba(255,238,150,${Math.max(0, e.ttl / 0.12)})`;
      ctx.beginPath();
      ctx.arc(sx(e.x), sy(e.y), tile * 0.45, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === 'towerDown') {
      const f = Math.max(0, e.ttl / 0.5);
      ctx.strokeStyle = `rgba(255,210,40,${f})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(sx(e.x), sy(e.y), tile * (2.4 - 1.8 * f), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── targeting overlay (optional) ──────────────────────────────────────────
  if (opts.showTargets) {
    const byId = new Map();
    for (const u of state.units) byId.set(u.id, u);
    for (const t of state.towers) byId.set(t.id, t);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (const u of state.units) {
      const tgt = byId.get(u.targetId);
      if (!tgt) continue;
      ctx.beginPath();
      ctx.moveTo(sx(u.x), sy(u.y));
      ctx.lineTo(sx(tgt.x), sy(tgt.y));
      ctx.stroke();
    }
  }

  // ── towers + units (combined depth pass) ─────────────────────────────────
  // Painter's algorithm: draw farther entities first so closer-to-camera
  // ones (lower world y, which maps to LARGER screen y under sy()) paint on
  // top — including their HP bars, so a foreground unit's bar correctly
  // covers a background tower/unit. Towers join the sort so a unit standing
  // BEHIND a tower (higher world y) is properly hidden by the tower body.
  const depthItems = [];
  for (const t of state.towers) depthItems.push({ y: t.y, kind: 'tower', e: t });
  for (const u of state.units)  depthItems.push({ y: u.y, kind: 'unit',  e: u });
  depthItems.sort((a, b) => b.y - a.y);
  for (const item of depthItems) {
    if (item.kind === 'tower') {
      // drawTower handles every state internally (alive activated, alive
      // dormant king, dead rubble pile). HP bar floats above the tower's
      // banner pole + battlements (taller for the king tower).
      const t = item.e;
      const size = (t.kind === 'king' ? 3.0 : 2.4) * tile;
      const cx = sx(t.x);
      const cy = sy(t.y);
      const y0 = cy - size / 2;
      const team = t.owner === 0 ? COL.p0    : COL.p1;
      const dim  = t.owner === 0 ? COL.p0dim : COL.p1dim;
      drawTower(ctx, cx, cy, tile, t, { team, dim });
      if (t.alive) {
        const hpOff = tile * (t.kind === 'king' ? 1.7 : 1.4);
        barNum(ctx, cx, y0 - hpOff, size, t.hp / t.maxHp, Math.round(t.hp), tile, t.owner);
      }
      continue;
    }
    const u = item.e;
    if (u.card === 'Knight') {
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markKnight(u.id);
      drawKnight(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 2.35, tile * 1.4, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Giant') {
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markGiant(u.id);
      drawGiant(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 3.0, tile * 2.0, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Archers') {
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markArcher(u.id);
      drawArcher(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 1.9, tile * 1.2, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Goblins') {
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markGoblin(u.id);
      drawGoblin(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 1.4, tile * 0.9, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Minions') {
      // Flying bat-imp. drawMinion internally handles the hover offset
      // (body floats 0.9*sc above gy, shadow stays on the ground at gy),
      // so we pass the ground point. HP bar sits above the floating body.
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markMinion(u.id);
      drawMinion(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 2.2, tile * 1.0, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Musketeer') {
      // Heroine in a teal coat + tricorn hat with gold-and-orange plume,
      // bright orange ponytail. Three-phase fire animation with a big
      // additive muzzle flash on STRIKE. HP bar uses the Knight-height
      // family (tile * 2.35 offset, tile * 1.4 width) per the spec.
      const p = getAnim(u, dtReal, findTarget(u.targetId));
      markMusketeer(u.id);
      drawMusketeer(ctx, sx(u.x), sy(u.y), tile, p);
      barNum(ctx, sx(u.x), sy(u.y) - tile * 2.35, tile * 1.4, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    if (u.card === 'Cannon') {
      // Defensive 3×3-tile mortar — short fat rotating barrel on a 2.5D
      // wooden trestle. drawCannon owns its own per-unit rig (separate Map
      // from troop anim) so it stays put across frames; we feed it the
      // target's screen position so the barrel can aim. The amber lifetime
      // warning is rendered ON the sprite (dim/amber wash in the last 6 s)
      // so we draw ONE bar here — the HP bar.
      const tgt = findTarget(u.targetId);
      const tgtSc = tgt ? { x: sx(tgt.x), y: sy(tgt.y) } : null;
      markCannon(u.id);
      drawCannon(ctx, sx(u.x), sy(u.y), tile, u, tgtSc, dtReal);
      // Sprite top sits ~sc * 1.20 above feet (sc = tile * 1.5 → tile * 1.8).
      // Pad ~0.5 tile so the HP bar floats just above the saddle's back edge.
      barNum(ctx, sx(u.x), sy(u.y) - tile * 2.3, tile * 2.2, u.hp / u.maxHp, 0, tile, u.owner);
      continue;
    }
    const c = u.owner === 0 ? COL.p0 : COL.p1;
    const edge = u.owner === 0 ? COL.p0dim : COL.p1dim;
    const r = unitRadius(u.maxHp) * tile;
    const x = sx(u.x);
    const y = sy(u.y);

    if (u.flying) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.7, r * 0.9, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const drawY = u.flying ? y - r * 0.6 : y;

    ctx.fillStyle = c;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2;
    const vis = CARD_VIS[u.card] || { shape: 'melee' };
    if (vis.shape === 'tank') {
      ctx.beginPath();
      ctx.arc(x, drawY, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.arc(x, drawY, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    } else if (vis.shape === 'air') {
      ctx.beginPath();
      ctx.moveTo(x, drawY - r);
      ctx.lineTo(x + r, drawY);
      ctx.lineTo(x, drawY + r);
      ctx.lineTo(x - r, drawY);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else if (vis.shape === 'ranged') {
      ctx.beginPath();
      ctx.arc(x, drawY, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(x, drawY, r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, drawY, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }

    if (u.deployTimer > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, drawY, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#06121e';
    ctx.font = `bold ${Math.round(Math.max(9, r * 0.95))}px ui-monospace,monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(vis.label || u.card[0], x, drawY);
    ctx.textBaseline = 'alphabetic';

    barNum(ctx, x, drawY - r - 6, Math.max(r * 2.2, tile * 1.1), u.hp / u.maxHp, 0, tile, u.owner);
  }

  // death poofs for vanished Knights (engine sweeps dead units same tick)
  sweepAnim(state, dtReal);
  drawDeathPoofs(ctx, sx, sy, tile);

  // ── projectiles (arrows, bullets, in-flight spells) ───────────────────────
  for (const p of state.projectiles) {
    const c = p.owner === 0 ? COL.p0 : COL.p1;
    const px = sx(p.x);
    const py = sy(p.y);
    if (p.kind === 'spell') {
      // Dispatch on the spell's card name so each spell can render its own
      // bespoke in-flight projectile. Travel angle is computed from the aim
      // point in screen space (game y is flipped in sy(), so we use screen
      // deltas to keep the nose pointing along the actual visible vector).
      const ang = Math.atan2(sy(p.ty) - py, sx(p.tx) - px);
      if (p.card === 'Fireball') {
        drawFireballProjectile(ctx, px, py, ang, tile, performance.now() / 1000);
      } else if (p.card === 'Arrows') {
        // Tight wedge-bundle of 7 arrows with motion-blur streaks; flat
        // (non-additive) since this is a physical payload, not energy.
        drawArrowsProjectile(ctx, px, py, ang, tile, performance.now() / 1000);
      } else {
        // Generic orange ball fallback for any unknown spell card.
        ctx.fillStyle = 'rgba(255,150,30,0.9)';
        ctx.strokeStyle = 'rgba(255,210,90,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, tile * 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      // Find the homing target so we can orient any bolt rendering toward it.
      let tgt = null;
      for (const u of state.units) if (u.id === p.targetId) { tgt = u; break; }
      if (!tgt) for (const t of state.towers) if (t.id === p.targetId) { tgt = t; break; }

      if (p.src && p.src.card === 'Archers') {
        // Detailed wooden arrow with steel head, fletching and motion streak.
        // Screen-space angle: game y is flipped (sy(y) = ... - y * tile), so
        // pointing +y in world maps to -y on screen. Compute the screen-delta
        // directly from target screen position so the arrow's nose lines up
        // with the homing tracer regardless of axis flips.
        let ang = 0;
        if (tgt) {
          const dxS = sx(tgt.x) - px, dyS = sy(tgt.y) - py;
          ang = Math.atan2(dyS, dxS);
        }
        drawArrow(ctx, px, py, ang, tile, { motion: true });
      } else if (p.src && p.src.card === 'Minions') {
        // Short-range dark spit glob with a trailing droplet smear and a
        // wet-shine specular catch. Same screen-space angle math as the
        // Archer arrow (game y is flipped in sy()).
        let ang = 0;
        if (tgt) {
          const dxS = sx(tgt.x) - px, dyS = sy(tgt.y) - py;
          ang = Math.atan2(dyS, dxS);
        }
        drawMinionSpit(ctx, px, py, ang, tile, {});
      } else if (p.src && p.src.card === 'Musketeer') {
        // Fast bullet with a brass-gold tip, white-hot additive leading
        // edge, long gold/white motion-blur streak, and a faint trailing
        // smoke trail. Same screen-space angle math as the other bolts.
        let ang = 0;
        if (tgt) {
          const dxS = sx(tgt.x) - px, dyS = sy(tgt.y) - py;
          ang = Math.atan2(dyS, dxS);
        }
        drawMusketBullet(ctx, px, py, ang, tile, {});
      } else if (p.src && p.src.card === 'Cannon') {
        // Heavy iron cannonball with a brass-gold heated leading edge,
        // a smoke trail and a short motion-blur streak. Travels straight,
        // homing on its target. Same screen-space angle math as other bolts.
        let ang = 0;
        if (tgt) {
          const dxS = sx(tgt.x) - px, dyS = sy(tgt.y) - py;
          ang = Math.atan2(dyS, dxS);
        }
        drawCannonball(ctx, px, py, ang, tile, { motion: true });
      } else {
        // Fallback for tower bolts, etc.: short tracer pointing toward
        // the (homing) target + white tip dot. Tower shots have p.src._tower
        // (no p.src.card) so they fall through this branch.
        if (tgt) {
          const dx = tgt.x - p.x, dy = tgt.y - p.y;
          const L = Math.hypot(dx, dy) || 1;
          ctx.strokeStyle = c;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px - (dx / L) * tile * 0.5, py + (dy / L) * tile * 0.5);
          ctx.lineTo(px, py);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px, py, tile * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function barNum(ctx, cx, top, w, frac, num, tile, owner) {
  frac = Math.max(0, Math.min(1, frac));
  const x = cx - w / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x - 1, top - 1, w + 2, 6);
  ctx.fillStyle = owner === 0 ? COL.p0 : COL.p1;
  ctx.fillRect(x, top, w * frac, 4);
  if (num) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.round(tile * 0.5)}px ui-monospace,monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(num, cx, top - 4);
  }
}

function beam(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}
