// Reactive: defend the threatened lane efficiently, then counter-push with
// whatever survives plus a Giant when elixir is healthy.
import {
  canPlay, enemyUnits, myUnits, threatenedLane, laneX,
  behindTowerY, bestSpellTarget,
} from './lib.js';

export default function defender(v) {
  const me = v.self;

  // 1) Spell big clumps (great value defensively).
  if (canPlay(v, 'Fireball')) {
    const t = bestSpellTarget(v, v.cards.Fireball.radius, 360);
    if (t) return { card: 'Fireball', x: t.x, y: t.y };
  }
  if (canPlay(v, 'Arrows')) {
    const t = bestSpellTarget(v, v.cards.Arrows.radius, 240);
    if (t) return { card: 'Arrows', x: t.x, y: t.y };
  }

  // 2) Defend: is something dangerous on my half?
  const lane = threatenedLane(v);
  if (lane) {
    const threats = enemyUnits(v);
    const anyAir = threats.some((u) => u.flying);
    const anyTank = threats.some((u) => u.maxHp >= 1200);
    const x = laneX(v, lane);
    const y = behindTowerY(v);

    const order = anyAir
      ? ['Musketeer', 'Archers', 'Minions', 'Knight', 'Goblins']
      : anyTank
      ? ['Knight', 'Goblins', 'Musketeer', 'Archers', 'Minions']
      : ['Goblins', 'Knight', 'Archers', 'Musketeer', 'Minions'];

    for (const card of order) {
      if (canPlay(v, card)) return { card, x, y };
    }
  }

  // 3) Safe + rich: open a counter-push with a Giant on the right.
  const haveGiant = myUnits(v).some((u) => u.card === 'Giant');
  const pushY = me.id === 0 ? v.arena.mid - 3 : v.arena.mid + 3;
  if (!haveGiant && canPlay(v, 'Giant') && me.elixir >= 8) {
    return { card: 'Giant', x: 14, y: pushY };
  }
  if (haveGiant && me.elixir >= 5) {
    for (const card of ['Musketeer', 'Archers', 'Knight']) {
      if (canPlay(v, card)) {
        return { card, x: 14, y: me.id === 0 ? pushY - 2 : pushY + 2 };
      }
    }
  }

  return null;
}
