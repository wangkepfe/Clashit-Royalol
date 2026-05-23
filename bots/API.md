# Bot API

Authoritative sources: [`src/view.js`](../src/view.js) (input), [`src/engine.js`](../src/engine.js) (`tryDeploy`, simulation), [`src/cards.js`](../src/cards.js) (card stats), [`src/config.js`](../src/config.js) (constants).

---

## Contract

Bot module: ES module default-exporting `(view) => action | null`.

- Invoked once per tick per player (30 ticks/s).
- Input: read-only `view` (full information; no fog of war).
- Output: `null` (no play) or one deploy action.
- Illegal actions are dropped silently (no elixir spent). Thrown exceptions are treated as `null` for that tick.
- At most one card per tick.

```js
export default function bot(view) {
  return null;
  // or { card: 'Knight', x: 9, y: 10 }
  // or { handIndex: 0, x: 9, y: 10 }   // handIndex 0..3
}
```

Headless run:

```bash
node tools/arena.js <botA> <botB> <games>
```

---

## Action

```js
{ card: string, x: number, y: number }
{ handIndex: 0|1|2|3, x: number, y: number }
```

Validation (`tryDeploy`):

| Condition | Failure reason |
|---|---|
| Action is non-null object | `badAction` |
| `card` in `self.hand` or `handIndex` ∈ 0..3 | `notInHand` |
| `x`, `y` finite | `badCoords` |
| `self.elixir >= cost` | `notEnoughElixir` |
| Spell: `0 ≤ x ≤ arena.width`, `0 ≤ y ≤ arena.height` | `offArena` |
| Troop/building: position in legal deploy zone | `illegalZone` |
| Building: no overlap with tower or other building | `blockedByTower` / `blockedByBuilding` |

On success: elixir deducted, played card replaced from cycle (`cycle[0]` → hand slot, played card appended to cycle).

---

## View schema

Primitive copy each tick.

```js
{
  tick,                          // integer
  time,                          // seconds since start
  timeRemaining,                 // seconds left in current phase
  phase,                         // 'normal' | 'overtime' | 'ended'
  elixirMult,                    // 1 | 2 | 3
  doubleElixir,                  // elixirMult >= 2
  crowns: { self, enemy },       // enemy towers destroyed by each side

  arena: {
    width: 18, height: 32, mid: 16,
    river: [15.3, 16.7],         // ground units cannot enter
    bridges: [3.5, 14.5],        // ground crossing x positions
  },

  self: {
    id,                          // 0 (bottom, +y forward) | 1 (top, -y forward)
    elixir, elixirMax,           // elixirMax = 10
    hand: [{ card, cost, kind }], // length 4
    next: { card, cost, kind },
    deck: [string × 8],          // shuffled order at match start
    deployZone: { minX, maxX, minY, maxY },  // own-half bounds only
  },

  enemy: { id, elixir, hand, next, deck },

  towers: [{
    id, name, owner, mine,
    kind: 'king' | 'princess',
    side: 'left' | 'right' | 'center',
    x, y, hp, maxHp, alive, activated,
  }],

  units: [{
    id, name, owner, mine, card,
    x, y, hp, maxHp,
    flying, range, speed, dmg,
    deploying,                   // deploy freeze active
    targetId,
    building,                    // Cannon etc.
    lifetime, maxLifetime,       // buildings only
  }],

  projectiles: [{
    id, owner, mine,
    kind: 'bolt' | 'spell',
    card, x, y,
    targetId,                    // bolt: homing target; spell: null
    tx, ty,                      // spell: aim point
  }],

  cards: { [name]: CardDef },    // static reference table
}
```

Field notes:

- `hp` in view is rounded; engine uses float internally.
- `speed` is 0 for buildings.
- `unit.range`, `unit.dmg` are copies of card stats; full defs in `view.cards`.
- `view.self.deployZone` is own-half bounding box. Forward deploy (see Deploy zones) uses separate rules enforced by the engine.

---

## Match rules

Both players share the same 8-card deck (`src/cards.js` `DECK`). Deck shuffled per match from `seed`. Start: 5 elixir, 4 cards in hand, 4 in cycle.

| Phase | Duration | Elixir rate | `elixirMult` |
|---|---|---|---|
| Regulation (first 2 min) | 0–120 s | 1 elixir / 2.80 s | 1 |
| Regulation (last 1 min) | 120–180 s | 1 elixir / 1.40 s | 2 |
| Overtime | 180 s + up to 120 s | 1 elixir / 0.93 s | 3 |

Max elixir: 10. Excess elixir is discarded.

Win conditions (checked each tick after simulation):

1. Enemy king destroyed → immediate win.
2. Regulation ends: higher crown count wins; equal crowns → overtime.
3. Overtime: first crown lead wins (sudden death).
4. Overtime timer expires with equal crowns → winner by total remaining tower HP; exact HP tie broken by seeded RNG.

Crowns = count of enemy towers destroyed (princess or king).

Player 1 geometry is mirrored about `y = arena.mid`.

---

## Arena

Coordinates: tile units (float). Size 18×32.

Player 0 (bottom): king `(9, 3)`, princesses `(3.5, 6.5)`, `(14.5, 6.5)`.
Player 1 (top): y mirrored (`y' = 32 - y`).

River: `y ∈ [15.3, 16.7]`. Ground units cannot enter; cross at bridge x = 3.5 or 14.5.
Flying units ignore river restriction.

Tower footprints (circular collision): princess radius 1.5, king radius 2.0.
Units path around towers and buildings.

---

## Deploy zones

**Spells:** anywhere in arena (`0 ≤ x ≤ width`, `0 ≤ y ≤ height`).

**Troops/buildings:**

Player 0:
- Own half: `y ≤ mid - 0.5` (also `0.5 ≤ x ≤ width - 0.5`, `0.5 ≤ y ≤ height - 0.5`).
- Forward deploy (lane `left` if `x < width/2`, else `right`): if enemy princess in that lane is dead, additionally `y ≤ height - 6.0`.

Player 1:
- Own half: `y ≥ mid + 0.5`.
- Forward deploy: if enemy princess in lane dead, additionally `y ≥ 6.0`.

**Buildings:** center must not overlap any alive tower or any existing building. Overlap test: `(buildingRadius + obstacleRadius)²` on center distance. Cannon radius = 1.5.

---

## Cards

Tournament Standard (Level 11). `Minions` exists in `CARDS` but is not in `DECK`.

| Card | Cost | Kind | Count | HP | Dmg | Range | Sight | Speed | Targets |
|---|---|---|---|---|---|---|---|---|---|
| Knight | 3 | troop | 1 | 1766 | 202 | 1.2 | 5.5 | 1.00 | ground |
| Archers | 3 | troop | 2 | 304 | 112 | 5.0 | 5.5 | 1.00 | ground, air |
| Goblins | 2 | troop | 4 | 202 | 120 | 0.5 | 5.5 | 2.00 | ground |
| Giant | 5 | troop | 1 | 3968 | 253 | 1.2 | 6.0 | 0.75 | buildings only (`buildingsOnly: true`) |
| Cannon | 3 | building | 1 | 824 | 202 | 5.5 | 5.5 | — | ground |
| Musketeer | 4 | troop | 1 | 721 | 217 | 6.0 | 6.5 | 1.00 | ground, air |
| Fireball | 4 | spell | — | 688 (93 tower) | — | 2.5 radius | — | — | area, air |
| Arrows | 3 | spell | — | 366 (93 tower) | — | 3.5 radius | — | — | area, air |

Card def fields (`view.cards[name]`):

```
cost, kind, count?, hp, dmg, hitSpeed, range, sight, speed,
flying, targetsGround, targetsAir, buildingsOnly,
radius, mass, projectileSpeed?, lifetime?, towerDmg?, hitsAir?
```

- Spells: `dmg` vs units, `towerDmg` vs towers.
- Cannon: `lifetime: 30` s; self-destructs at expiry regardless of HP.
- Multi-unit cards spawn at offsets from deploy point (see `spawnOffsets` in `cards.js`).

---

## Simulation mechanics

**Tick order** (`step`):

1. Elixir gain (both players)
2. Deploy (player 0, then player 1)
3. Unit AI + movement + attacks
4. Tower AI
5. Projectiles
6. Unit collision resolution
7. Dead unit removal
8. Time advance, end check

**Deploy freeze:** new troops/buildings have `deployTimer = 1.0` s. While `deploying`: cannot move or attack; can be damaged.

**Target selection (`pickGoal`):**

- Scan enemies within `sight` that unit can hit (`canHit`: respects `buildingsOnly`, air/ground targeting).
- On acquire: target locks (`_aggroLocked`) until target dies, becomes unhittable, or leaves sight range.
- Locked units do not switch to closer enemies.
- Unlocked units with no target in sight walk toward nearest enemy tower (re-scans each tick; new obstacles can redirect).

**Giant:** `buildingsOnly: true` — ignores troops; targets buildings/towers only.

**Spells:** launched from caster's king tower toward `(x, y)`. Land after fixed `spellCastDelay` (1.0 s), independent of distance. Area damage at impact: units use `dmg`, towers use `towerDmg`. Flying units hit only if `hitsAir`.

**King tower activation:** king starts `activated: false` (does not attack). Activates when king takes direct damage, or when any own princess is destroyed.

**Projectiles:** `kind: 'bolt'` homing to `targetId`; `kind: 'spell'` travels to fixed `(tx, ty)`.

---

## Determinism

Simulation is deterministic from `(seed, botA, botB)`.

Prohibited in bot code:

- `Math.random()`, wall clock (`Date.now`, `performance.now`), timers
- I/O (`fetch`, `fs`, …)
- Global mutable state that varies independently of visible match state across ticks/matches

Module-level state derived deterministically from `view` is permitted. Default export is instantiated once per bot load.

---

## Optional helpers (`bots/lib.js`)

```js
dist(a, b)
myUnits(v), enemyUnits(v), myTowers(v), enemyTowers(v)
forward(v)                     // +1 if self.id === 0, else -1
inHand(v, card), canPlay(v, card), cheapestAffordable(v)
behindTowerY(v), threatenedLane(v), laneX(v, lane)
bestSpellTarget(v, radius, minHp)
```

Not required for a valid bot.
