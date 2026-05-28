export default function bot(v) {
  const id = v.self.id;
  const fwd = id === 0 ? 1 : -1;
  const mid = v.arena.mid;
  const W = v.arena.width;
  const H = v.arena.height;
  const el = v.self.elixir;
  const enEl = v.enemy.elixir;
  const mult = v.elixirMult;
  const kingY = id === 0 ? 3 : 29;

  function dd(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function can(c) { const h = v.self.hand.find(e => e.card === c); return h && el >= h.cost; }

  function troop(card, x, y) {
    const dz = v.self.deployZone;
    const side = x < W / 2 ? 'left' : 'right';
    const ep = v.towers.find(t => !t.mine && t.kind === 'princess' && t.side === side);
    let lo = dz.minY, hi = dz.maxY;
    if (ep && !ep.alive) {
      if (id === 0) hi = Math.max(hi, H - 6);
      else lo = Math.min(lo, 6);
    }
    return { card, x: Math.max(dz.minX, Math.min(dz.maxX, x)), y: Math.max(lo, Math.min(hi, y)) };
  }

  function cast(card, x, y) {
    return { card, x: Math.max(0, Math.min(W, x)), y: Math.max(0, Math.min(H, y)) };
  }

  const myU = v.units.filter(u => u.mine);
  const enU = v.units.filter(u => !u.mine);
  const myT = v.towers.filter(t => t.mine && t.alive);
  const enT = v.towers.filter(t => !t.mine && t.alive);

  const onMySide = u => id === 0 ? u.y < mid + 2 : u.y > mid - 2;
  const threats = enU.filter(onMySide);
  const threatHP = threats.reduce((s, u) => s + u.hp, 0);

  const myGiant = myU.find(u => u.card === 'Giant');
  const enGiant = enU.find(u => u.card === 'Giant');
  const myCannonN = myU.filter(u => u.card === 'Cannon').length;

  let nearThreat = null, nearD = Infinity;
  for (const u of threats) {
    for (const t of myT) {
      const dist = dd(u, t);
      if (dist < nearD) { nearD = dist; nearThreat = u; }
    }
  }

  // Determine which lane threats concentrate in
  let leftHP = 0, rightHP = 0;
  for (const u of threats) {
    if (u.x < W / 2) leftHP += u.hp; else rightHP += u.hp;
  }
  const threatLane = threatHP > 0 ? (leftHP >= rightHP ? 'left' : 'right') : null;
  const safeLane = threatLane === 'left' ? 'right' : threatLane === 'right' ? 'left' : null;

  const enLP = enT.find(t => t.kind === 'princess' && t.side === 'left');
  const enRP = enT.find(t => t.kind === 'princess' && t.side === 'right');
  const atkLane = !enLP && enRP ? 'left' : enLP && !enRP ? 'right'
    : !enLP && !enRP ? 'left'
    : enLP.hp <= enRP.hp ? 'left' : 'right';

  const behind = v.crowns.enemy > v.crowns.self;

  function bx(lane) { return lane === 'left' ? 3.5 : 14.5; }
  function lx(lane) { return lane === 'left' ? W * 0.25 : W * 0.75; }

  function canFwd(lane) {
    const ep = v.towers.find(t => !t.mine && t.kind === 'princess' && t.side === lane);
    return ep && !ep.alive;
  }

  function spellVal(card, cx, cy) {
    const def = v.cards[card];
    let val = 0;
    for (const u of enU)
      if (Math.hypot(u.x - cx, u.y - cy) <= def.radius) val += Math.min(def.dmg, u.hp);
    for (const t of enT)
      if (Math.hypot(t.x - cx, t.y - cy) <= def.radius) val += def.towerDmg;
    return val;
  }

  function bestSpell(card) {
    if (!can(card)) return null;
    let best = null, bv = 0;
    for (const u of enU) {
      const val = spellVal(card, u.x, u.y);
      if (val > bv) { bv = val; best = { x: u.x, y: u.y, val }; }
    }
    for (const t of enT) {
      const val = spellVal(card, t.x, t.y);
      if (val > bv) { bv = val; best = { x: t.x, y: t.y, val }; }
    }
    return best;
  }

  // 1 ── Spell-finish towers
  for (const t of enT) {
    if (t.hp <= 207 && can('Fireball')) return cast('Fireball', t.x, t.y);
    if (t.hp <= 93 && can('Arrows')) return cast('Arrows', t.x, t.y);
  }

  // 2 ── Defend enemy Giant
  if (enGiant) {
    const gClose = onMySide(enGiant) || Math.abs(enGiant.y - mid) < 5;
    if (gClose && myCannonN === 0 && can('Cannon')) {
      const gl = enGiant.x < W / 2 ? 'left' : 'right';
      return troop('Cannon', gl === 'left' ? 7 : 11, kingY + fwd * 9);
    }
    if (onMySide(enGiant)) {
      // Cannon is pulling Giant — counter support troops first
      if (myCannonN > 0) {
        const enMusk = threats.find(u => u.card === 'Musketeer');
        if (enMusk && can('Knight'))
          return troop('Knight', enMusk.x, enMusk.y - fwd * 0.5);
        const enArch = threats.find(u => u.card === 'Archers');
        if (enArch && can('Arrows')) {
          let cl = 0;
          for (const u of threats) if (dd(u, enArch) <= 3.5) cl += u.hp;
          if (cl >= 300) return cast('Arrows', enArch.x, enArch.y);
        }
      }
      if (can('Goblins')) return troop('Goblins', enGiant.x, enGiant.y - fwd * 1);
      if (can('Knight')) return troop('Knight', enGiant.x, enGiant.y - fwd * 0.5);
      // Musketeer as ranged DPS vs Giant (targets ground)
      if (can('Musketeer') && el >= 5)
        return troop('Musketeer', enGiant.x, enGiant.y - fwd * 4);
    }
  }

  // 3 ── Defend other threats
  if (nearThreat && nearD < 10 && threatHP > 300) {
    if (threats.length >= 2 && can('Fireball')) {
      let bestC = null, bestV = 0;
      for (const c of threats) {
        let val = 0;
        for (const u of threats) if (dd(u, c) <= 2.5) val += Math.min(688, u.hp);
        if (val > bestV) { bestV = val; bestC = c; }
      }
      if (bestV >= 550) return cast('Fireball', bestC.x, bestC.y);
    }
    if (nearThreat.card === 'Musketeer' && can('Knight'))
      return troop('Knight', nearThreat.x, nearThreat.y - fwd * 0.5);
    if (nearThreat.card === 'Knight' && can('Goblins') && nearD < 7)
      return troop('Goblins', nearThreat.x, nearThreat.y - fwd * 1);
    if ((nearThreat.card === 'Archers' || nearThreat.card === 'Goblins') && can('Arrows')) {
      let cl = 0;
      for (const u of threats) if (dd(u, nearThreat) <= 3.5) cl += u.hp;
      if (cl >= 300) return cast('Arrows', nearThreat.x, nearThreat.y);
    }
    if (nearD < 8) {
      if (nearThreat.range > 2 && can('Knight'))
        return troop('Knight', nearThreat.x, nearThreat.y - fwd * 0.5);
      if (can('Goblins') && nearD < 6)
        return troop('Goblins', nearThreat.x, nearThreat.y - fwd * 1);
      if (can('Knight'))
        return troop('Knight', nearThreat.x, nearThreat.y - fwd * 1);
      // Musketeer as defensive ranged DPS when threat is big
      if (threatHP > 700 && can('Musketeer'))
        return troop('Musketeer', nearThreat.x, nearThreat.y - fwd * 4);
      if (can('Archers'))
        return troop('Archers', nearThreat.x, nearThreat.y - fwd * 3);
    }
  }

  // 4 ── Forward-deploy aggression (enemy princess dead)
  if (canFwd(atkLane) && threats.length === 0 && !myGiant) {
    const fwdEl = mult >= 2 ? 5 : 7;
    if (el >= fwdEl) {
      const ek = enT.find(t => t.kind === 'king');
      if (ek) {
        const ry = ek.y - fwd * 4;
        const rx = atkLane === 'left' ? 8 : 10;
        if (can('Giant')) return troop('Giant', rx, ry);
        if (can('Knight')) return troop('Knight', rx, ry);
        if (can('Goblins')) return troop('Goblins', rx, ry);
      }
    }
  }

  // 5 ── Support existing Giant push
  if (myGiant && !myGiant.deploying) {
    const behindG = myGiant.y - fwd * 4;

    if (can('Fireball')) {
      const enCannon = enU.find(u => u.card === 'Cannon' && dd(u, myGiant) < 8);
      if (enCannon) {
        const val = spellVal('Fireball', enCannon.x, enCannon.y);
        if (val >= 400) return cast('Fireball', enCannon.x, enCannon.y);
      }
      const nearG = enU.filter(u => dd(u, myGiant) < 5);
      if (nearG.length >= 1) {
        const cx = nearG.reduce((s, u) => s + u.x, 0) / nearG.length;
        const cy = nearG.reduce((s, u) => s + u.y, 0) / nearG.length;
        if (spellVal('Fireball', cx, cy) >= 500) return cast('Fireball', cx, cy);
      }
    }

    if (can('Musketeer') && el >= 5) return troop('Musketeer', myGiant.x, behindG);
    if (can('Archers') && el >= 4) return troop('Archers', myGiant.x, behindG);

    if (enT.some(t => dd(myGiant, t) < 6) && can('Goblins'))
      return troop('Goblins', myGiant.x, myGiant.y - fwd * 1);
  }

  // 6 ── High-value Fireball
  if (can('Fireball')) {
    const fb = bestSpell('Fireball');
    if (fb && fb.val >= 650) return cast('Fireball', fb.x, fb.y);
  }

  // 7 ── Punish overcommitment
  if (threats.length === 0) {
    if (enGiant && !onMySide(enGiant) && el >= 4) {
      const gl = enGiant.x < W / 2 ? 'left' : 'right';
      const pl = gl === 'left' ? 'right' : 'left';
      const ry = id === 0 ? 14.5 : 17.5;
      if (can('Goblins')) return troop('Goblins', bx(pl), ry);
      if (can('Knight') && el >= 5) return troop('Knight', bx(pl), ry);
    }
    if (enEl <= 2 && el >= 5 && !myGiant) {
      const ry = id === 0 ? 14 : 18;
      if (can('Goblins')) return troop('Goblins', bx(atkLane), ry);
      if (can('Knight')) return troop('Knight', bx(atkLane), ry);
    }
  }

  // 8 ── Start Giant push
  // Allow push in opposite lane when defense is set up, or with minor threats
  const pushThr = behind ? 6 : (mult >= 3 ? 6 : mult >= 2 ? 7 : 8);
  const defenseSet = myCannonN > 0 || threats.every(u => u.card === 'Giant');
  const canPush = threats.length === 0
    || (safeLane && defenseSet && threatHP < 2000)
    || (threatHP < 400 && nearD > 6);
  const pushLane = safeLane && threats.length > 0 ? safeLane : atkLane;

  if (el >= pushThr && !myGiant && canPush && can('Giant'))
    return troop('Giant', bx(pushLane), kingY + fwd * 1);

  // Forced push when behind on crowns past 120s
  if (v.time > 120 && behind && !myGiant && can('Giant') && el >= 6) {
    const fl = safeLane || atkLane;
    return troop('Giant', bx(fl), kingY + fwd * 1);
  }

  // 9 ── Counter-push with surviving troops
  if (!myGiant && el >= 7 && can('Giant') && threats.length === 0) {
    const fwdU = myU.filter(u => !u.building && !u.deploying &&
      (id === 0 ? u.y > mid - 2 : u.y < mid + 2));
    if (fwdU.length >= 2) {
      const avgX = fwdU.reduce((s, u) => s + u.x, 0) / fwdU.length;
      const lane = avgX < W / 2 ? 'left' : 'right';
      if (canFwd(lane)) {
        const ek = enT.find(t => t.kind === 'king');
        if (ek) return troop('Giant', avgX < W / 2 ? 8 : 10, ek.y - fwd * 5);
      }
      return troop('Giant', bx(lane), mid - fwd * 1);
    }
  }

  // 10 ── Arrows value
  if (can('Arrows')) {
    const ar = bestSpell('Arrows');
    if (ar && ar.val >= 450) return cast('Arrows', ar.x, ar.y);
  }

  // 11 ── Overtime spell chip
  if (v.phase === 'overtime' && el >= 8) {
    const wt = enT.reduce((b, t) => !b || t.hp < b.hp ? t : b, null);
    if (wt) {
      if (can('Fireball')) return cast('Fireball', wt.x, wt.y);
      if (can('Arrows')) return cast('Arrows', wt.x, wt.y);
    }
  }

  // 12 ── Anti-leak
  if (el >= 9.0) {
    if (can('Giant') && (threats.length === 0 || safeLane))
      return troop('Giant', bx(safeLane || atkLane), kingY + fwd * 1);
    if (can('Archers')) return troop('Archers', lx(safeLane || atkLane), kingY + fwd * 1);
    if (can('Goblins')) return troop('Goblins', lx(safeLane || atkLane), kingY + fwd * 2);
    if (can('Knight')) return troop('Knight', lx(safeLane || atkLane), kingY + fwd * 2);
    if (can('Musketeer')) return troop('Musketeer', lx(safeLane || atkLane), kingY + fwd * 1);
    if (can('Cannon')) return troop('Cannon', 9, kingY + fwd * 8);
    if (can('Fireball') && enT.length) return cast('Fireball', enT[0].x, enT[0].y);
    if (can('Arrows') && enT.length) return cast('Arrows', enT[0].x, enT[0].y);
  }

  return null;
}
