import { CARDS } from './cards.js';
import { crownsFor } from './state.js';

// Static card stats, built once and shared (read-only reference data for bots).
const CARD_DEFS = (() => {
  const out = {};
  for (const [name, d] of Object.entries(CARDS)) out[name] = { name, ...d };
  return out;
})();

function handView(player) {
  return player.hand.map((c) => ({ card: c, cost: CARDS[c].cost, kind: CARDS[c].kind }));
}

function nextView(player) {
  const c = player.cycle[0];
  return { card: c, cost: CARDS[c].cost, kind: CARDS[c].kind };
}

function deployZone(state, owner) {
  const A = state.config.arena;
  if (owner === 0) return { minX: 0.5, maxX: A.width - 0.5, minY: 0.5, maxY: A.mid - 0.5 };
  return { minX: 0.5, maxX: A.width - 0.5, minY: A.mid + 0.5, maxY: A.height - 0.5 };
}

// Build the full-information, read-only scene graph for one player.
// Everything is a fresh primitive copy, so a bot cannot corrupt the simulation.
export function buildView(state, owner) {
  const me = state.players[owner];
  const opp = state.players[owner === 0 ? 1 : 0];

  const towers = state.towers.map((t) => ({
    id: t.id,
    name: t.name,
    owner: t.owner,
    mine: t.owner === owner,
    kind: t.kind,
    side: t.side,
    x: t.x,
    y: t.y,
    hp: Math.max(0, Math.round(t.hp)),
    maxHp: t.maxHp,
    alive: t.alive,
    activated: t.activated,
  }));

  const units = state.units.map((u) => ({
    id: u.id,
    name: u.name,
    owner: u.owner,
    mine: u.owner === owner,
    card: u.card,
    x: u.x,
    y: u.y,
    hp: Math.max(0, Math.round(u.hp)),
    maxHp: u.maxHp,
    flying: u.flying,
    range: u.def.range,
    speed: u.def.speed || 0, // buildings are stationary (no speed)
    dmg: u.def.dmg,
    deploying: u.deployTimer > 0,
    targetId: u.targetId,
    // Building-specific fields (undefined for troops so bots can detect them).
    building: !!u._building,
    lifetime: u._building ? Math.max(0, u.lifetime) : undefined,
    maxLifetime: u._building ? u.maxLifetime : undefined,
  }));

  const projectiles = state.projectiles.map((p) => ({
    id: p.id,
    owner: p.owner,
    mine: p.owner === owner,
    kind: p.kind, // 'bolt' | 'spell'
    card: p.card,
    x: p.x,
    y: p.y,
    targetId: p.targetId,
    tx: p.tx,
    ty: p.ty,
  }));

  const timeRemaining =
    state.phase === 'overtime'
      ? Math.max(0, state.overtimeEnd - state.time)
      : Math.max(0, state.config.regulationTime - state.time);

  return {
    tick: state.tick,
    time: state.time,
    timeRemaining,
    phase: state.phase,
    elixirMult: state.elixirMult || 1, // 1× | 2× (last min) | 3× (overtime)
    doubleElixir: (state.elixirMult || 1) >= 2, // back-compat: true when ≥2×
    crowns: { self: crownsFor(state, owner), enemy: crownsFor(state, owner === 0 ? 1 : 0) },
    arena: {
      width: state.config.arena.width,
      height: state.config.arena.height,
      mid: state.config.arena.mid,
      river: state.config.arena.river.slice(),
      bridges: state.config.arena.bridges.slice(),
    },
    self: {
      id: owner,
      elixir: me.elixir,
      elixirMax: state.config.maxElixir,
      hand: handView(me),
      next: nextView(me),
      deck: me.deck.slice(),
      deployZone: deployZone(state, owner),
    },
    enemy: {
      id: owner === 0 ? 1 : 0,
      elixir: opp.elixir,
      hand: handView(opp),
      next: nextView(opp),
      deck: opp.deck.slice(),
    },
    towers,
    units,
    projectiles,
    cards: CARD_DEFS,
  };
}
