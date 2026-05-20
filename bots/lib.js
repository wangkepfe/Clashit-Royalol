// Optional helper functions bots may import. None of this is required — a bot is
// just `(view) => action | null` — but these cover the common queries.

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const myUnits = (v) => v.units.filter((u) => u.mine);
export const enemyUnits = (v) => v.units.filter((u) => !u.mine);
export const myTowers = (v) => v.towers.filter((t) => t.mine && t.alive);
export const enemyTowers = (v) => v.towers.filter((t) => !t.mine && t.alive);

// The direction this player pushes: player 0 goes +y, player 1 goes -y.
export const forward = (v) => (v.self.id === 0 ? 1 : -1);

export function inHand(v, card) {
  return v.self.hand.some((h) => h.card === card);
}

export function canPlay(v, card) {
  const h = v.self.hand.find((x) => x.card === card);
  return !!h && v.self.elixir >= h.cost;
}

// Cheapest card currently in hand the player can afford (or null).
export function cheapestAffordable(v) {
  let best = null;
  for (const h of v.self.hand) {
    if (v.self.elixir >= h.cost && (!best || h.cost < best.cost)) best = h;
  }
  return best ? best.card : null;
}

// A defensive y just in front of one of my princess towers, clamped to my half.
export function behindTowerY(v) {
  return v.self.id === 0 ? v.arena.mid - 2.5 : v.arena.mid + 2.5;
}

// Which lane ('left'|'right') has the most enemy unit pressure on my side.
export function threatenedLane(v) {
  let left = 0, right = 0;
  for (const u of enemyUnits(v)) {
    const onMySide = v.self.id === 0 ? u.y < v.arena.mid + 4 : u.y > v.arena.mid - 4;
    if (!onMySide) continue;
    if (u.x < v.arena.width / 2) left += u.maxHp;
    else right += u.maxHp;
  }
  if (left === 0 && right === 0) return null;
  return left >= right ? 'left' : 'right';
}

export function laneX(v, lane) {
  return lane === 'left' ? v.arena.width * 0.25 : v.arena.width * 0.75;
}

// Center of the largest cluster of enemy units (for spells), or null.
export function bestSpellTarget(v, radius, minHp) {
  const en = enemyUnits(v);
  let best = null, bestVal = 0;
  for (const c of en) {
    let val = 0;
    for (const e of en) if (dist(c, e) <= radius) val += e.maxHp;
    if (val > bestVal) {
      bestVal = val;
      best = { x: c.x, y: c.y, value: val };
    }
  }
  return best && best.value >= (minHp || 0) ? best : null;
}
