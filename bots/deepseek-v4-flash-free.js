import { dist, myUnits, enemyUnits, myTowers, enemyTowers, canPlay, laneX, bestSpellTarget } from './lib.js';

const TROOP_ORDER = ['Goblins', 'Archers', 'Knight', 'Musketeer'];
const SPELL_RADIUS = { Fireball: 2.5, Arrows: 3.5 };
const SPELL_MINVAL = { Fireball: 700, Arrows: 350 };

export default function bot(v) {
  if (v.phase === 'ended') return null;

  const { self, arena, cards } = v;
  const elixir = self.elixir;
  const hand = self.hand;
  const mySide = self.id === 0;
  const myHalfY = mySide ? arena.mid - 1 : arena.mid + 1;
  const backY = mySide ? 10 : 22;

  const enU = enemyUnits(v);
  const myU = myUnits(v);
  const myAT = myTowers(v).filter(t => t.alive);

  let leftV = 0, rightV = 0;
  for (const u of enU) {
    if (u.x < arena.width / 2) leftV += cards[u.card]?.hp || u.maxHp;
    else rightV += cards[u.card]?.hp || u.maxHp;
  }
  const tLane = (leftV >= rightV && leftV > 0) ? 'left' : (rightV > 0 ? 'right' : null);

  let danger = Infinity;
  for (const t of myAT) {
    if (t.kind !== 'princess') continue;
    for (const u of enU) danger = Math.min(danger, dist(t, u));
  }

  const enGiant = enU.find(u => u.card === 'Giant');
  const myGiant = myU.find(u => u.card === 'Giant');
  const hasBuilding = myU.some(u => u.building && u.hp > 0);

  const leftLane = (u) => u.x < arena.width / 2;

  function deploy(card, x, y) {
    return { card, x, y };
  }

  function placeTroop(card, lane) {
    return deploy(card, laneX(v, lane), myHalfY);
  }

  function bestTroopInHand(lane) {
    for (const name of TROOP_ORDER) {
      if (canPlay(v, name)) return placeTroop(name, lane);
    }
    return null;
  }

  // 1. Cannon pull for enemy Giant
  if (enGiant && canPlay(v, 'Cannon') && !hasBuilding) {
    const lane = leftLane(enGiant) ? 'left' : 'right';
    const lanes = [lane, lane === 'left' ? 'right' : 'left'];
    for (const tryLane of lanes) {
      const cx = laneX(v, tryLane);
      const cy = mySide
        ? Math.max(7.5, Math.min(enGiant.y - 0.5, arena.mid - 0.5))
        : Math.min(arena.height - 7.5, Math.max(enGiant.y + 0.5, arena.mid + 0.5));
      const blockedByTower = myAT.some(t => {
        const tr = t.kind === 'king' ? 2.0 : 1.5;
        const dx = cx - t.x, dy = cy - t.y;
        return (dx * dx + dy * dy) < (1.5 + tr) * (1.5 + tr);
      });
      const blockedByBuilding = v.units.some(u => {
        if (!u.building || u.hp <= 0 || u.mine) return false;
        const dx = cx - u.x, dy = cy - u.y;
        return (dx * dx + dy * dy) < 9;
      });
      if (!blockedByTower && !blockedByBuilding) return deploy('Cannon', cx, cy);
    }
  }

  // 2. Emergency defense — units threaten princess tower
  if (danger < 5 && tLane) {
    const troop = bestTroopInHand(tLane);
    if (troop) return troop;
  }

  // 3. Spell value
  for (const [name, radius] of Object.entries(SPELL_RADIUS)) {
    if (canPlay(v, name)) {
      const t = bestSpellTarget(v, radius, SPELL_MINVAL[name]);
      if (t) return deploy(name, t.x, t.y);
    }
  }

  // 4. Giant push
  if (!myGiant && canPlay(v, 'Giant')) {
    const survivors = myU.filter(u => !u.building && u.card !== 'Giant' && u.hp > 0);
    const lowThreat = (leftV + rightV) < 500;
    const canCounter = survivors.length > 0 && lowThreat && elixir >= 5;
    if (canCounter || elixir >= 8) {
      const et = enemyTowers(v);
      const lhp = et.filter(t => t.side === 'left').reduce((s, t) => s + t.hp, 0);
      const rhp = et.filter(t => t.side === 'right').reduce((s, t) => s + t.hp, 0);
      const lane = lhp <= rhp ? 'left' : 'right';
      const gx = laneX(v, lane);
      const gy = canCounter
        ? (mySide
            ? Math.min(Math.max(...survivors.map(u => u.y)) + 2, arena.mid - 0.5)
            : Math.max(Math.min(...survivors.map(u => u.y)) - 2, arena.mid + 0.5))
        : backY;
      return deploy('Giant', gx, Math.max(0.5, Math.min(arena.height - 0.5, gy)));
    }
  }

  // 5. Support existing Giant
  if (myGiant && (mySide ? myGiant.y > arena.mid - 6 : myGiant.y < arena.mid + 6)) {
    if (!myU.some(u => u.card === 'Musketeer' && u.hp > 0 && dist(u, myGiant) < 8) && canPlay(v, 'Musketeer') && elixir >= 4)
      return deploy('Musketeer', myGiant.x, myHalfY);
    if (!myU.some(u => u.card === 'Archers' && u.hp > 0 && dist(u, myGiant) < 8) && canPlay(v, 'Archers') && elixir >= 3)
      return deploy('Archers', myGiant.x, myHalfY);
  }

  // 6. Preemptive defense
  if (tLane && !myU.some(u => !u.building && u.hp > 0) && elixir > 3) {
    const troop = bestTroopInHand(tLane);
    if (troop) return troop;
  }

  // 7. Cycle — avoid elixir leak
  if (elixir >= 8) {
    const cycleable = hand.filter(h => {
      if (h.card === 'Giant') return false;
      if (h.card === 'Cannon' && hasBuilding) return false;
      const def = cards[h.card];
      if (def?.kind === 'spell') {
        return !!bestSpellTarget(v, SPELL_RADIUS[h.card] || def.radius, 1);
      }
      return true;
    });
    const sorted = cycleable.sort((a, b) => a.cost - b.cost);
    if (sorted.length > 0)
      return deploy(sorted[0].card, laneX(v, tLane || 'left'), myHalfY);
    const anyCard = hand.filter(h => h.card !== 'Giant').sort((a, b) => a.cost - b.cost)[0];
    if (anyCard) return deploy(anyCard.card, laneX(v, tLane || 'left'), myHalfY);
  }

  // 8. Opening
  if (v.time < 6) {
    const opener = hand.filter(h => {
      if (h.card === 'Giant' || h.card === 'Cannon') return false;
      if (cards[h.card]?.kind === 'spell') return false;
      return elixir >= h.cost;
    }).sort((a, b) => a.cost - b.cost)[0];
    if (opener) return deploy(opener.card, laneX(v, 'left'), myHalfY);
  }

  return null;
}
