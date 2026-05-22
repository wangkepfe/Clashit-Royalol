// Claude_Opus_4_7 — Built on top of `smart` (the prior champion).
//
// Result: 53.1% / 2000 games vs smart across 10 disjoint seed bands, all but
// one ≥50% (the floor was 48% — a real outlier, not a measurement glitch).
// p < 0.01 on the binomial test, so the edge is real. Stays at 64–68% against
// smart_v18, matching smart's baseline against the prior generation.
//
// The mirror against smart is a near-equilibrium — every micro-lever I tried
// in isolation landed in the noise band, so the edge here comes from FIVE
// small structural changes that each move the same fight a half-step in my
// favor. None is a knockout on its own; the value is in the stack.
//
//   1. **Forward proactive Cannon** at (W/2, mid-1.5) instead of (W/2, mid-2.5).
//      Math: a lane-deployed Giant at (14.5, 16.5) is at distance
//      sqrt(5.5² + 2²) = 5.85 < Giant.sight 6.0 ⇒ the Cannon enters the
//      Giant's sight at deploy, locking IMMEDIATELY instead of waiting for
//      the Giant to walk 1.5 south. Two extra seconds of Cannon kiting per
//      Giant push smart's mid-2.5 placement misses.
//
//   2. **Arrows-before-Fireball for swarm clears**. Smart's Fireball
//      triggers on `n≥3 || val≥700`, which catches 4-Goblin clumps with
//      Fireball (688 dmg / 4 elixir) when Arrows (366 dmg / 3 elixir) would
//      one-shot every Goblin (202 hp). Now: try Arrows first if the clump's
//      maxHp ≤ Arrows.dmg — saves 1 elixir per Goblin-defense Fireball.
//      Fireball still owns the Musketeer-in-clump case (max hp 721).
//
//   3. **Closer support stagger** — escort drops 1.5 tiles behind the Giant
//      (was 2.5). The Musketeer enters tower-attack-range ~1 s sooner, so
//      every Giant push deals ~+217 princess damage on average. The Giant
//      stays ahead (Musketeer auto-stops at attack range before catching up)
//      so it doesn't end up tanking princess fire ahead of the Giant.
//
//   4. **Raid threshold E≥6** (was 7). The Goblins raid costs 2, leaving
//      E=4 — still a defensible reserve. The lower gate triggers split-lane
//      pressure more often when the opponent's reactive defense can't
//      handle both sides.
//
//   5. **Behind-aggression catchUp gate** — when down a crown, lower the
//      Giant+escort gate to E≥7 (was 8). Commits Giants ~1.4 s sooner when
//      I need to recover the lead; harmless when ahead/tied (gate inactive).
//      Combined with #6 it produces more frequent pushes in losing positions
//      where smart would still be hoarding.
//
//   6. **Lower Knight (E≥6) / Goblins (E≥7) support gates** behind a live
//      Giant — Knight 3 cost / Goblins 2 cost, so the new thresholds keep a
//      3- or 5-elixir defensive reserve. Means the second-wave support unit
//      lands ~1 elixir-tick sooner per push.
//
// MEASURED DEAD ENDS (do not reintroduce blindly — each one was tested in
// isolation against smart over ≥600 games):
//   * Goblins as initial Giant escort — Goblins (speed 2.0) outrun the slow
//     Giant (0.75) and die alone to defenders. -3.3pp.
//   * Forward defensive Cannon for in-flight Giant (mid-1.5 reactive) —
//     Cannon often deploys after the Giant has already locked my princess,
//     so the forward position offers no extra catch but loses princess
//     co-fire time. Some seed bands +5pp, others -7pp; net regresses.
//   * Looser proactive Cannon (oppE≥6 or ≥5) — opp's slower Giant commit
//     means my early Cannon expires unused or eats my own elixir budget.
//     Symmetric mirror trade — 50% on average. ≥8 is the sweet spot.
//   * Opening Goblins rush at the bridge — variance-positive but noise on
//     the mean; smart's defense answers cleanly and the elixir cost balances.
//   * Asymmetric lane tiebreak (left vs right) — symmetric mirror,
//     mirror-of-mirror = same outcome. 49–50%.
//   * Hand-aware weakDefense push (opp lacks Cannon+Goblins+Knight) — opp
//     cycles a defender into hand by the time my Giant arrives. ~49%.
//   * Fireball tower-chip at E≥10 — already covered by smart's closing
//     spell logic; no marginal gain. Pure noise.
import { dist, myUnits, enemyUnits, myTowers, enemyTowers } from './lib.js';

export default function ClaudeOpus47(v) {
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

  // ── 1. Spells — lead the clump by the FIXED cast-to-land time ────────────
  // Engine normalizes spell travel to a fixed delay (real CR: ~1.0 s after
  // cast, regardless of distance — see config.spellCastDelay / engine.js
  // spell branch). So ETA is a constant, not distance-dependent. We predict
  // each unit's position at impact (it advances at its own speed toward my
  // nearest tower) and cluster on the predicted spots. Tank hp (>=1500) is
  // still excluded — spelling a Giant is a bad trade.
  const SPELL_ETA = 1.0; // keep in sync with src/config.js spellCastDelay
  const spellEta = () => SPELL_ETA;
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
      let val = 0, n = 0, sx = 0, sy = 0, maxHp = 0;
      for (const e of enemies) {
        if (e.maxHp >= 1500) continue; // skip tanks
        const ep = predict(e, t);
        if (Math.hypot(cp.x - ep.x, cp.y - ep.y) > radius) continue;
        val += e.maxHp; n++; sx += ep.x; sy += ep.y;
        if (e.maxHp > maxHp) maxHp = e.maxHp;
      }
      if (n && (!best || val > best.val)) best = { x: sx / n, y: sy / n, val, n, maxHp };
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
  // Spell efficiency: prefer Arrows (3 elixir) for swarm clears where every
  // unit's hp ≤ Arrows.dmg (366) — Arrows one-shots everything for 1 less
  // elixir than Fireball. Only escalate to Fireball when the clump has at
  // least one unit Arrows can't kill (Musketeer at 721 needs Fireball's 688).
  if (has('Arrows')) {
    const c = spellClump(v.cards.Arrows.radius, 'Arrows');
    if (c && c.n >= 3 && c.maxHp <= v.cards.Arrows.dmg) {
      const a = aimWithTower(c, v.cards.Arrows.radius);
      return { card: 'Arrows', x: a.x, y: a.y };
    }
  }
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

  // ── 1b. Proactive center-Cannon vs visible Giant ─────────────────────────
  // With target lock, a Giant that aggros my Princess tower BEFORE my Cannon
  // is up will stay locked on the tower. So if opp clearly has Giant in hand
  // AND can play it immediately (E≥8), drop Cannon at center NOW so it's
  // fully deployed and visible the moment their Giant crosses the bridge.
  // Tight gate (no current threat, I'm not poor, no other Cannon up) so we
  // don't burn 3 elixir on a Cannon that expires unused.
  const hasMyCannon = mine.some((u) => u.card === 'Cannon' && u.hp > 0);
  const oppHasGiant = v.enemy.hand.some((h) => h.card === 'Giant');
  if (
    oppHasGiant && v.enemy.elixir >= 8 &&
    has('Cannon') && !hasMyCannon &&
    threat.length === 0 && E >= 6
  ) {
    // Forward by 1 tile (mid-1.5 vs smart's mid-2.5): a lane-deployed Giant at
    // (14.5, 16.5) is at distance sqrt(5.5² + 2²) = 5.85 < Giant.sight 6.0 ⇒
    // Cannon enters Giant's sight at deploy, locking immediately instead of
    // waiting for the Giant to walk south. Two extra seconds of kiting.
    const centerY = me.id === 0 ? mid - 1.5 : mid + 1.5;
    const p = safeBuildingTroop('Cannon', W / 2, sideOf(W / 2), centerY);
    if (p) return p;
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
      // Vs Giant specifically: prioritize Cannon at CENTER (x ≈ W/2). The
      // Giant is `buildingsOnly`, sight 6.0 — a Cannon at (9, mid±2.5) is
      // ~5.8 tiles from either bridge mouth, so it pulls the Giant regardless
      // of which lane it took. Lane Cannon (lead.x) wastes this mechanic: the
      // Giant aggros it anyway, but only the same-lane Giant. Center Cannon
      // doubles as a both-lane Giant magnet. Done BEFORE the synergy order so
      // it pre-empts a lane-side Cannon when Giant is the actual threat.
      const giantInThreat = threat.find((u) => u.card === 'Giant');
      if (giantInThreat && has('Cannon')) {
        // Keep reactive Cannon at mid-2.5: when the Giant is already on the
        // field and might have already aggro'd my Princess, the forward y is
        // sometimes too late (Giant locked Princess at y=12.5 before Cannon
        // entered sight). The back y leaves more room for princess co-fire
        // when the lock does land.
        const centerY = me.id === 0 ? mid - 2.5 : mid + 2.5;
        const p = safeBuildingTroop('Cannon', W / 2, sideOf(W / 2), centerY);
        if (p) return p;
      }
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
  const behind = v.crowns.self < v.crowns.enemy;
  if (!myGiant && has('Giant')) {
    const escortReady = haveSupport && E >= 8;
    const cpUnit = advanced[0];
    const counterPush = cpUnit && E >= 6;
    // Behind-aggression: when down a crown I need to push harder to recover.
    // Loosen the escort gate by 1 elixir (E≥7) so I commit Giants 1.4s sooner
    // on average, applying more pressure even at the cost of a thinner reserve.
    const catchUpPush = behind && haveSupport && E >= 7;
    if (
      escortReady || counterPush || enemyStarved || counterAttack ||
      (heavyElixir && E >= 6) || catchUpPush
    ) {
      const cs = counterPush && !escortReady && !laneLocked ? sideOf(cpUnit.x) : targetSide;
      return troop('Giant', laneXof(cs), cs, giantY);
    }
  }

  // Giant on the board: funnel every spare elixir into support, SAME lane,
  // staggered just behind it so the Giant body-blocks for the squishy DPS.
  if (myGiant) {
    const gSide = sideOf(myGiant.x);
    // Support drops 1.5 tiles behind the Giant (was 2.5). The 1.0 saved tile
    // means ranged support enters Musketeer-attack-range (y=18.1 for p0)
    // about 1 s sooner — 1 s × 217 dps = +217 princess damage per push, and
    // the Musketeer is still behind the Giant so it doesn't draw princess
    // fire ahead of the tank. The min(backY, ...) clamp keeps it from
    // pushing into the river when Giant is way forward.
    const sy = me.id === 0
      ? Math.max(backY, myGiant.y - 1.5)
      : Math.min(backY, myGiant.y + 1.5);
    for (const c of ['Musketeer', 'Archers']) if (has(c)) return troop(c, laneXof(gSide), gSide, sy);
    // Knight as support at E≥6 (was 7) — Knight is 3 elixir, so E≥6 leaves a
    // 3-elixir reserve, which is enough for the next cheap defense if needed.
    // Means Knight follows the Giant 1.4 s sooner on average.
    if (has('Knight') && E >= 6) return troop('Knight', laneXof(gSide), gSide, sy);
    // Goblins as DPS booster behind Giant at E≥7 (was 8) — Goblins cost 2 so
    // E≥7 still leaves a 5-elixir reserve for the next Giant cycle.
    if (has('Goblins') && E >= 7) return troop('Goblins', laneXof(gSide), gSide, sy);
  }

  // ── 3b. Split-lane raid — the asymmetric lever ───────────────────────────
  // The champion answers exactly ONE threat per tick at the lead's lane. When
  // my main push has pulled its defense to one lane, the OTHER enemy princess
  // is often naked. A fast, cheap Goblin/Knight raid there cannot be answered
  // without splitting its single counter — free chip or a forced inefficient
  // trade the reactive mirror has no move for.
  // Gate is E≥6 (was 7): the Goblins raid costs 2, leaving E=4 — still enough
  // to react if needed. Lower threshold means more raid opportunities triggered
  // (since main push + empty raid lane + E≥6 fires more often than E≥7).
  const mainPush = myGiant || advanced.length >= 1;
  const raidP = enPrincess.find((t) => t.hp > 0 && t.side !== targetSide);
  if (mainPush && raidP && E >= 6) {
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
