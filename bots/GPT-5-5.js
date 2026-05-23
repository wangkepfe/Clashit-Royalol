const ARENA_W = 18;
const ARENA_H = 32;
const MID_X = 9;

const COST = {
  Knight: 3,
  Archers: 3,
  Goblins: 2,
  Giant: 5,
  Cannon: 3,
  Musketeer: 4,
  Fireball: 4,
  Arrows: 3,
};

const TROOP_VALUE = {
  Giant: 1700,
  Musketeer: 900,
  Knight: 680,
  Goblins: 390,
  Archers: 330,
  Cannon: 520,
};

function ySelf(v, y) {
  return v.self.id === 0 ? y : ARENA_H - y;
}

function normY(v, e) {
  return v.self.id === 0 ? e.y : ARENA_H - e.y;
}

function laneX(lane) {
  return lane === 'left' ? 3.5 : 14.5;
}

function laneOf(x) {
  return x < MID_X ? 'left' : 'right';
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function hand(v, card) {
  return v.self.hand.some((h) => h.card === card);
}

function can(v, card, reserve = 0) {
  return hand(v, card) && v.self.elixir >= COST[card] + reserve;
}

function mine(v) {
  return v.units.filter((u) => u.mine && u.hp > 0);
}

function enemy(v) {
  return v.units.filter((u) => !u.mine && u.hp > 0);
}

function myTowers(v) {
  return v.towers.filter((t) => t.mine && t.alive);
}

function enemyTowers(v) {
  return v.towers.filter((t) => !t.mine && t.alive);
}

function totalTowerHp(towers) {
  let hp = 0;
  for (const t of towers) hp += t.hp;
  return hp;
}

function weakTower(v) {
  const princesses = enemyTowers(v)
    .filter((t) => t.kind === 'princess')
    .sort((a, b) => a.hp - b.hp);
  return princesses[0] || enemyTowers(v).find((t) => t.kind === 'king') || enemyTowers(v)[0] || null;
}

function bestLane(v) {
  const t = weakTower(v);
  if (!t) return 'right';
  if (t.side !== 'center') return t.side;
  const living = enemyTowers(v).filter((x) => x.kind === 'princess');
  if (!living.length) return 'right';
  living.sort((a, b) => a.hp - b.hp);
  return living[0].side;
}

function legalBuilding(v, x, y) {
  for (const t of v.towers) {
    if (!t.alive) continue;
    const r = 1.5 + (t.kind === 'king' ? 2.0 : 1.5);
    const dx = x - t.x;
    const dy = y - t.y;
    if (dx * dx + dy * dy < r * r) return false;
  }
  for (const u of v.units) {
    if (!u.building || u.hp <= 0) continue;
    const dx = x - u.x;
    const dy = y - u.y;
    if (dx * dx + dy * dy < 9.0) return false;
  }
  return true;
}

function cannonSpot(v, threat) {
  const lane = threat ? laneOf(threat.x) : 'center';
  const xs = lane === 'left'
    ? [8.1, 9.2, 6.7, 10.6]
    : lane === 'right'
      ? [9.9, 8.8, 11.3, 7.4]
      : [9.0, 7.4, 10.6];
  const ys = [12.2, 11.2, 13.3, 10.2, 14.2];
  for (const yy of ys) {
    for (const xx of xs) {
      const y = ySelf(v, yy);
      if (legalBuilding(v, xx, y)) return { x: xx, y };
    }
  }
  return null;
}

function nearestTower(v, u, wantMine) {
  const ts = wantMine ? myTowers(v) : enemyTowers(v);
  let best = null;
  let bestD = Infinity;
  for (const t of ts) {
    const d = dist(u, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function leadPoint(v, u, seconds) {
  if (u.building || !u.speed) return { x: u.x, y: u.y };
  let target = null;
  if (u.targetId != null) {
    target = v.units.find((e) => e.id === u.targetId) || v.towers.find((e) => e.id === u.targetId);
  }
  if (!target) target = nearestTower(v, u, u.mine);
  if (!target) return { x: u.x, y: u.y };
  const dx = target.x - u.x;
  const dy = target.y - u.y;
  const len = Math.hypot(dx, dy) || 1;
  const step = Math.min(len, u.speed * seconds);
  return {
    x: clamp(u.x + (dx / len) * step, 0, ARENA_W),
    y: clamp(u.y + (dy / len) * step, 0, ARENA_H),
  };
}

function spellChoice(v, card) {
  const def = v.cards[card];
  const foes = enemy(v).filter((u) => !(u.building && u.lifetime < 1.0));
  const candidates = [];
  for (const u of foes) candidates.push(leadPoint(v, u, 0.9));
  for (const t of enemyTowers(v)) candidates.push({ x: t.x, y: t.y });

  let best = null;
  for (const c of candidates) {
    let score = 0;
    let hits = 0;
    let kills = 0;
    let tower = 0;
    let danger = 0;

    for (const u of foes) {
      const p = leadPoint(v, u, 0.9);
      if (dist(p, c) > def.radius) continue;
      hits++;
      const lethal = u.hp <= def.dmg + 2;
      if (lethal) kills++;

      let value = Math.min(u.hp, def.dmg);
      if (u.card === 'Musketeer') value += lethal ? 340 : 170;
      else if (u.card === 'Archers') value += lethal ? 190 : 70;
      else if (u.card === 'Goblins') value += lethal ? 110 : 40;
      else if (u.card === 'Cannon') value += 160;
      else if (u.card === 'Giant') value *= 0.42;
      else if (u.card === 'Knight') value *= 0.68;

      const y = normY(v, u);
      if (y < 17.3) danger += 180;
      else if (y < 20.5) danger += 80;
      score += value;
    }

    for (const t of enemyTowers(v)) {
      if (dist(t, c) <= def.radius) tower += def.towerDmg || 0;
    }

    score += tower * 1.85 + danger;
    if (tower && hits) score += 240;
    if (kills >= 2) score += 150;
    if (!best || score > best.score) best = { x: c.x, y: c.y, score, hits, kills, tower };
  }
  return best;
}

function pressure(v) {
  const lanes = { left: 0, right: 0 };
  let total = 0;
  let main = null;
  let mainScore = -1;
  let giant = null;

  for (const u of enemy(v)) {
    const y = normY(v, u);
    const lane = laneOf(u.x);
    let score = TROOP_VALUE[u.card] || u.hp;

    if (y > 21.5 && !u.targetId) score *= 0.22;
    else if (y > 18.6) score *= 0.55;
    else if (y < 11.8) score *= 1.22;
    if (u.deploying) score *= 0.82;

    if (y < 20.8) {
      lanes[lane] += score;
      total += score;
    }
    if (score > mainScore && y < 21.2) {
      mainScore = score;
      main = u;
    }
    if (u.card === 'Giant' && y < 22.2 && (!giant || y < normY(v, giant))) giant = u;
  }

  return {
    lanes,
    total,
    main,
    giant,
    lane: lanes.left >= lanes.right ? 'left' : 'right',
  };
}

function pushUnit(v) {
  let best = null;
  let score = 0;
  for (const u of mine(v)) {
    if (u.building) continue;
    const y = normY(v, u);
    if (y < 9.8) continue;
    const base = u.card === 'Giant'
      ? 1850
      : u.card === 'Musketeer'
        ? 780
        : u.card === 'Knight'
          ? 560
          : u.card === 'Archers'
            ? 330
            : u.card === 'Goblins'
              ? 280
              : 200;
    const s = base + y * 23;
    if (s > score) {
      score = s;
      best = u;
    }
  }
  return best;
}

function clearEnough(v, p, extra = 0) {
  return p.total < (v.doubleElixir ? 1000 : 720) + extra;
}

function answerUnit(v, u) {
  const y = normY(v, u);
  const x = clamp(u.x, 1.2, 16.8);
  const onTop = ySelf(v, clamp(y - 0.8, 7.2, 14.4));
  const back = ySelf(v, clamp(y - 3.0, 6.3, 13.4));
  const lane = laneOf(u.x);

  if (u.card === 'Musketeer' || u.card === 'Archers') {
    if (can(v, 'Knight')) return { card: 'Knight', x, y: onTop };
    if (can(v, 'Goblins')) return { card: 'Goblins', x, y: onTop };
    if (can(v, 'Archers') && u.card === 'Musketeer') return { card: 'Archers', x: laneX(lane), y: back };
  }

  if (u.card === 'Goblins') {
    if (can(v, 'Archers')) return { card: 'Archers', x, y: back };
    if (can(v, 'Knight')) return { card: 'Knight', x, y: onTop };
  }

  if (u.card === 'Giant') {
    if (can(v, 'Goblins')) return { card: 'Goblins', x, y: ySelf(v, clamp(y - 0.5, 7.0, 14.2)) };
    if (can(v, 'Musketeer')) return { card: 'Musketeer', x: laneX(lane), y: ySelf(v, 9.4) };
    if (can(v, 'Archers')) return { card: 'Archers', x: laneX(lane), y: ySelf(v, 9.1) };
    if (can(v, 'Knight')) return { card: 'Knight', x, y: onTop };
  }

  if (u.card === 'Knight') {
    if (can(v, 'Goblins')) return { card: 'Goblins', x, y: onTop };
    if (can(v, 'Musketeer')) return { card: 'Musketeer', x: laneX(lane), y: ySelf(v, 9.2) };
    if (can(v, 'Archers')) return { card: 'Archers', x: laneX(lane), y: ySelf(v, 9.0) };
  }

  return null;
}

function towerChip(v, p, target, behind) {
  if (!target) return null;
  const urgent = v.phase === 'overtime' || v.timeRemaining < 18 || (behind > 620 && p.total < 1300);
  if (can(v, 'Fireball') && (v.self.elixir > 9.6 || urgent) && p.total < (urgent ? 1450 : 760)) {
    return { card: 'Fireball', x: target.x, y: target.y };
  }
  if (can(v, 'Arrows') && (target.hp <= 93 || (v.self.elixir > 9.8 && p.total < 720) || (v.timeRemaining < 10 && p.total < 980))) {
    return { card: 'Arrows', x: target.x, y: target.y };
  }
  return null;
}

export default function bot(v) {
  if (!v || v.phase === 'ended') return null;

  const p = pressure(v);
  const target = weakTower(v);
  const lane = bestLane(v);
  const myHp = totalTowerHp(myTowers(v));
  const enemyHp = totalTowerHp(enemyTowers(v));
  const hpBehind = enemyHp - myHp;

  if (target) {
    if (target.hp <= 207 && can(v, 'Fireball')) return { card: 'Fireball', x: target.x, y: target.y };
    if (target.hp <= 93 && can(v, 'Arrows')) return { card: 'Arrows', x: target.x, y: target.y };
  }

  if (can(v, 'Arrows')) {
    const arrows = spellChoice(v, 'Arrows');
    if (arrows && (arrows.score >= 860 || (arrows.kills >= 2 && p.total > 430) || (arrows.hits >= 3 && p.total > 260))) {
      return { card: 'Arrows', x: arrows.x, y: arrows.y };
    }
  }

  if (can(v, 'Fireball')) {
    const fb = spellChoice(v, 'Fireball');
    if (fb && (fb.score >= 1250 || (fb.hits >= 2 && fb.tower && fb.score >= 850) || (fb.hits >= 2 && p.total > 850))) {
      return { card: 'Fireball', x: fb.x, y: fb.y };
    }
  }

  if (p.giant && can(v, 'Cannon')) {
    const covered = mine(v).some((u) => u.building && u.card === 'Cannon' && u.hp > 150 && dist(u, p.giant) < 6.9);
    if (!covered) {
      const spot = cannonSpot(v, p.giant);
      if (spot) return { card: 'Cannon', x: spot.x, y: spot.y };
    }
  }

  if (p.main && normY(v, p.main) < 18.8) {
    const a = answerUnit(v, p.main);
    if (a) return a;
  }

  if (p.total > 950) {
    if (can(v, 'Musketeer')) return { card: 'Musketeer', x: laneX(p.lane), y: ySelf(v, 9.3) };
    if (can(v, 'Archers')) return { card: 'Archers', x: laneX(p.lane), y: ySelf(v, 9.0) };
    if (can(v, 'Knight')) return { card: 'Knight', x: laneX(p.lane), y: ySelf(v, 12.5) };
    if (can(v, 'Goblins')) return { card: 'Goblins', x: laneX(p.lane), y: ySelf(v, 12.5) };
  }

  const push = pushUnit(v);
  if (push && clearEnough(v, p, 260)) {
    const pushLane = laneOf(push.x);
    const y = normY(v, push);
    const supportY = ySelf(v, clamp(y - 3.4, 4.8, 14.1));

    if (push.card === 'Giant') {
      if (can(v, 'Musketeer')) return { card: 'Musketeer', x: laneX(pushLane), y: supportY };
      if (can(v, 'Archers')) return { card: 'Archers', x: laneX(pushLane), y: supportY };
      if (can(v, 'Knight') && y > 12.0) return { card: 'Knight', x: laneX(pushLane), y: ySelf(v, clamp(y - 1.8, 8.0, 14.6)) };
      if (can(v, 'Goblins') && y > 13.4) return { card: 'Goblins', x: laneX(pushLane), y: ySelf(v, clamp(y - 1.2, 9.0, 14.8)) };
    } else if (can(v, 'Giant') && v.self.elixir >= 7.0 && y > 12.8) {
      return { card: 'Giant', x: laneX(pushLane), y: ySelf(v, 14.6) };
    }
  }

  const chip = towerChip(v, p, target, hpBehind);
  if (chip) return chip;

  if (clearEnough(v, p, 430) && v.self.elixir >= (v.doubleElixir ? 8.0 : 9.0)) {
    const x = laneX(lane);
    if (can(v, 'Giant')) return { card: 'Giant', x, y: ySelf(v, 7.0) };
    if (can(v, 'Musketeer')) return { card: 'Musketeer', x, y: ySelf(v, 6.2) };
    if (can(v, 'Knight')) return { card: 'Knight', x, y: ySelf(v, 13.8) };
    if (can(v, 'Archers')) return { card: 'Archers', x, y: ySelf(v, 6.6) };
    if (can(v, 'Goblins')) return { card: 'Goblins', x, y: ySelf(v, 14.0) };
  }

  if (target && can(v, 'Fireball') && v.self.elixir > 9.75 && p.total < 1450) {
    return { card: 'Fireball', x: target.x, y: target.y };
  }

  return null;
}
