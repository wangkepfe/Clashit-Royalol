import { CONFIG } from './config.js';
import { DECK } from './cards.js';
import { makeRng, shuffle } from './rng.js';

// Build the 6 towers (3 per player). Player 1 is mirrored about the arena's y-center.
function makeTowers() {
  const { princess, king, layout0 } = CONFIG.towers;
  const H = CONFIG.arena.height;
  const towers = [];
  let id = 1;

  function add(owner, kind, side, pos, tpl) {
    const tag = owner === 0 ? 'A' : 'B';
    towers.push({
      id: id++,
      name: kind === 'king' ? `KingTower_${tag}` : `PrincessTower_${side}_${tag}`,
      owner,
      kind,
      side,
      x: pos[0],
      y: pos[1],
      hp: tpl.hp,
      maxHp: tpl.hp,
      dmg: tpl.dmg,
      hitSpeed: tpl.hitSpeed,
      range: tpl.range,
      cooldown: 0,
      alive: true,
      activated: kind !== 'king', // king starts dormant
      _tower: true,
    });
  }

  // Player 0 (bottom)
  add(0, 'king', 'center', layout0.kingPos, king);
  add(0, 'princess', 'left', layout0.leftPrincessPos, princess);
  add(0, 'princess', 'right', layout0.rightPrincessPos, princess);
  // Player 1 (top) — mirror y -> H - y
  add(1, 'king', 'center', [layout0.kingPos[0], H - layout0.kingPos[1]], king);
  add(1, 'princess', 'left', [layout0.leftPrincessPos[0], H - layout0.leftPrincessPos[1]], princess);
  add(1, 'princess', 'right', [layout0.rightPrincessPos[0], H - layout0.rightPrincessPos[1]], princess);

  return towers;
}

function makePlayer(id, rng) {
  const deck = shuffle(DECK, rng);
  return {
    id,
    elixir: CONFIG.startElixir,
    deck, // full shuffled order (static, for reference)
    hand: deck.slice(0, 4),
    cycle: deck.slice(4, 8), // cycle[0] is the "next" card
  };
}

export function createInitialState(seed, opts) {
  const rng = makeRng(seed);
  const logEnabled = !!(opts && (opts.log || opts.trace));
  const traceEnabled = !!(opts && opts.trace);
  return {
    seed,
    rng,
    config: CONFIG,
    tick: 0,
    time: 0,
    phase: 'normal', // 'normal' | 'overtime' | 'ended'
    ended: false,
    winner: null, // 0 | 1 | 'draw'
    result: null, // { winner, crowns:[c0,c1], reason }
    overtimeEnd: 0,
    players: [makePlayer(0, rng), makePlayer(1, rng)],
    towers: makeTowers(),
    units: [],
    elixirMult: 1, // current elixir rate multiplier (1× | 2× | 3×)
    projectiles: [], // in-flight arrows / bullets / spells (travel time)
    effects: [], // transient visual events (spell flashes, hits)
    nextId: 1000,
    // ── opt-in instrumentation for analysis (off by default = zero overhead) ──
    logEnabled,
    traceEnabled, // verbose: per-hit damage/death events (heavier)
    nameCounters: {}, // `${owner}:${card}` -> count, for stable readable IDs
    events: [], // chronological match events
    stats: logEnabled
      ? {
          elixirSpent: [0, 0],
          elixirLeaked: [0, 0], // elixir wasted while capped at max
          towerDmg: [0, 0], // damage dealt to enemy towers
          unitsLost: [0, 0],
          unitsKilled: [0, 0],
          cards: [{}, {}], // card -> times played
          plays: [0, 0],
          playsFailed: [0, 0],
          spellsCast: [0, 0],
          spellsWasted: [0, 0], // spells that hit nothing
        }
      : null,
  };
}

// Crowns = number of enemy towers a player has destroyed.
export function crownsFor(state, playerId) {
  let c = 0;
  for (const t of state.towers) if (t.owner !== playerId && !t.alive) c++;
  return c;
}
