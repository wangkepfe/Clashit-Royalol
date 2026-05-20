// ============================================================================
//  TEMPLATE FOR THE CODING AGENT — copy this file, rename it, and iterate.
//
//  A bot is ONE pure function: (view) => action | null
//  It is called once per simulation tick (30 ticks/second) for your player.
//
//  Workflow:
//    1. Copy this to bots/<yourname>.js
//    2. Add it to src/registry.js (one line) so the viewer can pick it
//    3. Measure:  npm run arena -- <yourname> rush 200
//    4. Watch:    npm run serve   (open http://localhost:8080)
//    5. Change strategy, repeat, push win rate up.
// ============================================================================

// ---- THE VIEW (input) -- full information, read-only ----------------------
// view.tick, view.time, view.timeRemaining
// view.phase ('normal'|'overtime'), view.doubleElixir
// view.crowns { self, enemy }
// view.arena { width:18, height:32, mid:16, river:[lo,hi], bridges:[3.5,14.5] }
// view.self {
//   id (0 or 1), elixir, elixirMax,
//   hand: [{card,cost,kind} x4], next:{card,cost,kind}, deck:[8 names],
//   deployZone:{minX,maxX,minY,maxY}   // legal troop placement rectangle
// }
// view.enemy { id, elixir, hand, next, deck }   // yes, you can see it all
// view.towers [{id,owner,mine,kind:'king'|'princess',side,x,y,hp,maxHp,alive,activated}]
// view.units  [{id,owner,mine,card,x,y,hp,maxHp,flying,range,speed,dmg,deploying,targetId}]
// view.cards  { Knight:{cost,kind,hp,dmg,range,speed,...}, ... }  // static stats
//
// ---- THE ACTION (output) --------------------------------------------------
//   return null;                              // do nothing this tick
//   return { card:'Knight', x:9, y:10 };      // play by card name (in hand)
//   return { handIndex:0,    x:9, y:10 };     // or by hand slot 0..3
// Illegal/unaffordable actions are ignored for free. Coordinates are in TILES.
// You may play at most one card per tick (more naturally limited by elixir).
// ===========================================================================

import { canPlay, enemyUnits, threatenedLane, laneX, behindTowerY } from './lib.js';

export default function example(v) {
  const me = v.self;

  // Defend if the enemy is pushing a lane on our side.
  const lane = threatenedLane(v);
  if (lane && me.elixir >= 3) {
    const counter = enemyUnits(v).some((u) => u.flying) ? 'Archers' : 'Knight';
    if (canPlay(v, counter)) {
      return { card: counter, x: laneX(v, lane), y: behindTowerY(v) };
    }
  }

  // Otherwise, when we have plenty of elixir, push the right lane.
  if (me.elixir >= 8) {
    for (const card of ['Giant', 'Musketeer', 'Knight', 'Archers']) {
      if (canPlay(v, card)) {
        const y = me.id === 0 ? v.arena.mid - 3 : v.arena.mid + 3;
        return { card, x: 14, y };
      }
    }
  }

  return null; // save elixir
}
