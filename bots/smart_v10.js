// smart v10 — the CURRENT promoted champion logic. v8's measured-good core
// plus ONE mechanic-aware change: spells have real projectile travel time
// (they fly from my King tower), so aim where the enemy clump WILL be on
// impact, not where it is now. Result: spell waste 5.2%→2.4%, tower damage
// up, tempo/placement unchanged from v8. Clears the promotion gate (70% /
// 100% decided vs the old champion). `smart.js` and `champion.js` are this.
import { myUnits, enemyUnits, myTowers, enemyTowers } from './lib.js';

export default function smartV10(v) {
  const me = v.self;
  const E = me.elixir;
  const W = v.arena.width;
  const H = v.arena.height;
  const mid = v.arena.mid;
  const toward = me.id === 0 ? 1 : -1;
  const onMyHalf = (u) => (me.id === 0 ? u.y < mid + 3 : u.y > mid - 3);

  const enemies = enemyUnits(v);
  const mine = myUnits(v);
  const threat = enemies.filter(onMyHalf);
  const myTw = myTowers(v);
  const myPrincess = myTw.filter((t) => t.kind === 'princess');
  const enPrincess = enemyTowers(v).filter((t) => t.kind === 'princess');
  const myKing = myTw.find((t) => t.kind === 'king');

  const has = (c) => v.self.hand.find((h) => h.card === c) && E >= v.cards[c].cost;
  const sideOf = (x) => (x < W / 2 ? 'left' : 'right');
  const laneXof = (s) => (s === 'left' ? W * 0.22 : W * 0.78);
  const clampX = (x) => Math.max(1, Math.min(W - 1, x));
  const legalY = (yWant, side) => {
    const enP = enPrincess.find((t) => t.side === side);
    const opened = enP && enP.hp <= 0;
    if (me.id === 0) return Math.max(1, Math.min(yWant, opened ? H - 6 : mid - 0.5));
    return Math.min(H - 1, Math.max(yWant, opened ? 6 : mid + 0.5));
  };
  const troop = (card, x, side, yWant) => ({ card, x: clampX(x), y: legalY(yWant, side) });

  const tied = v.crowns.self === v.crowns.enemy;
  const closing = tied && (v.phase === 'overtime' || (v.phase === 'normal' && v.timeRemaining <= 20));

  // ── 1. Spells — lead the clump by the projectile's travel time ───────────
  const spellEta = (x, y, card) => {
    const sp = v.cards[card].projectileSpeed;
    if (!sp || !myKing) return 0;
    return Math.hypot(x - myKing.x, y - myKing.y) / sp;
  };
  const predict = (u, t) => {
    let tx = u.x, ty = u.y, bd = 1e9;
    for (const tw of myTw) {
      const d = Math.hypot(tw.x - u.x, tw.y - u.y);
      if (d < bd) { bd = d; tx = tw.x; ty = tw.y; }
    }
    const dx = tx - u.x, dy = ty - u.y;
    const L = Math.hypot(dx, dy) || 1;
    const step = Math.min((u.speed || 1) * t, L);
    return { x: u.x + (dx / L) * step, y: u.y + (dy / L) * step };
  };
  const spellClump = (radius, card) => {
    let best = null;
    for (const cand of enemies) {
      const t = spellEta(cand.x, cand.y, card);
      const cp = predict(cand, t);
      let val = 0, n = 0, sx = 0, sy = 0;
      for (const e of enemies) {
        if (e.maxHp >= 1500) continue; // skip tanks
        const ep = predict(e, t);
        if (Math.hypot(cp.x - ep.x, cp.y - ep.y) > radius) continue;
        val += e.maxHp; n++; sx += ep.x; sy += ep.y;
      }
      if (n && (!best || val > best.val)) best = { x: sx / n, y: sy / n, val, n };
    }
    return best;
  };
  const aimWithTower = (c, radius) => {
    let bestP = null, bd = 1e9;
    for (const t of enPrincess) {
      if (t.hp <= 0) continue;
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      if (d < bd) { bd = d; bestP = t; }
    }
    if (bestP && bd <= radius + 1.5) {
      const ax = (c.x + bestP.x) / 2;
      const ay = (c.y + bestP.y) / 2;
      if (Math.hypot(ax - c.x, ay - c.y) <= radius * 0.8) return { x: ax, y: ay };
    }
    return { x: c.x, y: c.y };
  };
  const lowEnP = enPrincess.filter((t) => t.hp > 0).sort((a, b) => a.hp - b.hp)[0];
  if (has('Fireball')) {
    const c = spellClump(v.cards.Fireball.radius, 'Fireball');
    if (c && (c.val >= 850 || c.n >= 3)) {
      const a = aimWithTower(c, v.cards.Fireball.radius);
      return { card: 'Fireball', x: a.x, y: a.y };
    }
    if (lowEnP && (lowEnP.hp <= v.cards.Fireball.towerDmg || (closing && E >= 8))) {
      return { card: 'Fireball', x: lowEnP.x, y: lowEnP.y };
    }
  }
  if (has('Arrows')) {
    const c = spellClump(v.cards.Arrows.radius, 'Arrows');
    if (c && c.n >= 3 && c.val >= 480) {
      const a = aimWithTower(c, v.cards.Arrows.radius);
      return { card: 'Arrows', x: a.x, y: a.y };
    }
    if (closing && lowEnP && lowEnP.hp <= v.cards.Arrows.towerDmg && E >= 7) {
      return { card: 'Arrows', x: lowEnP.x, y: lowEnP.y };
    }
  }

  // ── 2. Defend — synergy-correct counter, intercepting in tower range ─────
  if (threat.length) {
    const anyAir = threat.some((u) => u.flying);
    const tank = threat.find((u) => u.maxHp >= 1500);
    threat.sort((a, b) => (me.id === 0 ? a.y - b.y : b.y - a.y));
    const lead = threat[0];
    const side = sideOf(lead.x);
    const princess = myPrincess.find((t) => t.side === side);
    const baseY = princess && princess.alive ? princess.y : me.id === 0 ? 4 : H - 4;
    let order;
    if (anyAir) order = ['Musketeer', 'Archers', 'Minions'];
    else if (tank) order = ['Goblins', 'Knight', 'Musketeer', 'Archers']; // swarm + dps
    else order = ['Knight', 'Goblins', 'Musketeer', 'Archers'];
    for (const c of order) if (has(c)) return troop(c, lead.x, side, baseY + toward * 2.5);
    return null; // can't answer cleanly yet — hold, don't feed a bad trade
  }

  // ── 3. Offense — tank-first; support trails the Giant, shielded ──────────
  const aliveEnP = enPrincess.filter((t) => t.hp > 0);
  let targetSide = 'right';
  if (aliveEnP.length) {
    const cnt = { left: 0, right: 0 };
    for (const u of enemies) cnt[sideOf(u.x)]++;
    aliveEnP.sort((a, b) => cnt[a.side] - cnt[b.side] || a.hp - b.hp);
    targetSide = aliveEnP[0].side;
  }
  const pushX = aliveEnP.length === 0 ? W / 2 : laneXof(targetSide);
  const backY = me.id === 0 ? mid - 4 : mid + 4;
  const myGiant = mine.find((u) => u.card === 'Giant');
  const myKnight = mine.find(
    (u) => u.card === 'Knight' && (me.id === 0 ? u.y >= mid - 5 : u.y <= mid + 5)
  );
  const lead = myGiant || myKnight;
  const leadAdvanced =
    lead && (me.id === 0 ? lead.y >= mid - 3 : lead.y <= mid + 3);

  if (!myGiant && has('Giant') && E >= 7) {
    return troop('Giant', pushX, targetSide, backY);
  }
  if (lead && leadAdvanced && E >= 4) {
    const lSide = sideOf(lead.x);
    for (const c of ['Musketeer', 'Archers', 'Knight']) {
      if (has(c)) return troop(c, laneXof(lSide), lSide, backY);
    }
    if (myGiant && has('Goblins')) return troop('Goblins', laneXof(lSide), lSide, backY);
  }

  // ── 4. Keep elixir flowing into pressure (no leak), but never naked swarm ─
  const pressure = closing ? 6 : 8;
  if (E >= pressure && !lead) {
    if (has('Giant')) return troop('Giant', pushX, targetSide, backY);
    if (has('Knight')) return troop('Knight', pushX, targetSide, backY);
    if (has('Musketeer')) return troop('Musketeer', pushX, targetSide, backY);
  }
  return null;
}
