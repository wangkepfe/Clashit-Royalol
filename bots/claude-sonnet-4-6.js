// Giant beatdown strategy with reactive Cannon defense and efficient spell usage.
// Full information exploited for threat detection, spell evaluation, and lane selection.

export default function bot(view) {
  const { self, arena, towers, units } = view;
  const { id, elixir, hand } = self;
  const mid = arena.mid;    // 16
  const W   = arena.width;  // 18
  const H   = arena.height; // 32
  const isP0 = id === 0;

  // ── utility ───────────────────────────────────────────────────────────────
  const canPlay = card => {
    const h = hand.find(h => h.card === card);
    return !!h && elixir >= h.cost;
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ownSide = y => isP0 ? y < mid : y > mid;

  // y coord just inside own half, `depth` tiles behind the river boundary
  const dY = depth => isP0 ? mid - 0.6 - depth : mid + 0.6 + depth;
  // bridge x (left lane = 3.5, right lane = 14.5)
  const lX = lane => lane === 'left' ? 3.5 : 14.5;

  // ── entity collections ────────────────────────────────────────────────────
  const myUnits  = units.filter(u =>  u.mine);
  const enUnits  = units.filter(u => !u.mine);          // all, incl. deploying
  const enActive = enUnits.filter(u => !u.deploying);   // can move / attack
  const enTowers = towers.filter(t => !t.mine && t.alive);

  // ── tower references ──────────────────────────────────────────────────────
  const leftEP  = towers.find(t => !t.mine && t.kind === 'princess' && t.side === 'left');
  const rightEP = towers.find(t => !t.mine && t.kind === 'princess' && t.side === 'right');
  const leftEPDead  = leftEP  && !leftEP.alive;
  const rightEPDead = rightEP && !rightEP.alive;

  // ── threat analysis ───────────────────────────────────────────────────────
  const enInMyHalf = enActive.filter(u => ownSide(u.y));
  const enMyHalfHP = enInMyHalf.reduce((s, u) => s + u.hp, 0);

  // Enemy Giant: threat when it enters my half OR is within 3 tiles of mid on
  // enemy side (pre-emptive Cannon before it locks onto my princess tower).
  const enGiant = enUnits.find(u => u.card === 'Giant');
  const enGiantThreat = enGiant && (
    ownSide(enGiant.y) ||
    (isP0 ? enGiant.y <= mid + 3 : enGiant.y >= mid - 3)
  );

  let threatLane = null;
  if (enGiantThreat) {
    threatLane = enGiant.x < W / 2 ? 'left' : 'right';
  } else if (enInMyHalf.length > 0) {
    let lHP = 0, rHP = 0;
    for (const u of enInMyHalf) { if (u.x < W / 2) lHP += u.hp; else rHP += u.hp; }
    threatLane = lHP >= rHP ? 'left' : 'right';
  }

  // ── push lane selection ───────────────────────────────────────────────────
  // Dead enemy princess = forward deploy + weaker remaining tower.
  // Otherwise split the pressure: push opposite of active threat.
  let pushLane;
  if      (leftEPDead  && !rightEPDead) pushLane = 'left';
  else if (rightEPDead && !leftEPDead)  pushLane = 'right';
  else if (threatLane === 'left')       pushLane = 'right';
  else if (threatLane === 'right')      pushLane = 'left';
  else {
    const lhp = leftEP  && leftEP.alive  ? leftEP.hp  : 0;
    const rhp = rightEP && rightEP.alive ? rightEP.hp : 0;
    pushLane = lhp <= rhp ? 'left' : 'right';
  }

  // ── my units ──────────────────────────────────────────────────────────────
  const myGiant    = myUnits.find(u => u.card === 'Giant');
  const myGiantLane = myGiant ? (myGiant.x < W / 2 ? 'left' : 'right') : null;
  // Lane-specific Cannon check: don't stack two Cannons in the same lane.
  const hasCannonIn = lane => myUnits.some(u =>
    u.card === 'Cannon' && (lane === 'left' ? u.x <= W / 2 : u.x > W / 2)
  );

  // ── spell evaluator ───────────────────────────────────────────────────────
  // Scans every enemy unit position as a candidate spell center; returns the
  // highest-damage placement or null if no enemy units exist.
  const evalSpell = card => {
    const r    = card === 'Fireball' ? 2.5 : 3.5;
    const dmg  = card === 'Fireball' ? 688 : 366;
    const tDmg = card === 'Fireball' ? 207 : 93;
    let best = null, bestVal = 0;
    for (const c of enUnits) {
      let val = 0;
      for (const u of enUnits)  if (dist(c, u) <= r) val += Math.min(u.hp, dmg);
      for (const t of enTowers) if (dist(c, t) <= r) val += tDmg;
      if (val > bestVal) { bestVal = val; best = { x: c.x, y: c.y, val }; }
    }
    return best;
  };

  // Defensive Cannon placement: verified 3.5 tiles from princess (min overlap = 3.0).
  //   P0 left  princess (3.5, 6.5):  Cannon (3.5, 10.0) → dist 3.5 ✓
  //   P0 right princess (14.5, 6.5): Cannon (14.5, 10.0) → dist 3.5 ✓
  //   P1 left  princess (3.5, 25.5): Cannon (3.5, 22.0)  → dist 3.5 ✓
  //   P1 right princess (14.5, 25.5): Cannon (14.5, 22.0) → dist 3.5 ✓
  const cannonDefY = isP0 ? 10.0 : 22.0;
  const troopDefY  = isP0 ?  8.5 : 23.5;

  // ══════════════════════════════════════════════════════════════════════════
  // DECISION TREE  (highest priority first)
  // ══════════════════════════════════════════════════════════════════════════

  // 0 ── instant crown: kill a wounded enemy princess with a spell ──────────
  for (const t of enTowers) {
    if (t.kind !== 'princess') continue;
    if (canPlay('Fireball') && t.hp <= 207) return { card: 'Fireball', x: t.x, y: t.y };
    if (canPlay('Arrows')   && t.hp <=  93) return { card: 'Arrows',   x: t.x, y: t.y };
  }

  // 1 ── high-value Fireball (≥600 effective HP — kills Musketeer or any cluster) ─
  if (canPlay('Fireball')) {
    const fb = evalSpell('Fireball');
    if (fb && fb.val >= 600) return { card: 'Fireball', x: fb.x, y: fb.y };
  }

  // 2 ── Arrows to clear swarms (Goblins ×4 = 808, Archers ×2 = 608) ───────
  if (canPlay('Arrows')) {
    const ar = evalSpell('Arrows');
    if (ar && ar.val >= 500) return { card: 'Arrows', x: ar.x, y: ar.y };
  }

  // 3 ── Cannon to kite incoming Giant, then support with ranged troops ──────
  if (enGiantThreat) {
    const tl = threatLane;
    if (canPlay('Cannon') && !hasCannonIn(tl)) {
      return { card: 'Cannon', x: lX(tl), y: cannonDefY };
    }
    // Ranged support alongside the Cannon to deal with Giant's escort
    const sx = lX(tl) + (tl === 'left' ? 2.0 : -2.0);
    if (canPlay('Musketeer') && elixir >= 6) return { card: 'Musketeer', x: sx,     y: cannonDefY };
    if (canPlay('Archers')   && elixir >= 5) return { card: 'Archers',   x: sx,     y: cannonDefY };
    if (canPlay('Knight')    && elixir >= 4) return { card: 'Knight',    x: lX(tl), y: troopDefY  };
    if (canPlay('Goblins')   && elixir >= 3) return { card: 'Goblins',   x: lX(tl), y: troopDefY  };
  }

  // 4 ── defend against a significant troop push in my half ─────────────────
  if (threatLane && enMyHalfHP > 500) {
    const tl = threatLane;
    if (canPlay('Cannon')  && !hasCannonIn(tl) && elixir >= 5) return { card: 'Cannon',  x: lX(tl), y: cannonDefY };
    if (canPlay('Knight')  && elixir >= 5) return { card: 'Knight',  x: lX(tl),                              y: dY(2) };
    if (canPlay('Goblins') && elixir >= 4) return { card: 'Goblins', x: lX(tl),                              y: dY(2) };
    if (canPlay('Archers') && elixir >= 4) return { card: 'Archers', x: lX(tl) + (tl === 'left' ? 1.5 : -1.5), y: dY(3) };
  }

  // 5 ── add support to the active Giant push ───────────────────────────────
  if (myGiant) {
    const gl = myGiantLane;
    const sx = lX(gl) + (gl === 'left' ? 1.5 : -1.5);
    if (canPlay('Musketeer'))              return { card: 'Musketeer', x: sx,     y: dY(2) };
    if (canPlay('Knight')  && elixir >= 4) return { card: 'Knight',   x: lX(gl), y: dY(2) };
    if (canPlay('Archers') && elixir >= 4) return { card: 'Archers',  x: sx,     y: dY(2) };
    if (canPlay('Goblins') && elixir >= 3) return { card: 'Goblins',  x: lX(gl), y: dY(2) };
  }

  // 6 ── launch Giant push ───────────────────────────────────────────────────
  if (canPlay('Giant')) {
    const minE = view.doubleElixir ? 5 : 7;
    if (elixir >= minE || (elixir >= 5 && !threatLane)) {
      const pl = pushLane;
      const laneIsDead = pl === 'left' ? leftEPDead : rightEPDead;
      // Forward deploy when enemy princess in that lane is dead:
      // y=21 (P0) or y=11 (P1) is within the forward zone (≤H-6 / ≥6) and
      // outside king aggro range: dist((3.5|14.5, 21), (9, 29)) ≈ 9.7 > 7.0 ✓
      const gy = laneIsDead ? (isP0 ? 21.0 : 11.0) : dY(1);
      return { card: 'Giant', x: lX(pl), y: gy };
    }
  }

  // 7 ── spells at lower threshold in double/triple elixir ──────────────────
  if (enUnits.length > 0) {
    const fbT = view.doubleElixir ? 400 : 600;
    const arT = view.doubleElixir ? 350 : 500;
    if (canPlay('Fireball')) {
      const fb = evalSpell('Fireball');
      if (fb && fb.val >= fbT) return { card: 'Fireball', x: fb.x, y: fb.y };
    }
    if (canPlay('Arrows')) {
      const ar = evalSpell('Arrows');
      if (ar && ar.val >= arT) return { card: 'Arrows', x: ar.x, y: ar.y };
    }
  }

  // 8 ── elixir dump (≥8) — prevent capping at 10 ───────────────────────────
  if (elixir >= 8) {
    const pl = pushLane;
    const sx = lX(pl) + (pl === 'left' ? 1.5 : -1.5);
    if (canPlay('Giant'))     return { card: 'Giant',     x: lX(pl), y: dY(1) };
    if (canPlay('Goblins'))   return { card: 'Goblins',   x: lX(pl), y: dY(1) };
    if (canPlay('Knight'))    return { card: 'Knight',    x: lX(pl), y: dY(1) };
    if (canPlay('Musketeer')) return { card: 'Musketeer', x: sx,     y: dY(2) };
    if (canPlay('Archers'))   return { card: 'Archers',   x: sx,     y: dY(2) };
    // Chip tower with Arrows as absolute last resort
    if (canPlay('Arrows') && enTowers.length > 0) {
      const t = enTowers.find(t => t.kind === 'princess') || enTowers[0];
      return { card: 'Arrows', x: t.x, y: t.y };
    }
  }

  return null;
}
