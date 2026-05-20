// Procedural Clash-Royale-style arena background, emitted as a static SVG per
// animation frame. The bake tool renders frame 0..N-1 to PNGs; the viewer just
// blits the looping sequence behind the live units.
//
// Projection: orthographic top-down (the units' ground plane). "2.5D" depth is
// sold the same way the unit sprites do it — standing props with cast shadows,
// a thick beveled platform, light from the upper-left — NOT a perspective skew
// (a skew would break the linear world->screen mapping the engine relies on).
//
// Geometry is derived from CONFIG + padPx so the field/river/bridges line up
// pixel-perfectly with what renderer.js draws on top.
//
// resvg-safe: shapes, gradients, clipPaths only. No SMIL/CSS/filters/text —
// every animated quantity is a frame-periodic function so the 48-frame
// sequence loops seamlessly, and all "scatter" detail is seeded so it is
// identical on every frame (only intended motion moves).

import { CONFIG } from '../src/config.js';
import { padPx } from '../src/arena-geom.js';

export const TILE = 22; // keep in sync with src/main.js

export function geometry() {
  const A = CONFIG.arena;
  const PAD = padPx(TILE);
  const W = A.width * TILE, H = A.height * TILE;
  const CW = W + PAD * 2, CH = H + PAD * 2;
  const sx = (x) => PAD + x * TILE;
  const sy = (y) => PAD + H - y * TILE;
  return {
    A, PAD, TILE, W, H, CW, CH, sx, sy,
    fieldX: sx(0), fieldY: sy(A.height), fieldW: W, fieldH: H,
    riv: { top: sy(A.river[1]), bot: sy(A.river[0]) },
    bridges: A.bridges.map((bx) => ({ cx: sx(bx), hw: A.bridgeHalfWidth * TILE })),
    mid: sy(A.mid),
  };
}

const TAU = Math.PI * 2;
const n = (v) => Math.round(v * 100) / 100;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// periodic helpers — integer `f` over t in [0,1] guarantees a seamless loop
const wave = (t, f, ph) => Math.sin(TAU * (f * t + ph));
const wave01 = (t, f, ph) => 0.5 + 0.5 * Math.sin(TAU * (f * t + ph));

// A horizontally-scrolling wavy band (the river ripple ribbon). The pattern
// has spatial period `len`; scrolling by exactly `len` over the loop wraps
// seamlessly. Sampled coarsely — plenty for water at this scale.
function rippleBand(x0, x1, yc, amp, len, t, speed, thick) {
  const sh = (t * speed * len) % len;
  const step = 12;
  const top = [], bot = [];
  for (let x = x0 - len; x <= x1 + len; x += step) {
    const a = ((x + sh) / len) * TAU;
    top.push(`${n(x)},${n(yc - thick / 2 + Math.sin(a) * amp)}`);
    bot.push(`${n(x)},${n(yc + thick / 2 + Math.sin(a + 1.7) * amp * 0.8)}`);
  }
  bot.reverse();
  return `M${top.join(' L')} L${bot.join(' L')} Z`;
}

function wavyLine(x0, x1, yc, amp, len, t, speed) {
  const sh = (t * speed * len) % len;
  const pts = [];
  for (let x = x0; x <= x1; x += 14) {
    const a = ((x + sh) / len) * TAU;
    pts.push(`${n(x)},${n(yc + Math.sin(a) * amp)}`);
  }
  return `M${pts.join(' L')}`;
}

function shadowEllipse(cx, cy, rx, ry, a = 0.3) {
  return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="rgba(0,0,0,${a})"/>`;
}

// ── standing props (2.5D: top + body faces, down-right shadow) ──────────────

function barrel(x, y, w, h) {
  const s = [];
  s.push(shadowEllipse(x + w * 0.55, y + h * 0.06, w * 0.62, h * 0.16, 0.3));
  s.push(`<rect x="${n(x - w / 2)}" y="${n(y - h)}" width="${n(w)}" height="${n(h)}" rx="${n(w * 0.18)}" fill="url(#woodV)"/>`);
  for (let i = 1; i < 4; i++) {
    const lx = x - w / 2 + (w * i) / 4;
    s.push(`<line x1="${n(lx)}" y1="${n(y - h + 3)}" x2="${n(lx)}" y2="${n(y - 3)}" stroke="rgba(40,22,8,0.35)" stroke-width="1.5"/>`);
  }
  for (const hy of [y - h * 0.78, y - h * 0.5, y - h * 0.22]) {
    s.push(`<rect x="${n(x - w / 2 - 1)}" y="${n(hy)}" width="${n(w + 2)}" height="3.5" rx="1.5" fill="#3f3a33"/>`);
  }
  s.push(`<ellipse cx="${n(x)}" cy="${n(y - h)}" rx="${n(w / 2)}" ry="${n(w * 0.2)}" fill="#9a6c3c"/>`);
  s.push(`<ellipse cx="${n(x)}" cy="${n(y - h)}" rx="${n(w * 0.34)}" ry="${n(w * 0.13)}" fill="#7a5230"/>`);
  return s.join('');
}

function crate(x, y, s) {
  const o = [];
  o.push(shadowEllipse(x + s * 0.5, y + s * 0.05, s * 0.7, s * 0.18, 0.28));
  o.push(`<rect x="${n(x - s / 2)}" y="${n(y - s)}" width="${n(s)}" height="${n(s)}" rx="3" fill="url(#woodV)"/>`);
  o.push(`<rect x="${n(x - s / 2)}" y="${n(y - s)}" width="${n(s)}" height="${n(s)}" rx="3" fill="none" stroke="#5e3c20" stroke-width="2.5"/>`);
  o.push(`<path d="M${n(x - s / 2)},${n(y - s)} L${n(x + s / 2)},${n(y)} M${n(x + s / 2)},${n(y - s)} L${n(x - s / 2)},${n(y)}" stroke="#6b471f" stroke-width="2"/>`);
  return o.join('');
}

function bush(x, y, r) {
  const o = [];
  o.push(shadowEllipse(x + r * 0.4, y + 2, r * 1.05, r * 0.34, 0.26));
  for (const [dx, dy, rr, c] of [
    [-r * 0.5, 0, r * 0.7, '#356a2c'], [r * 0.5, 0, r * 0.7, '#356a2c'],
    [0, -r * 0.5, r * 0.8, '#4f9040'], [-r * 0.2, -r * 0.2, r * 0.6, '#5aa049'],
  ]) o.push(`<circle cx="${n(x + dx)}" cy="${n(y - r * 0.5 + dy)}" r="${n(rr)}" fill="${c}"/>`);
  o.push(`<ellipse cx="${n(x - r * 0.25)}" cy="${n(y - r * 0.9)}" rx="${n(r * 0.34)}" ry="${n(r * 0.22)}" fill="rgba(255,255,255,0.16)"/>`);
  return o.join('');
}

// Wall-mounted torch with a seamlessly-flickering flame + soft glow halo.
function torch(x, y, t, seed) {
  const fl = 0.78
    + 0.22 * wave01(t, 2, seed * 0.13)
    + 0.12 * wave(t, 5, seed * 0.31)
    + 0.07 * wave(t, 8, seed * 0.7);
  const f = clamp(fl, 0.55, 1.18);
  const sway = wave(t, 3, seed * 0.5) * 2.4;
  const fh = 26 * f, fw = 11 * (2 - f) * 0.8;
  const g = [];
  g.push(`<circle cx="${n(x)}" cy="${n(y - 14)}" r="${n(34 * f)}" fill="url(#glow)" opacity="${n(0.5 * f)}"/>`);
  g.push(`<rect x="${n(x - 3)}" y="${n(y - 6)}" width="6" height="22" rx="2" fill="#5a3c20"/>`);
  g.push(`<ellipse cx="${n(x)}" cy="${n(y - 6)}" rx="7" ry="4" fill="#3a3a3a"/>`);
  g.push(`<path d="M${n(x)},${n(y - 8 - fh)} Q${n(x + sway + fw)},${n(y - 8 - fh * 0.45)} ${n(x)},${n(y - 6)} Q${n(x - fw)},${n(y - 8 - fh * 0.45)} ${n(x)},${n(y - 8 - fh)} Z" fill="#ff6a1f"/>`);
  g.push(`<path d="M${n(x)},${n(y - 8 - fh * 0.82)} Q${n(x + sway * 0.6 + fw * 0.6)},${n(y - 8 - fh * 0.4)} ${n(x)},${n(y - 7)} Q${n(x - fw * 0.6)},${n(y - 8 - fh * 0.4)} ${n(x)},${n(y - 8 - fh * 0.82)} Z" fill="#ffb23e"/>`);
  g.push(`<path d="M${n(x)},${n(y - 8 - fh * 0.55)} Q${n(x + sway * 0.4 + fw * 0.32)},${n(y - 8 - fh * 0.26)} ${n(x)},${n(y - 8)} Q${n(x - fw * 0.32)},${n(y - 8 - fh * 0.26)} ${n(x)},${n(y - 8 - fh * 0.55)} Z" fill="#fff1b0"/>`);
  return g.join('');
}

// A hanging team pennant that sways (free tip swings on the breeze).
function pennant(x, y, w, h, color, t, ph, dir = 1) {
  const sw = wave(t, 2, ph) * 5 * dir;
  const sw2 = wave(t, 2, ph + 0.25) * 7 * dir;
  return `<path d="M${n(x)},${n(y)} L${n(x + w)},${n(y + 2)} `
    + `Q${n(x + w * 0.5 + sw)},${n(y + h * 0.5)} ${n(x + w + sw2)},${n(y + h)} `
    + `L${n(x + sw2 * 0.7)},${n(y + h - 1)} Z" fill="${color}"/>`
    + `<rect x="${n(x - 2)}" y="${n(y - 4)}" width="3.5" height="${n(h + 10)}" rx="1.5" fill="#4a3a26"/>`
    + `<circle cx="${n(x - 0.2)}" cy="${n(y - 5)}" r="3" fill="#e8c25a"/>`;
}

// Corner flag on a tall pole, rippling.
function cornerFlag(x, y, color, t, ph) {
  const seg = [];
  for (let i = 0; i <= 6; i++) {
    const fx = x + (i / 6) * 34;
    const fy = y + Math.sin(TAU * (2 * t + ph + i * 0.16)) * (1.5 + i * 1.1);
    seg.push(`${n(fx)},${n(fy)}`);
  }
  const bot = [];
  for (let i = 6; i >= 0; i--) {
    const fx = x + (i / 6) * 34;
    const fy = y + 13 + Math.sin(TAU * (2 * t + ph + i * 0.16)) * (1.2 + i * 1.0);
    bot.push(`${n(fx)},${n(fy)}`);
  }
  return `<rect x="${n(x - 2.5)}" y="${n(y - 30)}" width="5" height="78" rx="2.5" fill="#4a3a26"/>`
    + `<circle cx="${n(x)}" cy="${n(y - 32)}" r="4.5" fill="#e8c25a"/>`
    + `<polygon points="${seg.concat(bot).join(' ')}" fill="${color}"/>`
    + `<polyline points="${seg.join(' ')}" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>`;
}

// One arc of stadium spectators (heads + shoulders), gently bobbing/cheering.
function crowdRow(x0, x1, y, pool, prng, t, rowPh) {
  const o = [];
  const gap = 15;
  let i = 0;
  for (let x = x0; x <= x1; x += gap) {
    const jx = (prng() - 0.5) * 5;
    const bob = Math.sin(TAU * (2 * t + rowPh + i * 0.4)) * 2.0
      + Math.sin(TAU * (4 * t + i * 0.9)) * 0.8;
    const cy = y + bob;
    const body = pool[(prng() * pool.length) | 0];
    const skin = ['#e8b88f', '#caa078', '#a87a52', '#f0cba0'][(prng() * 4) | 0];
    o.push(`<ellipse cx="${n(x + jx)}" cy="${n(cy + 7)}" rx="7.5" ry="8" fill="${body}"/>`);
    o.push(`<circle cx="${n(x + jx)}" cy="${n(cy)}" r="5.2" fill="${skin}"/>`);
    if (prng() < 0.16) { // a few wave little flags
      const fc = prng() < 0.5 ? '#e8c25a' : body;
      const fx = x + jx + 7, fy = cy - 9 + Math.sin(TAU * (3 * t + i)) * 2;
      o.push(`<rect x="${n(fx)}" y="${n(fy)}" width="2" height="13" fill="#4a3a26"/>`);
      o.push(`<path d="M${n(fx + 2)},${n(fy)} L${n(fx + 11)},${n(fy + 3)} L${n(fx + 2)},${n(fy + 7)} Z" fill="${fc}"/>`);
    }
    i++;
  }
  return o.join('');
}

// ── the scene ───────────────────────────────────────────────────────────────

export function buildSvg(frame, frames) {
  const g = geometry();
  const { PAD, CW, CH, fieldX, fieldY, fieldW, fieldH, riv, bridges, mid } = g;
  const t = frame / frames;
  const prng = mulberry32(0x9e3779b1); // fixed -> static detail never boils

  const FX1 = fieldX + fieldW, FY1 = fieldY + fieldH;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">`);

  // ---- defs ----
  out.push('<defs>');
  out.push(`<radialGradient id="outer" cx="50%" cy="46%" r="72%">`
    + `<stop offset="0%" stop-color="#16312a"/><stop offset="55%" stop-color="#0e201c"/>`
    + `<stop offset="100%" stop-color="#060d0b"/></radialGradient>`);
  out.push(`<linearGradient id="water" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="#1c6f86"/><stop offset="22%" stop-color="#39a7c6"/>`
    + `<stop offset="50%" stop-color="#2d88aa"/><stop offset="78%" stop-color="#39a7c6"/>`
    + `<stop offset="100%" stop-color="#1c6f86"/></linearGradient>`);
  out.push(`<linearGradient id="stone" x1="0" y1="0" x2="0.3" y2="1">`
    + `<stop offset="0%" stop-color="#8b968b"/><stop offset="45%" stop-color="#6c766d"/>`
    + `<stop offset="100%" stop-color="#49514a"/></linearGradient>`);
  out.push(`<linearGradient id="woodV" x1="0" y1="0" x2="1" y2="0">`
    + `<stop offset="0%" stop-color="#7a5230"/><stop offset="50%" stop-color="#9a6c3c"/>`
    + `<stop offset="100%" stop-color="#6e4a2a"/></linearGradient>`);
  out.push(`<linearGradient id="plankA" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="#a5743f"/><stop offset="100%" stop-color="#8a5c30"/></linearGradient>`);
  out.push(`<linearGradient id="plankB" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="#8c5e31"/><stop offset="100%" stop-color="#754c27"/></linearGradient>`);
  out.push(`<radialGradient id="glow" cx="50%" cy="50%" r="50%">`
    + `<stop offset="0%" stop-color="#ffcf73"/><stop offset="45%" stop-color="rgba(255,150,40,0.55)"/>`
    + `<stop offset="100%" stop-color="rgba(255,120,20,0)"/></radialGradient>`);
  out.push(`<radialGradient id="fieldVig" cx="50%" cy="50%" r="62%">`
    + `<stop offset="0%" stop-color="rgba(0,0,0,0)"/><stop offset="78%" stop-color="rgba(0,0,0,0)"/>`
    + `<stop offset="100%" stop-color="rgba(15,30,12,0.4)"/></radialGradient>`);
  out.push(`<clipPath id="fieldClip"><rect x="${fieldX}" y="${fieldY}" width="${fieldW}" height="${fieldH}"/></clipPath>`);
  out.push(`<clipPath id="rivClip"><rect x="${fieldX}" y="${n(riv.top)}" width="${fieldW}" height="${n(riv.bot - riv.top)}"/></clipPath>`);
  out.push('</defs>');

  // ---- outer environment ----
  out.push(`<rect width="${CW}" height="${CH}" fill="url(#outer)"/>`);
  for (let i = 0; i < 90; i++) { // static dirt/rubble speckle around the platform
    const ex = prng() * CW, ey = prng() * CH;
    if (ex > PAD - 6 && ex < CW - PAD + 6 && ey > PAD - 6 && ey < CH - PAD + 6) continue;
    const r = 3 + prng() * 9;
    out.push(`<ellipse cx="${n(ex)}" cy="${n(ey)}" rx="${n(r)}" ry="${n(r * 0.6)}" fill="rgba(${20 + prng() * 30 | 0},${40 + prng() * 30 | 0},${28 + prng() * 20 | 0},0.5)"/>`);
  }

  // ---- crowd stands (top = P1/red side, bottom = P0/blue side) ----
  const standY0 = 8, standH = PAD - 16;
  const redPool = ['#e2645c', '#f0917f', '#c24a44', '#e8a24a', '#f3d7cb', '#b85c8a'];
  const bluePool = ['#4f93e6', '#6fb0f0', '#3f6fb0', '#7ec8d6', '#cfe2f5', '#6a8fd0'];
  // back wall + tiered base
  out.push(`<rect x="${PAD - 6}" y="${standY0}" width="${CW - PAD * 2 + 12}" height="${standH}" rx="6" fill="#3b3530"/>`);
  out.push(`<rect x="${PAD - 6}" y="${n(CH - PAD + 8)}" width="${CW - PAD * 2 + 12}" height="${standH}" rx="6" fill="#3b3530"/>`);
  for (let r = 0; r < 3; r++) {
    out.push(crowdRow(PAD + 4, CW - PAD - 4, standY0 + 11 + r * 13, redPool, prng, t, r * 0.33));
  }
  for (let r = 0; r < 3; r++) {
    out.push(crowdRow(PAD + 4, CW - PAD - 4, CH - PAD + 14 + r * 13, bluePool, prng, t, r * 0.27 + 0.5));
  }
  // striped awning lips in team colours (gentle breathing)
  const aw = 3 + wave(t, 2, 0) * 1.2;
  let awn = `<g>`;
  for (let x = PAD - 6, k = 0; x < CW - PAD + 6; x += 22, k++) {
    awn += `<path d="M${n(x)},${n(standY0 + standH)} q11,${n(7 + aw)} 22,0 Z" fill="${k % 2 ? '#c24a44' : '#e2645c'}"/>`;
    awn += `<path d="M${n(x)},${n(CH - PAD + 8 + standH)} q11,${n(7 + aw)} 22,0 Z" fill="${k % 2 ? '#3f6fb0' : '#4f93e6'}"/>`;
  }
  out.push(awn + `</g>`);

  // ---- stone platform frame (beveled, masonry) ----
  const fo = 6;
  out.push(`<rect x="${fo}" y="${fo}" width="${CW - fo * 2}" height="${CH - fo * 2}" rx="26" fill="#2b322c"/>`);
  out.push(`<rect x="${PAD - 26}" y="${PAD - 26}" width="${fieldW + 52}" height="${fieldH + 52}" rx="20" fill="url(#stone)"/>`);
  // masonry seams on the ring
  let seams = `<g stroke="rgba(30,38,30,0.5)" stroke-width="2" fill="none">`;
  for (let x = PAD - 20; x < FX1 + 20; x += 34) {
    seams += `<line x1="${n(x)}" y1="${PAD - 26}" x2="${n(x)}" y2="${n(PAD - 6)}"/>`;
    seams += `<line x1="${n(x + 17)}" y1="${n(FY1 + 6)}" x2="${n(x + 17)}" y2="${n(FY1 + 26)}"/>`;
  }
  for (let y = PAD - 20; y < FY1 + 20; y += 34) {
    seams += `<line x1="${PAD - 26}" y1="${n(y)}" x2="${n(PAD - 6)}" y2="${n(y)}"/>`;
    seams += `<line x1="${n(FX1 + 6)}" y1="${n(y + 17)}" x2="${n(FX1 + 26)}" y2="${n(y + 17)}"/>`;
  }
  out.push(seams + `</g>`);
  // bevel highlight (upper-left) + shade (lower-right)
  out.push(`<rect x="${PAD - 26}" y="${PAD - 26}" width="${fieldW + 52}" height="${fieldH + 52}" rx="20" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="3"/>`);
  out.push(`<path d="M${PAD - 8},${n(FY1 + 8)} L${n(FX1 + 8)},${n(FY1 + 8)} L${n(FX1 + 8)},${PAD - 8}" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="5"/>`);
  // inner groove + field drop-shadow
  out.push(`<rect x="${fieldX - 7}" y="${fieldY - 7}" width="${fieldW + 14}" height="${fieldH + 14}" rx="6" fill="#2a322d"/>`);
  out.push(`<rect x="${fieldX - 3}" y="${fieldY - 3}" width="${fieldW + 6}" height="${fieldH + 6}" fill="rgba(0,0,0,0.32)"/>`);

  // ---- grass field (Clash-Royale tiled checkerboard) ----
  const A = g.A;
  const F = [];
  F.push(`<g clip-path="url(#fieldClip)">`);
  F.push(`<rect x="${fieldX}" y="${fieldY}" width="${fieldW}" height="${fieldH}" fill="#56983f"/>`);
  // checker cells locked to the gameplay grid (this IS the CR look)
  for (let gy = 0; gy < A.height; gy++) {
    const up = gy + 0.5 >= A.mid; // player-1 (top) half
    for (let gx = 0; gx < A.width; gx++) {
      const light = ((gx + gy) & 1) === 0;
      const col = up
        ? (light ? '#5aa044' : '#52923b')
        : (light ? '#60a749' : '#56983f');
      F.push(`<rect x="${n(g.sx(gx))}" y="${n(g.sy(gy + 1))}" width="${TILE + 0.5}" height="${TILE + 0.5}" fill="${col}"/>`);
    }
  }
  // crisp tile seams + a soft upper-left quilt highlight (manicured 2.5D lawn)
  let seamD = '', hiD = '';
  for (let gx = 0; gx <= A.width; gx++) {
    const x = n(g.sx(gx));
    seamD += `M${x} ${n(fieldY)}V${n(FY1)}`;
    hiD += `M${x + 1} ${n(fieldY)}V${n(FY1)}`;
  }
  for (let gy = 0; gy <= A.height; gy++) {
    const y = n(g.sy(gy));
    seamD += `M${n(fieldX)} ${y}H${n(FX1)}`;
    hiD += `M${n(fieldX)} ${y + 1}H${n(FX1)}`;
  }
  F.push(`<path d="${hiD}" stroke="rgba(255,255,255,0.05)" stroke-width="1" fill="none"/>`);
  F.push(`<path d="${seamD}" stroke="rgba(20,46,16,0.12)" stroke-width="1" fill="none"/>`);
  // sparse seeded tufts/pebbles for organic life (kept very subtle)
  for (let i = 0; i < 80; i++) {
    const px = fieldX + prng() * fieldW, py = fieldY + prng() * fieldH;
    if (py > riv.top - 8 && py < riv.bot + 8) continue;
    if (prng() < 0.72) {
      F.push(`<path d="M${n(px)},${n(py)} q-2,-5 -3,-8 M${n(px)},${n(py)} q1,-6 1,-9 M${n(px)},${n(py)} q3,-5 4,-8" stroke="rgba(26,54,18,0.16)" stroke-width="1.2" fill="none"/>`);
    } else {
      F.push(`<ellipse cx="${n(px)}" cy="${n(py)}" rx="${n(2 + prng() * 2.5)}" ry="${n(1.4 + prng() * 1.6)}" fill="rgba(120,120,108,0.18)"/>`);
    }
  }
  // faint team wash near each back line
  F.push(`<rect x="${fieldX}" y="${fieldY}" width="${fieldW}" height="120" fill="rgba(226,87,79,0.06)"/>`);
  F.push(`<rect x="${fieldX}" y="${n(FY1 - 120)}" width="${fieldW}" height="120" fill="rgba(79,147,230,0.06)"/>`);
  F.push(`<rect x="${fieldX}" y="${fieldY}" width="${fieldW}" height="${fieldH}" fill="url(#fieldVig)"/>`);
  F.push(`</g>`);
  out.push(F.join(''));

  // ---- river (animated flow) ----
  const R = [];
  R.push(`<g clip-path="url(#rivClip)">`);
  const rc = (riv.top + riv.bot) / 2, rh = riv.bot - riv.top;
  R.push(`<rect x="${fieldX}" y="${n(riv.top)}" width="${fieldW}" height="${n(rh)}" fill="url(#water)"/>`);
  // deep current ribbons (parallax: different speeds/lengths)
  R.push(`<path d="${rippleBand(fieldX, FX1, rc - rh * 0.18, 3.2, 150, t, 1, rh * 0.5)}" fill="rgba(10,55,72,0.22)"/>`);
  R.push(`<path d="${rippleBand(fieldX, FX1, rc + rh * 0.16, 3.6, 190, t, 1, rh * 0.55)}" fill="rgba(190,238,250,0.16)"/>`);
  // crest lines
  for (const [yo, am, ln, sp, op, w] of [
    [-10, 2.6, 120, 1, 0.30, 2], [-3, 3.0, 160, 1, 0.22, 1.5],
    [4, 2.4, 140, 1, 0.34, 2], [11, 3.2, 180, 1, 0.20, 1.5],
  ]) {
    R.push(`<path d="${wavyLine(fieldX, FX1, rc + yo, am, ln, t, sp)}" fill="none" stroke="rgba(225,248,255,${op})" stroke-width="${w}" stroke-linecap="round"/>`);
  }
  // drifting sparkles (seeded, twinkle + wrap seamlessly)
  for (let i = 0; i < 46; i++) {
    const bx = prng() * fieldW, by = riv.top + 4 + prng() * (rh - 8);
    const x = fieldX + ((bx + t * fieldW) % fieldW);
    const tw = Math.pow(wave01(t, 2 + ((i % 3) | 0), prng()), 2);
    R.push(`<ellipse cx="${n(x)}" cy="${n(by)}" rx="${n(2 + tw * 3)}" ry="1.2" fill="rgba(255,255,255,${n(0.15 + tw * 0.55)})"/>`);
  }
  // muddy banks + animated foam
  R.push(`<rect x="${fieldX}" y="${n(riv.top - 4)}" width="${fieldW}" height="5" fill="#7e6a3c"/>`);
  R.push(`<rect x="${fieldX}" y="${n(riv.bot - 1)}" width="${fieldW}" height="5" fill="#7e6a3c"/>`);
  R.push(`<path d="${wavyLine(fieldX, FX1, riv.top + 1.5, 1.6, 90, t, 1)}" fill="none" stroke="rgba(244,252,255,0.6)" stroke-width="2.4"/>`);
  R.push(`<path d="${wavyLine(fieldX, FX1, riv.bot - 1.5, 1.6, 90, t, 1)}" fill="none" stroke="rgba(244,252,255,0.55)" stroke-width="2.4"/>`);
  R.push(`</g>`);
  out.push(R.join(''));

  // ---- wooden bridges ----
  for (const b of bridges) {
    const x0 = b.cx - b.hw, bw = b.hw * 2;
    out.push(`<rect x="${n(x0 + 5)}" y="${n(riv.top)}" width="${n(bw)}" height="${n(rh)}" fill="rgba(0,0,0,0.22)"/>`); // cast on water
    out.push(`<rect x="${n(x0 - 4)}" y="${n(riv.top - 7)}" width="${n(bw + 8)}" height="9" rx="2" fill="#6d6450"/>`);
    out.push(`<rect x="${n(x0 - 4)}" y="${n(riv.bot - 2)}" width="${n(bw + 8)}" height="9" rx="2" fill="#5f5746"/>`);
    const planks = 7;
    for (let p = 0; p < planks; p++) {
      const py = riv.top + (rh * p) / planks;
      out.push(`<rect x="${n(x0)}" y="${n(py)}" width="${n(bw)}" height="${n(rh / planks + 0.6)}" fill="url(#${p % 2 ? 'plankB' : 'plankA'})"/>`);
      out.push(`<line x1="${n(x0)}" y1="${n(py)}" x2="${n(x0 + bw)}" y2="${n(py)}" stroke="rgba(38,22,8,0.5)" stroke-width="1"/>`);
      if (p % 2 === 0) out.push(`<circle cx="${n(x0 + bw * (0.3 + p * 0.07))}" cy="${n(py + rh / planks / 2)}" r="1.6" fill="rgba(60,38,18,0.5)"/>`);
    }
    out.push(`<rect x="${n(x0 - 3)}" y="${n(riv.top)}" width="4" height="${n(rh)}" fill="#5c3a1f"/>`);
    out.push(`<rect x="${n(x0 + bw - 1)}" y="${n(riv.top)}" width="4" height="${n(rh)}" fill="#5c3a1f"/>`);
    for (let py = riv.top + 3; py < riv.bot; py += 11) {
      out.push(`<rect x="${n(x0 - 4)}" y="${n(py)}" width="6" height="4" rx="1" fill="#6e4827"/>`);
      out.push(`<rect x="${n(x0 + bw - 2)}" y="${n(py)}" width="6" height="4" rx="1" fill="#6e4827"/>`);
    }
    out.push(`<rect x="${n(x0)}" y="${n(riv.top)}" width="${n(bw)}" height="3" fill="rgba(255,255,255,0.14)"/>`);
  }

  // ---- side dressing on the platform ring (props never enter the field) ----
  const props = [];
  // left & right hung pennants, alternating team colours, swaying
  for (let i = 0, y = PAD + 30; y < FY1 - 40; y += 96, i++) {
    const cL = i % 2 ? '#e2574f' : '#3f86d8';
    const cR = i % 2 ? '#3f86d8' : '#e2574f';
    props.push(pennant(PAD - 40, y, 26, 34, cL, t, i * 0.2, 1));
    props.push(pennant(FX1 + 14, y, 26, 34, cR, t, i * 0.2 + 0.5, -1));
  }
  // torches down the sides
  for (let y = PAD + 70, k = 0; y < FY1 - 50; y += 150, k++) {
    props.push(torch(PAD - 18, y, t, k + 1));
    props.push(torch(FX1 + 18, y, t, k + 3.3));
  }
  // barrels / crates / topiary tucked in the ring
  props.push(barrel(PAD - 34, FY1 - 16, 26, 34));
  props.push(barrel(PAD - 60, FY1 - 22, 22, 28));
  props.push(crate(FX1 + 40, FY1 - 14, 30));
  props.push(barrel(FX1 + 30, PAD + 40, 24, 32));
  props.push(crate(PAD - 44, PAD + 30, 26));
  props.push(bush(PAD - 38, mid - 26, 18));
  props.push(bush(FX1 + 40, mid + 30, 18));
  props.push(bush(PAD - 40, FY1 - 70, 16));
  // corner stone caps + rippling flags
  for (const [cx, cy, fc, ph] of [
    [PAD - 30, PAD - 30, '#e2574f', 0], [FX1 + 30, PAD - 30, '#e2574f', 0.5],
    [PAD - 30, FY1 + 30, '#3f86d8', 0.25], [FX1 + 30, FY1 + 30, '#3f86d8', 0.75],
  ]) {
    props.push(`<rect x="${n(cx - 17)}" y="${n(cy - 17)}" width="34" height="34" rx="6" fill="url(#stone)" stroke="rgba(0,0,0,0.3)" stroke-width="2"/>`);
    props.push(`<rect x="${n(cx - 17)}" y="${n(cy - 17)}" width="34" height="34" rx="6" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>`);
    props.push(cornerFlag(cx, cy, fc, t, ph));
  }
  out.push(props.join(''));

  out.push('</svg>');
  return out.join('');
}
