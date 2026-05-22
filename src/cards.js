// The 8 cards — REAL Clash Royale data at Tournament Standard (Level 11),
// the long-standing competitive reference level.
//
// Sources: Liquipedia (current, 2026 patch notes) cross-validated against the
// Clash Royale Fandom wiki / RoyaleAPI / deckshop. Stats are the Level 11 row.
//
// Unit conversions into this engine:
//   speed:  Clash Royale tiles/minute  ->  tiles/second  (divide by 60)
//           Slow 45 = 0.75 | Medium 60 = 1.00 | Fast 90 = 1.50 | VeryFast 120 = 2.00
//   range / radius: tiles. Melee descriptors -> tile values
//           Melee Short = 0.5 | Melee Medium = 1.2
//   hitSpeed / deploy: seconds (deploy time is the standard 1.0 s for all troops)
//   dmg / hp: exact Level 11 values. Spells use real crown-tower damage on towers.
//
// `sight` (aggro range) is NOT a cleanly published per-card stat, so it uses an
// engine convention: 5.5 tiles default, or a touch beyond a ranged unit's range.
// Every other number here is the real Level 11 value.
//
// `radius` = real CollisionRadius (characters.csv ÷ 1000, in tiles); `mass` = real
// Mass (characters.csv) — used for unit-vs-unit push-out. `projectileSpeed` = real
// projectile Speed (projectiles.csv ÷ 60, tiles/second); melee cards omit it and
// deal instant damage on contact. Source: official game data (smlbiobot/cr-csv),
// same Tournament-Standard reference and ÷60 / ÷1000 conversions as above.

const SPEED = { slow: 0.75, medium: 1.0, fast: 1.5, veryFast: 2.0 };
// Projectile travel speed: CR Speed unit ÷ 60 = tiles/second.
const PROJ = {
  arrow: 10.0,
  musketBullet: 1000 / 60,
  cannonBall: 1000 / 60,    // real TowerCannonball Speed = 1000
  fireball: 10.0,
  arrowsSpell: 1100 / 60,
};

export const CARDS = {
  Knight: {
    cost: 3, kind: 'troop', count: 1,
    hp: 1766, dmg: 202, hitSpeed: 1.2, range: 1.2, sight: 5.5, speed: SPEED.medium,
    flying: false, targetsGround: true, targetsAir: false, buildingsOnly: false,
    radius: 0.5, mass: 6, // melee: no projectileSpeed -> instant on contact
  },
  Archers: {
    cost: 3, kind: 'troop', count: 2,
    hp: 304, dmg: 112, hitSpeed: 0.9, range: 5.0, sight: 5.5, speed: SPEED.medium,
    flying: false, targetsGround: true, targetsAir: true, buildingsOnly: false,
    radius: 0.5, mass: 3, projectileSpeed: PROJ.arrow,
  },
  Goblins: {
    cost: 2, kind: 'troop', count: 4,
    hp: 202, dmg: 120, hitSpeed: 1.1, range: 0.5, sight: 5.5, speed: SPEED.veryFast,
    flying: false, targetsGround: true, targetsAir: false, buildingsOnly: false,
    radius: 0.5, mass: 2,
  },
  Giant: {
    cost: 5, kind: 'troop', count: 1,
    hp: 3968, dmg: 253, hitSpeed: 1.5, range: 1.2, sight: 6.0, speed: SPEED.slow,
    flying: false, targetsGround: false, targetsAir: false, buildingsOnly: true,
    radius: 0.75, mass: 18,
  },
  Minions: {
    cost: 3, kind: 'troop', count: 3,
    hp: 230, dmg: 107, hitSpeed: 1.1, range: 2.5, sight: 5.5, speed: SPEED.fast,
    flying: true, targetsGround: true, targetsAir: true, buildingsOnly: false,
    radius: 0.5, mass: 2, // short-range air: instant (CR melee-range projectile)
  },
  Musketeer: {
    cost: 4, kind: 'troop', count: 1,
    hp: 721, dmg: 217, hitSpeed: 1.0, range: 6.0, sight: 6.5, speed: SPEED.medium,
    flying: false, targetsGround: true, targetsAir: true, buildingsOnly: false,
    radius: 0.5, mass: 5, projectileSpeed: PROJ.musketBullet,
  },
  // Buildings: stationary 3×3-tile defensive structures with a real lifetime
  // (self-destruct after `lifetime` seconds even at full HP). They have no
  // `speed`, never move, and (for Cannon) cannot target air troops. Real CR
  // Cannon at Tournament Standard (Level 11) — Liquipedia + cr-csv
  // buildings.csv: SightRange 5500 → 5.5; Range 5500 → 5.5; LifeTime 30000 →
  // 30s; Projectile TowerCannonball Speed 1000 → ÷60. HitSpeed 1.0s reflects
  // the 2025-03-04 patch (was 0.9s).
  // NOTE: radius set to 1.5 (NOT real-CR's 0.6) so the Cannon occupies a full
  // 3×3-tile footprint: the camera views from below and the sprite reads as a
  // small fort, so units pathing around it now match the visible body and a
  // melee attacker can reach any side of the 3-tile-wide structure.
  Cannon: {
    cost: 3, kind: 'building', count: 1,
    hp: 824, dmg: 202, hitSpeed: 1.0, range: 5.5, sight: 5.5,
    flying: false, targetsGround: true, targetsAir: false, buildingsOnly: false,
    radius: 1.5, mass: 1000,    // 3×3 footprint; huge mass = unpushable
    lifetime: 30.0,             // real CR LifeTime: vanishes at 30s
    projectileSpeed: PROJ.cannonBall,
  },
  // Spells: dmg = damage to troops; towerDmg = reduced crown-tower damage.
  // projectileSpeed: thrown from the caster's King tower toward the aim point
  // (non-homing) — slow spells must be aimed ahead of moving targets.
  Fireball: {
    cost: 4, kind: 'spell', radius: 2.5, dmg: 688, towerDmg: 207, hitsAir: true,
    projectileSpeed: PROJ.fireball,
  },
  Arrows: {
    cost: 3, kind: 'spell', radius: 3.5, dmg: 366, towerDmg: 93, hitsAir: true,
    projectileSpeed: PROJ.arrowsSpell,
  },
};

// Active 8-card deck shared by both players. Minions is intentionally defined
// above (and renderable) but excluded from the live deck — Cannon takes its
// slot. To put Minions back in rotation, swap them here.
export const DECK = [
  'Knight', 'Archers', 'Goblins', 'Giant',
  'Cannon', 'Musketeer',
  'Fireball', 'Arrows',
];

// Cluster offsets for multi-unit cards, in tiles, relative to deploy point.
function spawnOffsets(count) {
  if (count <= 1) return [[0, 0]];
  if (count === 2) return [[-0.6, 0], [0.6, 0]];
  if (count === 3) return [[0, 0.6], [-0.55, -0.45], [0.55, -0.45]];
  if (count === 4) return [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]];
  // Fallback ring for any larger swarm.
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push([Math.cos(a) * 0.6, Math.sin(a) * 0.6]);
  }
  return out;
}

// Spawn a troop card's units, or apply a spell immediately.
// `applyDamage` is passed in from the engine to keep this module pure of engine internals.
// Apply a spell's area damage at the landing point. Split out of deployCard so
// the engine can call it when the spell projectile actually arrives (spells now
// travel from the caster's King tower rather than detonating instantly).
export function applySpell(state, owner, cardName, x, y, applyDamage) {
  const def = CARDS[cardName];
  if (!def || def.kind !== 'spell') return 0;
  const tag = owner === 0 ? 'A' : 'B';
  const src = { _spell: true, owner, card: cardName, name: `${cardName}_${tag}`, x, y };
  let hits = 0;
  for (const e of enemyEntities(state, owner)) {
    const dx = e.x - x, dy = e.y - y;
    if (dx * dx + dy * dy <= def.radius * def.radius) {
      if (e._tower || !e.flying || def.hitsAir) {
        applyDamage(state, e, e._tower ? def.towerDmg : def.dmg, src);
        hits++;
      }
    }
  }
  state.effects.push({ kind: 'spell', card: cardName, x, y, radius: def.radius, ttl: 0.35 });
  return hits;
}

export function deployCard(state, owner, cardName, x, y, applyDamage) {
  const def = CARDS[cardName];
  if (!def) return;

  if (def.kind === 'spell') {
    applySpell(state, owner, cardName, x, y, applyDamage);
    return;
  }

  if (def.kind === 'building') {
    // Buildings are stationary defensive structures (Cannon = 3×3 footprint
    // via def.radius=1.5). Spawn one entity at the deploy point — no cluster
    // offsets, no river clamp (placement legality is already validated in
    // the engine).
    const A = state.config.arena;
    const ux = clamp(x, 0.5, A.width - 0.5);
    const uy = clamp(y, 0.5, A.height - 0.5);
    const tag = owner === 0 ? 'A' : 'B';
    const key = `${owner}:${cardName}`;
    const n = (state.nameCounters[key] = (state.nameCounters[key] || 0) + 1);
    state.units.push({
      id: state.nextId++,
      name: `${cardName}_${tag}_${n}`,
      owner,
      card: cardName,
      def,
      x: ux,
      y: uy,
      hp: def.hp,
      maxHp: def.hp,
      flying: false,
      cooldown: 0,
      deployTimer: state.config.deployTime,
      targetId: null,
      // Building-only fields:
      _building: true,           // engine flag: canHit shortcut + skip movement
      lifetime: def.lifetime,    // self-destruct timer (seconds)
      maxLifetime: def.lifetime, // remembered for HUD / view bars
      aimAngle: 0,               // current turret angle (radians); rig animates this
    });
    return;
  }

  const offs = spawnOffsets(def.count);
  const A = state.config.arena;
  const ownMinY = owner === 0 ? 0.5 : A.mid + 0.5;
  const ownMaxY = owner === 0 ? A.mid - 0.5 : A.height - 0.5;
  for (const [ox, oy] of offs) {
    let ux = clamp(x + ox, 0.5, A.width - 0.5);
    let uy = clamp(y + oy, 0.5, A.height - 0.5);
    // Keep multi-spawn clusters from leaking across the river on deploy.
    if (!def.flying) uy = clamp(uy, ownMinY, ownMaxY);
    const tag = owner === 0 ? 'A' : 'B';
    const key = `${owner}:${cardName}`;
    const n = (state.nameCounters[key] = (state.nameCounters[key] || 0) + 1);
    state.units.push({
      id: state.nextId++,
      name: `${cardName}_${tag}_${n}`,
      owner,
      card: cardName,
      def,
      x: ux,
      y: uy,
      hp: def.hp,
      maxHp: def.hp,
      flying: def.flying,
      cooldown: 0,
      deployTimer: state.config.deployTime,
      targetId: null,
    });
  }
}

function enemyEntities(state, owner) {
  const out = [];
  for (const u of state.units) if (u.owner !== owner && u.hp > 0) out.push(u);
  for (const t of state.towers) if (t.owner !== owner && t.alive) out.push(t);
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
