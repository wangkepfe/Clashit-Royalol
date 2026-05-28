/**
 * Bot Royale - Ultimate Competitive Bot
 * Name: gemini-cli
 * 
 * Strategy:
 * - Elixir Efficiency: Minimize leakage, cycle low-cost units if needed.
 * - Defense: Use Cannon to pull Giants and buildings-only units. Use swarms for high DPS.
 * - Offense: Slow Giant pushes supported by Musketeer/Archers.
 * - Spells: Optimized targeting for value (hitting multiple units + towers).
 */

// --- Internal Helpers ---

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function myUnits(v) { return v.units.filter(u => u.mine); }
function enemyUnits(v) { return v.units.filter(u => !u.mine); }
function myTowers(v) { return v.towers.filter(t => t.mine && t.alive); }
function enemyTowers(v) { return v.towers.filter(t => !t.mine && t.alive); }

function forward(v) { return v.self.id === 0 ? 1 : -1; }

function getHandIndex(v, cardName) {
  return v.self.hand.findIndex(h => h.card === cardName);
}

function canAfford(v, cardName) {
  const h = v.self.hand.find(x => x.card === cardName);
  return h && v.self.elixir >= h.cost;
}

function laneX(v, lane) {
  return lane === 'left' ? v.arena.width * 0.25 : v.arena.width * 0.75;
}

function bestSpellTarget(v, radius, minWeight, spellKind) {
  const en = v.units.filter(u => !u.mine);
  const et = v.towers.filter(t => !t.mine && t.alive);
  if (en.length === 0 && et.length === 0) return null;

  let best = null, bestVal = 0;
  const targets = en.concat(et);

  for (const c of targets) {
    let val = 0;
    for (const e of en) {
      if (dist(c, e) <= radius) {
        if (spellKind === 'Arrows') {
          // Arrows: 366 dmg. Priority to Archers (304), Goblins (202).
          if (e.hp <= 400) val += e.hp;
          else val += 50; 
        } else {
          // Fireball: 688 dmg. Priority to Musketeer (721), Archers, Knight.
          val += Math.min(e.hp, 688);
        }
      }
    }
    for (const t of et) {
      if (dist(c, t) <= radius) {
        val += (spellKind === 'Arrows' ? 93 : 207) * 1.5;
      }
    }

    if (val > bestVal) {
      bestVal = val;
      best = { x: c.x, y: c.y, value: val };
    }
  }
  return (best && best.value >= minWeight) ? best : null;
}

// --- Main Bot Logic ---

export default function bot(view) {
  const { self, arena, tick } = view;
  const isBottom = self.id === 0;
  const fwd = forward(view);
  const yv = (y) => isBottom ? y : arena.height - y;
  
  const myU = myUnits(view);
  const enU = enemyUnits(view);
  const myT = myTowers(view);
  const enT = enemyTowers(view);

  // 1. Spell Finishers (Highest Priority)
  for (const t of enT) {
    if (t.hp <= 93 && canAfford(view, 'Arrows')) {
      const idx = getHandIndex(view, 'Arrows');
      if (idx !== -1) return { handIndex: idx, x: t.x, y: t.y };
    }
    if (t.hp <= 207 && canAfford(view, 'Fireball')) {
      const idx = getHandIndex(view, 'Fireball');
      if (idx !== -1) return { handIndex: idx, x: t.x, y: t.y };
    }
  }

  // 2. Defensive Spells
  const arrowTarget = bestSpellTarget(view, 3.5, 450, 'Arrows');
  if (arrowTarget && canAfford(view, 'Arrows')) {
    return { handIndex: getHandIndex(view, 'Arrows'), x: arrowTarget.x, y: arrowTarget.y };
  }

  const fireballTarget = bestSpellTarget(view, 2.5, 750, 'Fireball');
  if (fireballTarget && canAfford(view, 'Fireball')) {
    return { handIndex: getHandIndex(view, 'Fireball'), x: fireballTarget.x, y: fireballTarget.y };
  }

  // 3. Reactive Defense
  const myHalfY = isBottom ? arena.mid - 1 : arena.mid + 1;
  const threats = enU.filter(u => isBottom ? u.y < myHalfY : u.y > myHalfY);
  
  if (threats.length > 0) {
    // Priority: Giant, then closest to our towers
    threats.sort((a, b) => {
      if (a.card === 'Giant' && b.card !== 'Giant') return -1;
      if (b.card === 'Giant' && a.card !== 'Giant') return 1;
      const distA = Math.min(...myT.map(t => dist(a, t)));
      const distB = Math.min(...myT.map(t => dist(b, t)));
      return distA - distB;
    });

    const target = threats[0];
    
    // Giant Pull with Cannon
    if (target.card === 'Giant' && canAfford(view, 'Cannon')) {
      const tx = target.x < 9 ? 7.5 : 10.5;
      return { handIndex: getHandIndex(view, 'Cannon'), x: tx, y: yv(11) };
    }

    // Direct Defense
    if (canAfford(view, 'Knight')) {
      return { handIndex: getHandIndex(view, 'Knight'), x: target.x, y: target.y - fwd * 1.5 };
    }
    if (canAfford(view, 'Goblins')) {
      return { handIndex: getHandIndex(view, 'Goblins'), x: target.x, y: target.y - fwd * 0.5 };
    }
    if (canAfford(view, 'Archers')) {
      return { handIndex: getHandIndex(view, 'Archers'), x: target.x, y: target.y - fwd * 3.5 };
    }
  }

  // 4. Elixir Management & Offense
  if (self.elixir >= 9.5) {
    // Choose lane based on enemy tower health or tick-based determinism
    const weakTower = enT.sort((a, b) => a.hp - b.hp)[0];
    const lane = weakTower ? (weakTower.x < 9 ? 'left' : 'right') : (tick % 60 < 30 ? 'left' : 'right');
    
    if (canAfford(view, 'Giant')) {
      return { handIndex: getHandIndex(view, 'Giant'), x: laneX(view, lane), y: yv(1.5) };
    }
    
    // Cycle slow units in the back
    const cycleOptions = ['Knight', 'Musketeer', 'Archers'];
    for (const c of cycleOptions) {
      if (canAfford(view, c)) {
        return { handIndex: getHandIndex(view, c), x: laneX(view, lane), y: yv(1.5) };
      }
    }
    
    // Low-cost cycle
    if (canAfford(view, 'Goblins')) {
      return { handIndex: getHandIndex(view, 'Goblins'), x: 9, y: yv(1.5) };
    }
  }

  // 5. Support active Giant
  const activeGiant = myU.find(u => u.card === 'Giant' && (isBottom ? u.y > 6 : u.y < 26));
  if (activeGiant && self.elixir >= 4.5) {
    if (canAfford(view, 'Musketeer')) {
      return { handIndex: getHandIndex(view, 'Musketeer'), x: activeGiant.x, y: activeGiant.y - fwd * 2.5 };
    }
    if (canAfford(view, 'Archers')) {
      return { handIndex: getHandIndex(view, 'Archers'), x: activeGiant.x, y: activeGiant.y - fwd * 2.5 };
    }
  }

  return null;
}
