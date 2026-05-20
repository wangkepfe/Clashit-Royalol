// Simple one-lane aggression: build a Giant push on the right, back it with
// support, throw spells at clumps. A decent baseline for the agent to beat.
import { canPlay, myUnits, bestSpellTarget, dist } from './lib.js';

const LANE_X = 14; // right lane, riding the right bridge

export default function rush(v) {
  const me = v.self;
  const pushY = me.id === 0 ? v.arena.mid - 3 : v.arena.mid + 3;
  const haveGiant = myUnits(v).some((u) => u.card === 'Giant');

  // Spell value: hit a worthwhile enemy clump.
  if (canPlay(v, 'Fireball')) {
    const t = bestSpellTarget(v, v.cards.Fireball.radius, 320);
    if (t) return { card: 'Fireball', x: t.x, y: t.y };
  }
  if (canPlay(v, 'Arrows')) {
    const t = bestSpellTarget(v, v.cards.Arrows.radius, 220);
    if (t) return { card: 'Arrows', x: t.x, y: t.y };
  }

  // Start a push with a Giant when we have enough elixir and none is out.
  if (!haveGiant && canPlay(v, 'Giant') && me.elixir >= 7) {
    return { card: 'Giant', x: LANE_X, y: pushY };
  }

  // Support behind the Giant once it exists.
  if (haveGiant && me.elixir >= 4) {
    for (const card of ['Musketeer', 'Archers', 'Knight', 'Minions', 'Goblins']) {
      if (canPlay(v, card)) {
        const supportY = me.id === 0 ? pushY - 2 : pushY + 2;
        return { card, x: LANE_X, y: supportY };
      }
    }
  }

  // Don't cap out and waste elixir: cycle the cheapest thing at the bridge.
  if (me.elixir >= 9) {
    for (const card of ['Goblins', 'Archers', 'Knight', 'Minions']) {
      if (canPlay(v, card)) return { card, x: LANE_X, y: pushY };
    }
  }

  return null;
}
