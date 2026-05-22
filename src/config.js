// Global constants for the simulation. Tweak freely — this is the balance knob box.

export const CONFIG = {
  arena: {
    width: 18,
    height: 32,
    mid: 16, // river center line (y)
    river: [15.3, 16.7], // ground units cannot enter this y-band
    bridges: [3.5, 14.5], // x positions where ground units cross
    bridgeHalfWidth: 0.7,
  },

  ticksPerSecond: 30,
  // Real Clash Royale match length: 3 min regulation (last 1 min is double
  // elixir), then up to 2 min of triple-elixir sudden-death overtime.
  regulationTime: 180, // seconds (3:00)
  doubleElixirWindow: 60, // last 60 s of regulation run at 2× elixir
  overtimeTime: 120, // seconds of sudden-death overtime (3× elixir)

  startElixir: 5,
  maxElixir: 10,
  elixirTimeNormal: 2.8, // seconds per 1 elixir (1×)
  elixirTimeDouble: 1.4, // 2×
  elixirTimeTriple: 2.8 / 3, // 3× (≈0.933 s) — overtime

  deployTime: 1.0, // seconds a new troop is frozen
  towerTargetRadius: 1.4, // collision radius used when attacking a tower

  // Real CR: spells land at a fixed ~1.0 s after cast, regardless of where on
  // the map. Engine normalizes the spell projectile's speed at cast time so
  // travel duration is exactly this many seconds (no more 2-3 s far-spell
  // travel from the caster's King tower).
  spellCastDelay: 1.0,

  // Crown towers fire arrows (real TowerPrincessProjectile Speed 600 ÷ 60).
  towerProjectileSpeed: 600 / 60, // tiles/second

  // Footprint a unit must walk *around* (towers are solid, not walk-through).
  // Princess ≈ 3×3, King ≈ 4×4 tiles in real Clash Royale; a unit's own
  // collision radius is added on top when steering.
  towerFootprint: { princess: 1.5, king: 2.0 },

  // Tower layout is generated per player in state.js from these templates.
  // Real Clash Royale Tournament Standard (Level 11) crown-tower stats.
  towers: {
    princess: { hp: 3052, dmg: 109, hitSpeed: 0.8, range: 7.5 },
    king: { hp: 4824, dmg: 109, hitSpeed: 1.0, range: 7.0 },
    // (x, y) for player 0 (bottom). Player 1 is mirrored about y = height/2.
    layout0: {
      kingPos: [9.0, 3.0],
      leftPrincessPos: [3.5, 6.5],
      rightPrincessPos: [14.5, 6.5],
    },
  },
};

export const TPS = CONFIG.ticksPerSecond;
export const DT = 1 / CONFIG.ticksPerSecond;
