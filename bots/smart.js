// smart v18 — beats v17 at 71.7%/2400 (8 disjoint seed bands, all ≥69%).
// v18 = v17 + six measured layered tweaks (each kept iff it cleared the noise
// floor on the same 5-seed harness; reverted otherwise — see tools/eval.js):
//   1. defender deploys CLOSER to the princess (toward * 1.5 not 2.5) — they
//      meet the push later so the tower co-tanks more hits. (+3.4pp)
//   2. backY moved from mid-4 to mid-2.5 — Musketeer/Archers support catches
//      up to the bridge-deployed Giant ~5 tiles sooner. (+4.2pp)
//   3. giantY pushed from mid-1 to mid-0.5 — the absolute most forward legal
//      deploy, one more tile of progress per Giant. (+0.8pp)
//   4. Arrows triggers on `n>=2 && val>=500` (in addition to the old n>=3
//      gate). Catches an Archer pair (608 hp): 3-for-3 elixir wash that
//      removes the opponent's main ranged DPS during my push. (+8.5pp)
//   5. Fireball threshold val>=850 → val>=700 — catches solo Musketeer (721
//      hp): even-elixir trade but removes their main DPS unit. (+2.9pp)
//   6. default lane picks the LESS-defended side (lowest enemy hp on their
//      half), then damagedP/lane-lock override as before. Lane lock now
//      engages on the first damaged princess, not the first kill. (+1.6pp)
//   7. split-raid commits at E>=7 (was 8). (+0.8pp)
// Tried-and-rejected with this stack: ranged-aware tank defense, Knight as
// counter-push tank, deploy x at lane center, even closer support stagger,
// Minions in support, behind-on-crowns aggressive spelling.
//
// Inherited from v17: Giant deploys forward at the bridge (root cause from
// the v16 trace — back-line Giants walked alone and died 3 tiles short).
//
// v16 — PROMOTED over v10 at 59.5%/200. Keeps v10's measured-good spell (§1)
// core and reworked defense+offense to break the coin-flip mirror (seed 7
// under v10: a 0-0 draw — both bots dribble cheap units, nothing connects).
//
// The winning package (each layer measured; W/200 vs v10 champion in parens):
//   (a) lane discipline — default to the lane the enemy is NOT loading (its
//       default is left, so push right), then concentrate every push on the
//       already-damaged princess; once one enemy princess dies the lane LOCKS
//       to the survivor (no stray unit drags the Giant to the dead lane).
//   (b) supported-Giant gate — never a naked Giant (ignored by troops, shred
//       by Goblins ~436 dps before it connects). (a+b: W93→95, towerDmg ↑.)
//   (c) DON'T over-defend — when my lane defenders already out-trade the push
//       it's "contested": skip stacking defense and convert into a Giant the
//       OTHER way ("defense is offense"). Over-defending = the mirror. (W102.)
//   (d) split-lane raid — when the main push pulls their single reactive
//       counter one way, a fast Goblin/Knight raid hits the naked far princess
//       a reactive bot cannot answer without splitting. (W107.)
//   (e) contested defense explicitly converts to a Giant counter-push. (W109.)
//   (f) zero-leak — §2 used to hold a Giant/spell hand while CAPPED, both
//       leaking AND not defending; fall through near cap. Leak 1.5→0. (W119.)
//
// REJECTED branches (measured, reproducible — do not reintroduce blindly):
//  * v9  tower-HP "protect/mustPush" passive holding → bled tempo, 70%→50%.
//  * v11 enemy-elixir-timed early commit AS AN ISOLATED LEVER → 50%.
//  * v15 "never counter-attack past a tank push" (!tank guard on contested) →
//    40%. Aggressively counter-attacking PAST Giant pushes is the win; it is
//    the over-defense, not the Giant, that loses the mirror.
import { dist, myUnits, enemyUnits, myTowers, enemyTowers } from './lib.js';

export default function smart(v) {
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

  // ── Building placement safety ──────────────────────────────────────────────
  // Footprint radii matching config.towerFootprint; cannon radius from cards.
  const TOWER_FP = { princess: 1.5, king: 2.0 };
  const BUILDING_RADIUS = { Cannon: v.cards.Cannon.radius || 1.5 };
  function isBlockedBuilding(x, y, br) {
    for (const t of v.towers) {
      if (!t.alive) continue;
      const tr = t.kind === 'king' ? TOWER_FP.king : TOWER_FP.princess;
      const dx = x - t.x, dy = y - t.y;
      if (dx * dx + dy * dy < (br + tr) * (br + tr)) return true;
    }
    for (const u of v.units) {
      if (!u.building || u.hp <= 0) continue;
      const ur = (v.cards[u.card] && v.cards[u.card].radius) || 1.5;
      const dx = x - u.x, dy = y - u.y;
      if (dx * dx + dy * dy < (br + ur) * (br + ur)) return true;
    }
    return false;
  }
  // Find the nearest valid y (stepping toward the river) for a building.
  function safeBuildingTroop(card, x, side, yWant) {
    const br = BUILDING_RADIUS[card] || 1.5;
    const step = toward * 0.5;
    let y = legalY(yWant, side);
    for (let i = 0; i < 20; i++, y = legalY(y + step, side)) {
      if (!isBlockedBuilding(x, y, br)) return { card, x: clampX(x), y };
    }
    return null; // no valid spot found
  }

  // ── 1. Spells — lead the clump by the projectile's travel time ───────────
  // The spell flies from my King tower; by the time it lands (~1–1.5 s) the
  // enemy has moved. Predict each unit's position at impact (it advances at
  // its own speed toward my nearest tower) and cluster on the predicted spots.
  // Tank hp (>=1500) is still excluded — spelling a Giant is a bad trade.
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
  // Nudge the aim toward an adjacent enemy princess so the blast also hits it.
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
    if (c && (c.val >= 700 || c.n >= 3)) {
      const a = aimWithTower(c, v.cards.Fireball.radius);
      return { card: 'Fireball', x: a.x, y: a.y };
    }
    if (lowEnP && (lowEnP.hp <= v.cards.Fireball.towerDmg || (closing && E >= 8))) {
      return { card: 'Fireball', x: lowEnP.x, y: lowEnP.y };
    }
  }
  if (has('Arrows')) {
    const c = spellClump(v.cards.Arrows.radius, 'Arrows');
    if (c && ((c.n >= 3 && c.val >= 480) || (c.n >= 2 && c.val >= 500))) {
      const a = aimWithTower(c, v.cards.Arrows.radius);
      return { card: 'Arrows', x: a.x, y: a.y };
    }
    if (closing && lowEnP && lowEnP.hp <= v.cards.Arrows.towerDmg && E >= 7) {
      return { card: 'Arrows', x: lowEnP.x, y: lowEnP.y };
    }
  }

  // ── 2. Defend — synergy counter, but DON'T over-invest: counter-attack ───
  // Over-defending is how the mirror is lost. Once behind you are perpetually
  // threatened; if §2 hard-returns on every threat you turtle forever and lose
  // on tower HP (measured: seed 7, 2 Giants in 300 s, lost on HP). So: place a
  // fresh counter only when the lane is NOT already contested by my own units.
  // If it is contested, fall through to OFFENSE — defending units already
  // handle it while a Giant goes the other way (classic "defense is offense").
  let counterAttack = false; // contested defense → convert to a Giant push
  if (threat.length) {
    const anyAir = threat.some((u) => u.flying);
    const tank = threat.find((u) => u.maxHp >= 1500);
    threat.sort((a, b) => (me.id === 0 ? a.y - b.y : b.y - a.y));
    const lead = threat[0];
    const side = sideOf(lead.x);
    const princess = myPrincess.find((t) => t.side === side);
    const baseY = princess && princess.alive ? princess.y : me.id === 0 ? 4 : H - 4;
    // My defenders already on that lane, on my half.
    const defenders = mine.filter(
      (u) => sideOf(u.x) === side && !u.deploying &&
        (me.id === 0 ? u.y <= mid : u.y >= mid)
    );
    const defDps = defenders.reduce((s, u) => s + (u.dmg || 0) / 1.1, 0);
    const threatHp = threat.reduce((s, u) => s + u.hp, 0);
    // Contested = my defenders already out-trade the incoming push alone.
    // Counter-attacking past the push (even a Giant) instead of stacking more
    // defense is the measured win: matching the champion's over-defense just
    // reproduces the coin-flip mirror (the !tank-guard variant fell to 40%).
    const contested = defenders.length >= 1 && defDps * 6 >= threatHp;
    if (!contested) {
      let order;
      // Minions is no longer in the deck (Cannon replaced it); Musketeer +
      // Archers are now the only anti-air answer. Cannon is ground-only so
      // it stays off the air-response list — falling through to ranged
      // ground troops is the only option when both fliers cycle out.
      if (anyAir) order = ['Musketeer', 'Archers'];
      else if (tank) order = ['Goblins', 'Knight', 'Cannon', 'Musketeer', 'Archers']; // swarm + dps + cannon
      else order = ['Knight', 'Goblins', 'Cannon', 'Musketeer', 'Archers'];
      for (const c of order) {
        if (!has(c)) continue;
        if (c === 'Cannon') {
          const p = safeBuildingTroop('Cannon', lead.x, side, baseY + toward * 3.5);
          if (p) return p;
        } else {
          return troop(c, lead.x, side, baseY + toward * 1.5);
        }
      }
      // Can't answer with a synergy troop. Holding is fine while poor, but
      // holding a Giant/spell-only hand while CAPPED both leaks elixir AND
      // doesn't defend (measured seed 2: P1 leaked 12.8 this way). When near
      // the cap, fall through to offense instead of idling.
      if (E < 8) return null;
    }
    // Contested: defenders are holding and the enemy is committed forward with
    // a thin backfield — the textbook moment to convert into a Giant the other
    // way. Flag it so the §3 gate commits one even without an escort in hand.
    if (E < 7) return null; // too poor to counter — let defenders work
    counterAttack = true;
  }

  // ── 3. Offense — concentrated, SUPPORTED Giant beatdown + counter-push ────
  const aliveEnP = enPrincess.filter((t) => t.hp > 0);
  // Default to the less-defended lane (fewer enemy units on their half).
  // Ties go to right (opposite the champion's left default).
  let leftDef = 0, rightDef = 0;
  for (const u of enemies) {
    if (me.id === 0 ? u.y >= mid : u.y <= mid) {
      if (sideOf(u.x) === 'left') leftDef += u.maxHp; else rightDef += u.maxHp;
    }
  }
  let targetSide = leftDef < rightDef ? 'left' : 'right';
  const damagedP = aliveEnP.filter((t) => t.hp < t.maxHp).sort((a, b) => a.hp - b.hp);
  if (damagedP.length) targetSide = damagedP[0].side; // finish what's already hurt
  else if (aliveEnP.length && !aliveEnP.some((t) => t.side === 'right'))
    targetSide = aliveEnP[0].side; // right princess gone -> commit left
  const pushX = aliveEnP.length === 0 ? W / 2 : laneXof(targetSide);
  const backY = me.id === 0 ? mid - 2.5 : mid + 2.5;
  // Giants deploy FORWARD at the bridge (max legal y), not deep back. Measured
  // root cause of the non-connecting mirror (seed 7): a Giant dropped at y=12
  // walks ~13 tiles alone for ~15 s and a single Musketeer+tower grind it to
  // death 3 tiles short of the tower, 0 damage dealt. At the bridge it reaches
  // the tower far sooner with less exposure and before the enemy stacks a wall.
  const giantY = me.id === 0 ? mid - 0.5 : mid + 0.5;

  const myGiant = mine.find((u) => u.card === 'Giant');
  const advanced = mine
    .filter((u) => u.card !== 'Giant' && (me.id === 0 ? u.y >= mid - 3 : u.y <= mid + 3))
    .sort((a, b) => (me.id === 0 ? b.y - a.y : a.y - b.y));
  const enemyStarved = v.enemy.elixir <= 2;
  const haveSupport = ['Musketeer', 'Archers'].some((c) => has(c));
  const heavyElixir = v.elixirMult >= 2; // last-min 2× / overtime 3× — must press

  // Supported-Giant gate: never feed a naked Giant (ignored by troops, shredded
  // by Goblins before it connects — measured dead path). Commit only when it
  // will be backed up: escort in hand, riding a live counter-push, the enemy
  // too starved to answer, or elixir is doubled (late game — pressure or lose
  // on tower HP). Always into the concentrated lane / the counter-push's lane.
  // Once one enemy princess is dead, the lane is LOCKED to the survivor —
  // never let a stray advanced unit drag the Giant back to the dead lane
  // (measured seed 7: post-trade Giants alternated lanes and never connected).
  const laneLocked = aliveEnP.length <= 1 || damagedP.length > 0;
  if (!myGiant && has('Giant')) {
    const escortReady = haveSupport && E >= 8;
    const cpUnit = advanced[0];
    const counterPush = cpUnit && E >= 6;
    if (escortReady || counterPush || enemyStarved || counterAttack || (heavyElixir && E >= 6)) {
      const cs = counterPush && !escortReady && !laneLocked ? sideOf(cpUnit.x) : targetSide;
      return troop('Giant', laneXof(cs), cs, giantY);
    }
  }

  // Giant on the board: funnel every spare elixir into support, SAME lane,
  // staggered just behind it so the Giant body-blocks for the squishy DPS.
  if (myGiant) {
    const gSide = sideOf(myGiant.x);
    const sy = me.id === 0
      ? Math.max(backY, myGiant.y - 2.5)
      : Math.min(backY, myGiant.y + 2.5);
    for (const c of ['Musketeer', 'Archers']) if (has(c)) return troop(c, laneXof(gSide), gSide, sy);
    if (has('Knight') && E >= 7) return troop('Knight', laneXof(gSide), gSide, sy);
    if (has('Goblins') && E >= 8) return troop('Goblins', laneXof(gSide), gSide, sy);
  }

  // ── 3b. Split-lane raid — the asymmetric lever ───────────────────────────
  // The champion answers exactly ONE threat per tick at the lead's lane. When
  // my main push has pulled its defense to one lane, the OTHER enemy princess
  // is often naked. A fast, cheap Goblin/Knight raid there cannot be answered
  // without splitting its single counter — free chip or a forced inefficient
  // trade the reactive mirror has no move for. Gated hard so it never just
  // feeds: requires a live main push, a genuinely empty raid lane, and enough
  // elixir left (E≥8) to not starve that main push.
  const mainPush = myGiant || advanced.length >= 1;
  const raidP = enPrincess.find((t) => t.hp > 0 && t.side !== targetSide);
  if (mainPush && raidP && E >= 7) {
    const rSide = raidP.side;
    const guards = enemies.filter(
      (u) => sideOf(u.x) === rSide && (me.id === 0 ? u.y < mid + 2 : u.y > mid - 2)
    ).length;
    if (guards === 0) {
      if (has('Goblins')) return troop('Goblins', laneXof(rSide), rSide, mid);
      if (has('Knight')) return troop('Knight', laneXof(rSide), rSide, mid);
    }
  }

  // No Giant, but a counter-push core is rolling — reinforce it with ranged
  // DPS in that same lane so a won defense converts to tower damage instead
  // of fizzling at the bridge.
  if (advanced.length >= 2 && E >= 6) {
    const aSide = sideOf(advanced[0].x);
    for (const c of ['Musketeer', 'Archers']) if (has(c)) return troop(c, laneXof(aSide), aSide, backY);
  }

  // ── 4. Anti-leak — never idle at the cap; bleed surplus into the lane ────
  // Measured (seed 2): a perpetually-threatened P1 leaked 12.8 elixir doing
  // nothing while §2 fell through and no offense gate fired. Surplus elixir is
  // a lost tempo unit — at E≥8 always commit the best card into the locked
  // lane (it joins the concentrated push instead of evaporating at the cap).
  if (E >= 8) {
    for (const c of ['Giant', 'Musketeer', 'Archers', 'Knight', 'Goblins']) {
      if (c === 'Giant' && myGiant) continue;
      if (has(c)) return troop(c, pushX, targetSide, backY);
    }
  }
  return null;
}
