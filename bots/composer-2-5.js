// Composer tournament bot — deterministic macro, lane defense, spell value, giant beatdown.
import {
  dist,
  myUnits,
  enemyUnits,
  myTowers,
  enemyTowers,
  forward,
  canPlay,
  inHand,
  behindTowerY,
  threatenedLane,
  laneX,
} from './lib.js';

const SPELL_DELAY = 1.0;
const CANNON_R = 1.5;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function laneOf(x, mid) {
  return x < mid ? 'left' : 'right';
}

function bridgeX(lane) {
  return lane === 'left' ? 3.5 : 14.5;
}

function princessAlive(v, owner, lane) {
  return v.towers.some(
    (t) => t.owner === owner && t.kind === 'princess' && t.side === lane && t.alive
  );
}

function onMySide(v, u) {
  return v.self.id === 0 ? u.y < v.arena.mid + 5 : u.y > v.arena.mid - 5;
}

function findEntity(v, id) {
  if (id == null) return null;
  return v.units.find((u) => u.id === id) || v.towers.find((t) => t.id === id) || null;
}

function enemyCanPlay(v, card) {
  const h = v.enemy.hand.find((x) => x.card === card);
  return !!h && v.enemy.elixir >= h.cost;
}

function legalTroopZone(v, x, y) {
  const A = v.arena;
  if (x < 0.5 || x > A.width - 0.5 || y < 0.5 || y > A.height - 0.5) return false;
  if (v.self.id === 0) {
    if (y <= A.mid - 0.5) return true;
    const side = laneOf(x, A.width / 2);
    return !princessAlive(v, v.enemy.id, side) && y <= A.height - 6.0;
  }
  if (y >= A.mid + 0.5) return true;
  const side = laneOf(x, A.width / 2);
  return !princessAlive(v, v.enemy.id, side) && y >= 6.0;
}

function legalBuilding(v, x, y) {
  if (!legalTroopZone(v, x, y)) return false;
  for (const t of v.towers) {
    if (!t.alive) continue;
    const tr = t.kind === 'king' ? 2.0 : 1.5;
    const dx = x - t.x;
    const dy = y - t.y;
    if (dx * dx + dy * dy < (CANNON_R + tr) * (CANNON_R + tr)) return false;
  }
  for (const u of myUnits(v)) {
    if (!u.building || u.hp <= 0) continue;
    const dx = x - u.x;
    const dy = y - u.y;
    if (dx * dx + dy * dy < (CANNON_R + CANNON_R) * (CANNON_R + CANNON_R)) return false;
  }
  return true;
}

function legalAction(v, action) {
  if (!action) return null;
  const def = v.cards[action.card];
  if (!def) return null;
  if (def.kind === 'spell') {
    if (action.x < 0 || action.x > v.arena.width || action.y < 0 || action.y > v.arena.height) return null;
    return action;
  }
  if (def.kind === 'building') {
    return legalBuilding(v, action.x, action.y) ? action : null;
  }
  return legalTroopZone(v, action.x, action.y) ? action : null;
}

function deployTroopY(v, lane, depth) {
  const mid = v.arena.mid;
  if (depth === 'back') return v.self.id === 0 ? mid - 4 : mid + 4;
  if (depth === 'defense') return behindTowerY(v);
  if (depth === 'bridge') return v.self.id === 0 ? mid - 0.5 : mid + 0.5;
  if (depth === 'deep' && !princessAlive(v, v.enemy.id, lane)) {
    return v.self.id === 0 ? 24 : 8;
  }
  return behindTowerY(v);
}

function troopSpot(v, lane, depth) {
  return { x: bridgeX(lane), y: deployTroopY(v, lane, depth) };
}

function hasMyCannon(v) {
  return myUnits(v).some((u) => u.card === 'Cannon' && u.hp > 0);
}

function unitVelocity(v, u) {
  if (u.deploying || !u.speed) return { vx: 0, vy: 0 };
  let tx = u.x;
  let ty = u.y;
  const goal = findEntity(v, u.targetId);
  if (goal) {
    tx = goal.x;
    ty = goal.y;
  } else {
    const targets = v.towers.filter((t) => t.owner !== u.owner && t.alive);
    if (targets.length) {
      let best = targets[0];
      let bestD = dist(u, best);
      for (const t of targets) {
        const d = dist(u, t);
        if (d < bestD) {
          best = t;
          bestD = d;
        }
      }
      tx = best.x;
      ty = best.y;
    }
  }
  const d = Math.hypot(tx - u.x, ty - u.y);
  if (d < 0.05) return { vx: 0, vy: 0 };
  return { vx: ((tx - u.x) / d) * u.speed, vy: ((ty - u.y) / d) * u.speed };
}

function predictPos(v, u, dt) {
  const { vx, vy } = unitVelocity(v, u);
  return { x: u.x + vx * dt, y: u.y + vy * dt };
}

function lanePressure(v, lane) {
  let hp = 0;
  let giants = 0;
  let air = 0;
  for (const u of enemyUnits(v)) {
    if (!onMySide(v, u)) continue;
    if (laneOf(u.x, v.arena.width / 2) !== lane) continue;
    hp += u.hp;
    if (u.card === 'Giant') giants++;
    if (u.flying) air++;
  }
  return { hp, giants, air };
}

function totalThreat(v) {
  let hp = 0;
  let giant = null;
  for (const u of enemyUnits(v)) {
    if (!onMySide(v, u)) continue;
    hp += u.hp;
    if (u.card === 'Giant' && (!giant || u.y * forward(v) < giant.y * forward(v))) giant = u;
  }
  return { hp, giant };
}

function elixirAdvantage(v) {
  return v.self.elixir - v.enemy.elixir;
}

function urgency(v) {
  const thr = totalThreat(v);
  let u = thr.hp / 800;
  if (thr.giant) u += 3;
  if (v.phase === 'overtime') u += 1 + (v.crowns.enemy - v.crowns.self) * 2;
  return u;
}

function reserveElixir(v) {
  let reserve = 0;
  if (enemyCanPlay(v, 'Giant') && !hasMyCannon(v) && !inHand(v, 'Cannon')) reserve = 3;
  else if (totalThreat(v).hp > 500 && !inHand(v, 'Knight') && !inHand(v, 'Archers')) reserve = 2;
  return reserve;
}

function spendable(v) {
  return v.self.elixir - reserveElixir(v);
}

function pushLane(v) {
  const leftOpen = !princessAlive(v, v.enemy.id, 'left');
  const rightOpen = !princessAlive(v, v.enemy.id, 'right');
  if (leftOpen && !rightOpen) return 'left';
  if (rightOpen && !leftOpen) return 'right';
  const lt = v.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'left' && t.alive);
  const rt = v.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'right' && t.alive);
  if (lt && rt) return lt.hp <= rt.hp ? 'left' : 'right';
  return v.tick % 1800 < 900 ? 'left' : 'right';
}

function cannonSpot(v, lane) {
  const princess = myTowers(v).find((t) => t.kind === 'princess' && t.side === lane);
  const x = laneX(v, lane);
  const tries = princess
    ? [3.2, 2.5, 4, 1.5, 5].map((dy) => ({ x, y: princess.y + forward(v) * dy }))
    : [{ x, y: behindTowerY(v) }];
  for (const spot of tries) {
    if (legalBuilding(v, spot.x, spot.y)) return spot;
  }
  return null;
}

function spellDamageAt(v, card, cx, cy) {
  const def = v.cards[card];
  let killHp = 0;
  let hits = 0;
  let towerDmg = 0;
  for (const u of enemyUnits(v)) {
    const p = predictPos(v, u, SPELL_DELAY);
    if (dist(p, { x: cx, y: cy }) <= def.radius) {
      killHp += Math.min(u.hp, def.dmg);
      hits++;
    }
  }
  for (const t of enemyTowers(v)) {
    if (dist(t, { x: cx, y: cy }) <= def.radius) {
      towerDmg += Math.min(t.hp, def.towerDmg);
      hits++;
    }
  }
  return { killHp, hits, towerDmg };
}

function bestSpell(v, card, minKillHp, minHits) {
  if (!canPlay(v, card)) return null;
  const def = v.cards[card];
  const seeds = enemyUnits(v);
  if (!seeds.length) return null;

  let best = null;
  let bestScore = 0;
  for (const seed of seeds) {
    const p = predictPos(v, seed, SPELL_DELAY);
    const pack = spellDamageAt(v, card, p.x, p.y);
    const score = pack.killHp + pack.towerDmg * 0.4 + (pack.hits >= 2 ? 150 : 0);
    if (pack.killHp >= minKillHp && pack.hits >= minHits && score > bestScore) {
      bestScore = score;
      best = { card, x: p.x, y: p.y };
    }
  }
  if (!best) return null;

  const caught = [];
  for (const u of enemyUnits(v)) {
    const p = predictPos(v, u, SPELL_DELAY);
    if (dist(p, best) <= def.radius) caught.push(p);
  }
  if (caught.length >= 2) {
    best.x = caught.reduce((s, p) => s + p.x, 0) / caught.length;
    best.y = caught.reduce((s, p) => s + p.y, 0) / caught.length;
  }
  best.x = clamp(best.x, 0.5, v.arena.width - 0.5);
  best.y = clamp(best.y, 0.5, v.arena.height - 0.5);
  return best;
}

function trySpells(v) {
  // Snipe high-value solo targets on our side
  if (canPlay(v, 'Fireball')) {
    for (const u of enemyUnits(v)) {
      if (!onMySide(v, u)) continue;
      if (u.hp <= 688 && (u.card === 'Musketeer' || u.card === 'Cannon' || u.card === 'Knight')) {
        const p = predictPos(v, u, SPELL_DELAY);
        const pack = spellDamageAt(v, 'Fireball', p.x, p.y);
        if (pack.killHp >= u.hp * 0.9) {
          return legalAction(v, { card: 'Fireball', x: p.x, y: p.y });
        }
      }
    }
  }

  const fb = bestSpell(v, 'Fireball', 650, 1);
  if (fb && spellDamageAt(v, 'Fireball', fb.x, fb.y).killHp >= 650) {
    return legalAction(v, fb);
  }

  const ar = bestSpell(v, 'Arrows', 480, 2);
  if (ar && spellDamageAt(v, 'Arrows', ar.x, ar.y).killHp >= 500) {
    return legalAction(v, ar);
  }

  const arSwarm = bestSpell(v, 'Arrows', 320, 3);
  if (arSwarm && spellDamageAt(v, 'Arrows', arSwarm.x, arSwarm.y).killHp >= 550) {
    return legalAction(v, arSwarm);
  }

  if (canPlay(v, 'Arrows')) {
    for (const u of enemyUnits(v)) {
      if (u.card !== 'Goblins' && u.card !== 'Archers') continue;
      const nearby = enemyUnits(v).filter((e) => dist(predictPos(v, e, SPELL_DELAY), predictPos(v, u, SPELL_DELAY)) <= 3.5);
      if (nearby.length >= 2) {
        const cx = nearby.reduce((s, e) => s + predictPos(v, e, SPELL_DELAY).x, 0) / nearby.length;
        const cy = nearby.reduce((s, e) => s + predictPos(v, e, SPELL_DELAY).y, 0) / nearby.length;
        const pack = spellDamageAt(v, 'Arrows', cx, cy);
        if (pack.killHp >= 450) return legalAction(v, { card: 'Arrows', x: cx, y: cy });
      }
    }
  }

  if (v.phase === 'overtime') {
    const fb2 = bestSpell(v, 'Fireball', 400, 1);
    if (fb2) return legalAction(v, fb2);
  }
  return null;
}

function giantNeedsCannon(v, giant) {
  if (!giant || hasMyCannon(v)) return false;
  if (giant.targetId) {
    const tgt = findEntity(v, giant.targetId);
    if (tgt && (tgt.kind === 'king' || tgt.kind === 'princess')) return false;
  }
  return onMySide(v, giant);
}

function pickDefensiveTroop(v, info) {
  if (info.air > 0 && canPlay(v, 'Archers')) return 'Archers';
  if (info.air > 0 && canPlay(v, 'Musketeer')) return 'Musketeer';
  if (info.hp > 1200 && canPlay(v, 'Knight')) return 'Knight';
  if (info.hp > 600 && canPlay(v, 'Musketeer')) return 'Musketeer';
  if (info.hp > 350 && canPlay(v, 'Knight')) return 'Knight';
  if (info.hp > 180 && canPlay(v, 'Goblins')) return 'Goblins';
  if (canPlay(v, 'Archers')) return 'Archers';
  if (canPlay(v, 'Goblins')) return 'Goblins';
  if (canPlay(v, 'Knight')) return 'Knight';
  return null;
}

function tryDefense(v) {
  const thr = totalThreat(v);
  if (thr.hp < 150 && !thr.giant) return null;

  const lane = threatenedLane(v) || (thr.giant ? laneOf(thr.giant.x, v.arena.width / 2) : 'left');
  const info = lanePressure(v, lane);

  if (thr.giant && giantNeedsCannon(v, thr.giant) && canPlay(v, 'Cannon')) {
    const spot = cannonSpot(v, lane);
    if (spot) return legalAction(v, { card: 'Cannon', x: spot.x, y: spot.y });
  }

  if (thr.hp < 250) return null;
  const troop = pickDefensiveTroop(v, info);
  if (!troop) return null;

  const depth = info.giants || troop === 'Archers' || troop === 'Musketeer' ? 'defense' : 'bridge';
  const spot = troopSpot(v, lane, depth);
  return legalAction(v, { card: troop, x: spot.x, y: spot.y });
}

function survivingPushUnits(v) {
  const f = forward(v);
  return myUnits(v).filter((u) => {
    if (u.deploying || u.hp <= u.maxHp * 0.25) return false;
    return u.y * f > v.arena.mid * f - 1;
  });
}

function trySupport(v) {
  const pushers = survivingPushUnits(v);
  if (!pushers.length) return null;
  const lane = laneOf(pushers[0].x, v.arena.width / 2);
  const hasGiant = pushers.some((u) => u.card === 'Giant');
  const depth = !princessAlive(v, v.enemy.id, lane) ? 'deep' : 'defense';

  if (hasGiant) {
    if (canPlay(v, 'Musketeer')) {
      const spot = troopSpot(v, lane, depth);
      return legalAction(v, { card: 'Musketeer', x: spot.x, y: spot.y });
    }
    if (canPlay(v, 'Archers')) {
      const spot = troopSpot(v, lane, depth);
      return legalAction(v, { card: 'Archers', x: spot.x, y: spot.y });
    }
  }
  if (canPlay(v, 'Goblins') && spendable(v) >= 2) {
    const spot = troopSpot(v, lane, 'bridge');
    return legalAction(v, { card: 'Goblins', x: spot.x, y: spot.y });
  }
  return null;
}

function tryGiantPush(v, lane) {
  if (!canPlay(v, 'Giant')) return null;
  if (urgency(v) > 2.5) return null;
  if (spendable(v) < 5 && elixirAdvantage(v) < 1) return null;
  const minElixir = v.phase === 'overtime' ? 5 : 7;
  if (v.self.elixir < minElixir && elixirAdvantage(v) < 2) return null;
  const spot = troopSpot(v, lane, 'bridge');
  return legalAction(v, { card: 'Giant', x: spot.x, y: spot.y });
}

function tryOffense(v) {
  const sup = trySupport(v);
  if (sup) return sup;

  const lane = pushLane(v);
  const safe = urgency(v) < 1.2;
  const adv = elixirAdvantage(v);
  const punish = v.enemy.elixir <= 2 && enemyUnits(v).filter((u) => onMySide(v, u)).length === 0;

  if (safe && punish && spendable(v) >= 5) {
    const alt = lane === 'left' ? 'right' : 'left';
    const g = tryGiantPush(v, alt);
    if (g) return g;
  }

  if (safe && (adv >= 2 || (v.elixirMult >= 2 && v.self.elixir >= 9))) {
    const g = tryGiantPush(v, lane);
    if (g) return g;
  }

  if (safe && v.time > 8 && spendable(v) >= 3) {
    if (canPlay(v, 'Knight')) {
      const spot = troopSpot(v, lane, 'bridge');
      const act = legalAction(v, { card: 'Knight', x: spot.x, y: spot.y });
      if (act) return act;
    }
  }
  return null;
}

function tryOpening(v) {
  if (v.time > 4.5) return null;
  if (v.self.elixir < 6) return null;
  const lane = pushLane(v);
  if (canPlay(v, 'Goblins')) {
    const spot = troopSpot(v, lane, 'bridge');
    return legalAction(v, { card: 'Goblins', x: spot.x, y: spot.y });
  }
  if (canPlay(v, 'Knight')) {
    const spot = { x: laneX(v, lane), y: deployTroopY(v, lane, 'back') };
    return legalAction(v, { card: 'Knight', x: spot.x, y: spot.y });
  }
  return null;
}

function tryCycle(v) {
  const leakThreshold = v.elixirMult >= 3 ? 7.5 : v.elixirMult >= 2 ? 8 : 9;
  if (v.self.elixir < leakThreshold) return null;
  if (urgency(v) > 0.8) return null;
  if (reserveElixir(v) > 0 && v.self.elixir < leakThreshold + reserveElixir(v)) return null;

  const lane = pushLane(v);
  const order = ['Goblins', 'Archers', 'Knight', 'Cannon'];
  for (const card of order) {
    if (!canPlay(v, card)) continue;
    if (card === 'Cannon') {
      if (hasMyCannon(v)) continue;
      const spot = cannonSpot(v, lane);
      if (spot) return legalAction(v, { card: 'Cannon', x: spot.x, y: spot.y });
      continue;
    }
    const spot = { x: laneX(v, lane), y: deployTroopY(v, lane, 'back') };
    const act = legalAction(v, { card, x: spot.x, y: spot.y });
    if (act) return act;
  }
  return null;
}

export default function bot(view) {
  if (view.phase === 'ended') return null;

  return (
    trySpells(view) ||
    tryDefense(view) ||
    tryOffense(view) ||
    tryOpening(view) ||
    tryCycle(view) ||
    null
  );
}
