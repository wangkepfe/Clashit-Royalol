function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function relY(v, y) {
  return v.self.id === 0 ? y : v.arena.height - y;
}

function canPlay(v, card) {
  const h = v.self.hand.find((x) => x.card === card);
  return !!h && v.self.elixir >= h.cost;
}

function enemyUnits(v) {
  return v.units.filter((u) => !u.mine && u.hp > 0);
}
function myUnits(v) {
  return v.units.filter((u) => u.mine && u.hp > 0);
}
function myTowers(v) {
  return v.towers.filter((t) => t.mine && t.alive);
}
function enemyTowers(v) {
  return v.towers.filter((t) => !t.mine && t.alive);
}

function findEntity(view, id) {
  for (const u of view.units) if (u.id === id) return u;
  for (const t of view.towers) if (t.id === id) return t;
  return null;
}

function predictPos(unit, view, dt) {
  const target = findEntity(view, unit.targetId);
  if (!target) return { x: unit.x, y: unit.y };
  const d = dist(unit, target);
  let targetRadius = 0.5;
  if (target.kind === 'king') targetRadius = 2.0;
  else if (target.kind === 'princess') targetRadius = 1.5;
  else if (target.building) targetRadius = 1.5;
  else if (target.card && view.cards[target.card]) targetRadius = view.cards[target.card].radius || 0.5;
  const reach = unit.range + targetRadius + 0.001;
  if (d <= reach) return { x: unit.x, y: unit.y };
  const dx = target.x - unit.x;
  const dy = target.y - unit.y;
  const step = Math.min(unit.speed * dt, d);
  return { x: unit.x + (dx / d) * step, y: unit.y + (dy / d) * step };
}

function canPlaceBuilding(view, x, y) {
  const br = 1.5;
  const fp = { princess: 1.5, king: 2.0 };
  for (const t of view.towers) {
    if (!t.alive) continue;
    const tr = t.kind === 'king' ? fp.king : fp.princess;
    const dx = x - t.x, dy = y - t.y;
    if (dx * dx + dy * dy < (br + tr) * (br + tr)) return false;
  }
  for (const u of view.units) {
    if (!u.building || u.hp <= 0) continue;
    const ur = 1.5;
    const dx = x - u.x, dy = y - u.y;
    if (dx * dx + dy * dy < (br + ur) * (br + ur)) return false;
  }
  return true;
}

function inTroopZone(view, x, y) {
  if (x < 0.5 || x > view.arena.width - 0.5 || y < 0.5 || y > view.arena.height - 0.5) return false;
  if (view.self.id === 0) {
    if (y <= view.arena.mid - 0.5) return true;
    const side = x < view.arena.width / 2 ? 'left' : 'right';
    const enemyPrincess = view.towers.find((t) => t.owner !== view.self.id && t.kind === 'princess' && t.side === side);
    if (enemyPrincess && !enemyPrincess.alive) return y <= view.arena.height - 6.0;
    return false;
  } else {
    if (y >= view.arena.mid + 0.5) return true;
    const side = x < view.arena.width / 2 ? 'left' : 'right';
    const enemyPrincess = view.towers.find((t) => t.owner !== view.self.id && t.kind === 'princess' && t.side === side);
    if (enemyPrincess && !enemyPrincess.alive) return y >= 6.0;
    return false;
  }
}

function towerHp(view, mine) {
  return view.towers.filter((t) => t.mine === mine && t.alive).reduce((s, t) => s + t.hp, 0);
}

export default function bot(view) {
  try {
    const elixir = view.self.elixir;
    const enemies = enemyUnits(view);
    const mySide = enemies.filter((u) => {
      if (view.self.id === 0) return u.y < view.arena.mid + 3;
      return u.y > view.arena.mid - 3;
    });
    const myCrowns = view.crowns.self;

    // 1. Lethal spells
    for (const t of enemyTowers(view)) {
      if (canPlay(view, 'Fireball') && t.hp <= view.cards.Fireball.towerDmg) {
        return { card: 'Fireball', x: t.x, y: t.y };
      }
      if (canPlay(view, 'Arrows') && t.hp <= view.cards.Arrows.towerDmg) {
        return { card: 'Arrows', x: t.x, y: t.y };
      }
    }

    // 2. Cannon vs Giant (lane-specific, overlap-checked)
    const giants = mySide.filter((u) => u.card === 'Giant');
    if (giants.length > 0 && canPlay(view, 'Cannon')) {
      const existingCannon = myUnits(view).find((u) => u.card === 'Cannon');
      if (!existingCannon) {
        const targetGiant = giants.reduce((best, g) => {
          let bestTowerD = Infinity;
          for (const t of myTowers(view)) {
            const d = dist(g, t);
            if (d < bestTowerD) bestTowerD = d;
          }
          return bestTowerD < best.d ? { g, d: bestTowerD } : best;
        }, { g: giants[0], d: Infinity }).g;
        const lane = targetGiant.x < view.arena.width / 2 ? 'left' : 'right';
        const candidates = [
          { x: 9, y: relY(view, 11) },
          { x: lane === 'left' ? 8 : 10, y: relY(view, 11) },
          { x: lane === 'left' ? 7 : 11, y: relY(view, 11) },
          { x: 9, y: relY(view, 10.5) },
          { x: 9, y: relY(view, 11.5) },
        ];
        for (const c of candidates) {
          if (inTroopZone(view, c.x, c.y) && canPlaceBuilding(view, c.x, c.y)) {
            return { card: 'Cannon', x: c.x, y: c.y };
          }
        }
      }
    }

    // 3. Emergency Goblins vs Giant
    if (giants.length > 0 && canPlay(view, 'Goblins')) {
      const closest = giants.reduce((best, g) => {
        const d = dist(g, { x: view.arena.width / 2, y: view.arena.mid });
        return d < best.d ? { g, d } : best;
      }, { g: giants[0], d: Infinity }).g;
      const tx = clamp(closest.x + (closest.x > view.arena.width / 2 ? -1 : 1), 0.5, view.arena.width - 0.5);
      const ty = clamp(closest.y + (view.self.id === 0 ? -1 : 1), 0.5, view.arena.height - 0.5);
      if (inTroopZone(view, tx, ty)) {
        return { card: 'Goblins', x: tx, y: ty };
      }
    }

    // 4. Arrows on Goblins/Archers (predicted)
    if (canPlay(view, 'Arrows')) {
      for (const u of enemies) {
        if ((u.card === 'Goblins' || u.card === 'Archers') && myTowers(view).some((t) => dist(u, t) < 6)) {
          const pred = predictPos(u, view, 1.0);
          return { card: 'Arrows', x: clamp(pred.x, 0, view.arena.width), y: clamp(pred.y, 0, view.arena.height) };
        }
      }
    }

    // 5. Fireball on clumps (predicted, king-safe)
    if (canPlay(view, 'Fireball')) {
      const king = view.towers.find((t) => !t.mine && t.kind === 'king');
      const kingActive = king ? king.activated : true;
      const centers = [];
      for (const u of enemies) centers.push(predictPos(u, view, 1.0));
      for (let i = 0; i < enemies.length; i++) {
        for (let j = i + 1; j < enemies.length; j++) {
          centers.push({ x: (enemies[i].x + enemies[j].x) / 2, y: (enemies[i].y + enemies[j].y) / 2 });
        }
      }
      let bestAction = null;
      let bestScore = 0;
      for (const pred of centers) {
        let score = 0, kills = 0, hitsTower = false;
        for (const other of enemies) {
          if (dist(pred, other) <= 2.5) {
            if (other.hp <= view.cards.Fireball.dmg) { kills++; score += other.maxHp; }
            else score += view.cards.Fireball.dmg;
          }
        }
        for (const t of enemyTowers(view)) {
          if (dist(pred, t) <= 2.5) { hitsTower = true; score += view.cards.Fireball.towerDmg; }
        }
        if (king && !kingActive && dist(pred, king) <= 2.5 && myCrowns < 2) score -= 500;
        if (score > bestScore && (kills >= 2 || (kills >= 1 && hitsTower) || score >= 700)) {
          bestScore = score;
          bestAction = { card: 'Fireball', x: clamp(pred.x, 0, view.arena.width), y: clamp(pred.y, 0, view.arena.height) };
        }
      }
      if (bestAction) return bestAction;
    }

    // 6. Overtime spell cycling if ahead
    if (view.phase === 'overtime' && towerHp(view, true) > towerHp(view, false)) {
      const targetPrincess = enemyTowers(view).find((t) => t.kind === 'princess');
      if (targetPrincess) {
        if (canPlay(view, 'Fireball') && elixir >= 7) {
          return { card: 'Fireball', x: targetPrincess.x, y: targetPrincess.y };
        }
        if (canPlay(view, 'Arrows') && elixir >= 6) {
          return { card: 'Arrows', x: targetPrincess.x, y: targetPrincess.y };
        }
      }
    }

    // 7. Giant (aggressive)
    if (canPlay(view, 'Giant')) {
      let gx = 9;
      const leftDead = !(view.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'left')?.alive);
      const rightDead = !(view.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'right')?.alive);
      if (leftDead && !rightDead) gx = 5;
      else if (rightDead && !leftDead) gx = 13;
      return { card: 'Giant', x: gx, y: relY(view, 10) };
    }

    // 8. Support behind push (spread)
    const pushers = myUnits(view).filter((u) => (u.card === 'Giant' || u.card === 'Knight') && !u.deploying);
    if (pushers.length > 0 && elixir >= 4) {
      const p = pushers[0];
      const py = view.self.id === 0 ? p.y : view.arena.height - p.y;
      if (py >= 10) {
        const sideOffset = (view.tick % 2 === 0) ? 1.5 : -1.5;
        if (canPlay(view, 'Musketeer')) {
          return { card: 'Musketeer', x: clamp(p.x + sideOffset, 0.5, view.arena.width - 0.5), y: view.self.id === 0 ? p.y - 3 : p.y + 3 };
        }
        if (canPlay(view, 'Archers')) {
          return { card: 'Archers', x: clamp(p.x + sideOffset * 0.8, 0.5, view.arena.width - 0.5), y: view.self.id === 0 ? p.y - 3.5 : p.y + 3.5 };
        }
      }
    }

    // 9. Knight at bridge
    if (canPlay(view, 'Knight') && elixir >= 6) {
      let bx = (view.tick % 2 === 0) ? 3.5 : 14.5;
      const leftDead = !(view.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'left')?.alive);
      const rightDead = !(view.towers.find((t) => !t.mine && t.kind === 'princess' && t.side === 'right')?.alive);
      if (leftDead && !rightDead) bx = 3.5;
      else if (rightDead && !leftDead) bx = 14.5;
      return { card: 'Knight', x: bx, y: relY(view, 15.4) };
    }

    // 10. Musketeer in back
    if (canPlay(view, 'Musketeer') && elixir >= 7 && !myUnits(view).some((u) => u.card === 'Musketeer')) {
      return { card: 'Musketeer', x: (view.tick % 2 === 0) ? 3.5 : 14.5, y: relY(view, 4) };
    }

    // 11. Archers in back
    if (canPlay(view, 'Archers') && elixir >= 8) {
      return { card: 'Archers', x: (view.tick % 2 === 0) ? 3.5 : 14.5, y: relY(view, 4) };
    }

    // 12. Preemptive Cannon if opponent has Giant
    if (canPlay(view, 'Cannon') && elixir >= 6) {
      const enemyHand = view.enemy.hand.map((h) => h.card);
      if (enemyHand.includes('Giant') && view.enemy.elixir >= 5) {
        const candidates = [{ x: 9, y: relY(view, 11) }, { x: 8, y: relY(view, 11) }, { x: 10, y: relY(view, 11) }];
        for (const c of candidates) {
          if (inTroopZone(view, c.x, c.y) && canPlaceBuilding(view, c.x, c.y)) {
            return { card: 'Cannon', x: c.x, y: c.y };
          }
        }
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}
