# Clashit Royalol — Design Document

A web-based, **code-played** Clash Royale knock-off. No human plays the game with a mouse — two
scripts (bots) play it. The point of the project is to let a coding agent write and iteratively
improve a strategy script to maximize its win rate, and to watch matches play out in the browser.

> Design priority: **make the whole game work** over making it pretty. Graphics are intentionally
> cheap (rectangles + circles on a 2D canvas).

---

## 1. Goals

1. A deterministic, headless-capable Clash-Royale-like simulation.
2. A clean, full-information **scene-graph** state handed to a script every tick.
3. A trivial action interface: each tick a script optionally plays one card at one tile.
4. A browser viewer to watch any two bots fight.
5. A headless arena to run many matches fast and report win rates (the agent's feedback loop).

## 2. Non-goals (v1)

- Card levels / upgrades, chests, ladder, emotes, deck building UI.
- Networked multiplayer or human input.
- Fancy art, animation, sound.

---

## 3. High-level architecture

```
                 ┌─────────────────────────────────────────┐
                 │            Simulation engine             │  (pure, no DOM)
   bot A action  │  state ──step(state, {0:actA,1:actB})──▶ │
   ◀──view A─────┤  - elixir, cards, units, towers, spells  │
   bot B action  │  - deterministic (seeded RNG)            │
   ◀──view B─────┤  - fixed tick rate                       │
                 └───────────────┬─────────────────────────┘
                                 │ same engine module
        ┌────────────────────────┴───────────────────────┐
        ▼                                                 ▼
  Browser viewer (src/main.js + renderer)         Headless arena (tools/arena.js)
  watch one match, controls, speed                run N matches, print win rate
```

The engine has **no DOM dependency**, so the identical code runs in the browser and in Node.
Determinism (seeded RNG + fixed timestep + no wall-clock) means a match is fully reproducible
from `(seed, botA, botB)`. That is what makes "measure win rate over 200 games" meaningful.

### File layout

```
DESIGN.md
HANDOFF.md              # state-of-the-work doc
package.json            # type:module; npm run arena / npm run serve
index.html              # browser viewer
viewer.html             # standalone asset/sprite viewer
src/
  rng.js                # mulberry32 seeded PRNG
  config.js             # arena, timing, elixir, tower constants
  cards.js              # the 8 card definitions + spawn / spell logic
  state.js              # initial state factory, deck shuffling, tower layout
  engine.js             # step(state, actions): the whole simulation tick
  view.js               # builds the read-only scene graph handed to a bot
  match.js              # headless + interactive match drivers
  analysis.js           # summarize / diagnose / aggregate / formatGameReport
  renderer.js           # cheap canvas 2D drawing
  sprites.js            # per-card draw routines for the viewer
  background.js         # arena background (pre-baked + lazy load)
  arena-geom.js         # arena tile↔pixel helpers shared by renderer & sprites
  registry.js           # list of selectable bots for the viewer
  main.js               # viewer wiring: dropdowns, play/pause/speed
  viewer.js             # asset/sprite viewer wiring (viewer.html)
bots/
  lib.js                # helper functions bots may import (dist, nearest…)
  Claude_Opus_4_7.js    # the only bot in the repo (see bot file header
                        # for strategy + measured-dead-end notes)
tools/
  arena.js              # node tools/arena.js <botA> <botB> [games] [seed]
  analyze.js            # one-game report or aggregated --series report
  bake-bg.js            # offline arena-background pre-bake
  bg-scene.js           # shared background scene description
```

---

## 4. The arena

- Grid: **18 wide × 32 tall** tiles. Positions are floats in tile units.
- `y = 0` is player 0's back line (bottom); `y = 32` is player 1's back line (top).
- A **river** spans `y ∈ [15.3, 16.7]` (mid = 16). Ground units cannot enter the river.
- Two **bridges** at `x = 3.5` and `x = 14.5` let ground units cross. Flying units ignore the river.
- Towers per player: one **King** (center, back) + two **Princess** towers (left/right, forward).

Crown-tower stats are **real Clash Royale Tournament Standard (Level 11)** values.

| Tower    | Player 0 (x, y) | Player 1 (x, y) | HP   | Dmg | Hit (s) | Range |
|----------|-----------------|-----------------|------|-----|---------|-------|
| Princess L | 3.5, 6.5      | 3.5, 25.5       | 3052 | 109 | 0.8     | 7.5   |
| Princess R | 14.5, 6.5     | 14.5, 25.5      | 3052 | 109 | 0.8     | 7.5   |
| King       | 9.0, 3.0      | 9.0, 29.0       | 4824 | 109 | 1.0     | 7.0   |

**King activation:** the King tower is dormant (does not shoot) until either one of its own
Princess towers is destroyed, or the King itself takes any damage.

---

## 5. Cards (the 8 most basic)

Both players use the **same 8-card deck**, shuffled independently per player per seed.

| Card      | Cost | Kind     | Count | HP   | Dmg | Hit(s) | Range | Speed | Air? | Targets        |
|-----------|------|----------|-------|------|-----|--------|-------|-------|------|----------------|
| Knight    | 3    | troop    | 1     | 1766 | 202 | 1.2    | 1.2   | 1.00  | no   | ground         |
| Archers   | 3    | troop    | 2     | 304  | 112 | 0.9    | 5.0   | 1.00  | no   | ground + air   |
| Goblins   | 2    | troop    | 4     | 202  | 120 | 1.1    | 0.5   | 2.00  | no   | ground         |
| Giant     | 5    | troop    | 1     | 3968 | 253 | 1.5    | 1.2   | 0.75  | no   | buildings only |
| Cannon    | 3    | building | 1     | 824  | 202 | 1.0    | 5.5   | 0     | no   | ground         |
| Musketeer | 4    | troop    | 1     | 721  | 217 | 1.0    | 6.0   | 1.00  | no   | ground + air   |
| Fireball  | 4    | spell    | —     | —    | 688 | —      | 2.5r  | —     | —    | area (207 → towers) |
| Arrows    | 3    | spell    | —     | —    | 366 | —      | 3.5r  | —     | —    | area (93 → towers)  |

> **Cannon** is a defensive **building** — it's stationary, self-destructs after
> a **30-second lifetime** regardless of HP, and cannot target air troops.
> Its real Tournament-Standard (Level 11) stats are 824 hp / 202 dmg / 1.0 s
> hit speed / 5.5-tile range / 30 s lifetime / projectile speed 1000 (÷60 =
> 16.67 tiles/s, real *TowerCannonball*), straight off Liquipedia + the
> official `cr-csv` `buildings.csv`. **Minions** is kept in code as a fallback
> sprite/rendering path but excluded from `DECK` — Cannon takes its slot.

All values are **real Clash Royale data at Tournament Standard (Level 11)** — the
long-standing competitive reference. Source: Liquipedia (current, 2026 patch notes)
cross-validated against the Fandom wiki / RoyaleAPI / deckshop. Conversions: speed =
CR tiles/min ÷ 60 (Slow 45→0.75, Medium 60→1.00, Fast 90→1.50, Very Fast 120→2.00);
range/radius in tiles (melee Short=0.5, Medium=1.2); hit speed/deploy in seconds
(deploy = standard 1.0 s). Spells deal real reduced crown-tower damage. `sight`/aggro
range (~5.5 tiles, slightly beyond a ranged unit's range) is the one engine
convention — it isn't a cleanly published per-card stat. All values live in
`src/cards.js`.

**Design intent of this set:** a tank (Giant), a mini-tank (Knight), swarm (Goblins),
ranged support (Archers/Musketeer), a defensive building (Cannon), single-target spell
(Fireball), swarm-clear spell (Arrows). Enough rock-paper-scissors for strategy to matter.
(Minions — the original air-unit slot — remains coded but is not in the live deck.)

---

## 6. Game rules

- **Tick rate:** 30 ticks/second (`dt = 1/30 s`). All timers are in seconds.
- **Elixir:** start 5, max 10. Real Clash Royale rate schedule: **1×** = 1 every
  **2.8 s** for the first 2 min; **2×** = 1 every **1.4 s** for the last 1 min of
  regulation; **3×** = 1 every **≈0.93 s** throughout overtime. A card is playable
  only when `elixir >= cost` (continuous, no rounding).
- **Card cycle:** 4-card hand + a visible "next" card. Playing a card sends it to the back of the
  cycle; the next card slides into the freed hand slot. Classic Clash cycle.
- **Deployment:** troops only on your own half (up to the river). If you destroy an enemy Princess
  tower, that lane's half of the enemy side opens up for you (forward deploys). Spells may target
  anywhere on the arena.
- **Deploy time:** a freshly placed troop is frozen ~1.0 s before it can move or attack (it can be
  damaged during this time).
- **Targeting:** a unit locks the nearest valid enemy within its sight range; otherwise it walks
  toward the nearest enemy tower. "Valid" respects air/ground rules; Giant only ever targets
  buildings; ground-only attackers cannot hit flying units.
- **Combat:** melee deals instant damage on the attacker's hit-speed cadence;
  ranged units, crown towers, and spells fire **projectiles with real travel
  time** (homing for units/towers, fixed-point for spells thrown from the King
  tower). Spells apply their area damage on impact. Fully deterministic.
- **Match flow:**
  - **Regulation:** 180 s (3 min). Destroying the enemy King ends the game
    immediately (3 crowns). The last 60 s is double elixir.
  - At 180 s: more crowns (Princess/King towers destroyed) wins.
  - **Overtime:** if crowns are tied, up to 120 s of triple-elixir sudden death;
    the **next tower destroyed wins instantly**.
  - If overtime expires still tied there is **no draw** — the player with more
    total remaining tower HP wins (exact ties broken by the seeded RNG).

---

## 7. Bot interface

A bot is an ES module with a default export: a pure function `(view) => action | null`.
It is called once per tick for each player.

### 7.1 The view (input) — the "top of the scene graph"

Full information by design (the spec says the script can read everything). The bot may use or
ignore any of it. Shape (see `src/view.js` for the authoritative builder):

```js
{
  tick, time, timeRemaining,
  phase:        'normal' | 'overtime' | 'ended',
  elixirMult:   1 | 2 | 3,         // 1× regular / 2× last min / 3× overtime
  doubleElixir: bool,              // back-compat: elixirMult >= 2
  crowns:       { self, enemy },   // enemy crown towers I've destroyed / opp's
  arena:        { width, height, mid, river:[lo,hi], bridges:[x1,x2] },
  self: {
    id, elixir, elixirMax,
    hand:       [{ card, cost, kind } x4],
    next:       { card, cost, kind },
    deck:       [cardName x8],
    deployZone: { minX, maxX, minY, maxY },     // legal troop placement rect
  },
  enemy:        { id, elixir, hand:[...], next:{...}, deck:[...] },
  towers: [{
    id, name, owner, mine, kind:'king'|'princess', side,
    x, y, hp, maxHp, alive, activated,
  }],
  units: [{
    id, name, owner, mine, card,
    x, y, hp, maxHp, flying,
    range, speed, dmg,                          // static def stats lifted up
    deploying,                                  // true while the 1.0s timer is running
    targetId,                                   // current aggro lock, or null
    building,                                   // true for Cannon (no movement)
    lifetime, maxLifetime,                      // building self-destruct timer
  }],
  projectiles: [{                               // in-flight arrows / bullets / spells
    id, owner, mine, kind:'bolt'|'spell', card,
    x, y, targetId, tx, ty,                     // bolt → targetId; spell → fixed (tx,ty)
  }],
  cards: { Knight:{...defs}, ... },             // static stats for planning
}
```

### 7.2 The action (output)

Return `null` to do nothing, or:

```js
{ card: 'Knight', x: 9, y: 10 }     // by card name (must be in hand)
{ handIndex: 0,    x: 9, y: 10 }    // or by hand slot 0..3
```

Illegal actions (not enough elixir, card not in hand, tile outside the legal zone) are ignored
by the engine — they cost nothing and simply don't happen. Bot exceptions are caught and treated
as "do nothing this tick", so a buggy script just plays badly instead of crashing the match.

---

## 8. The agent iteration loop

This is the whole purpose of the project. Two CLI tools drive it:

| Tool | Command | Purpose |
|------|---------|---------|
| Arena   | `node tools/arena.js A B [games=100] [seed=1]` | Fast win rate, A vs B (no logging). Sides are swapped every other game so neither bot keeps the deploy/elixir-tick advantage. |
| Analyze | `node tools/analyze.js A B [seed=1]`<br>`node tools/analyze.js A B --series N` | Full event log + per-player efficiency + a plain-language *why-it-lost* diagnosis for one game, or aggregated stats + a sample loss report over a series. |

Loop:

1. Edit the bot in `bots/Claude_Opus_4_7.js` (or copy it to a new filename to
   benchmark against the incumbent).
2. `node tools/arena.js mybot Claude_Opus_4_7 200` — measure the mirror over
   200 games. Re-run with `[seed=201]`, `[seed=401]` etc. for disjoint seed
   bands; 200-game runs have ~3.5pp noise so a single band can mislead.
3. `node tools/analyze.js mybot Claude_Opus_4_7 --series 50` — read the
   aggregate diagnosis (elixir leaked, spell waste, failed plays, loss
   reasons, the sample loss report) and form a hypothesis.
4. Change one thing, re-measure. Keep changes that clear the noise floor on
   multiple seed bands; revert ones that don't. The bot file header is the
   place to document both the kept levers and the measured dead-ends so the
   next iteration doesn't blindly re-explore them.
5. `npm run serve` to watch a match in the browser (`Claude_Opus_4_7` is the
   sole registered bot, used by both sides by default → a mirror).

### 8.1 Worked example (this is real, reproducible output)

`Claude_Opus_4_7` was iterated from the prior in-repo champion. The agent
tried each lever in isolation against the prior champion over 600+ games and
kept only ones that landed above 50% on multiple disjoint seed bands; the
losers were documented in the bot file header so the next pass doesn't
re-explore them.

Six small structural changes survived:

1. Forward proactive Cannon at `(W/2, mid-1.5)` — locks the opp Giant on deploy.
2. Arrows-before-Fireball for swarm clears whose max-HP unit fits in Arrows.dmg.
3. Closer support stagger (`giant.y - 1.5` vs `-2.5`).
4. Lower raid threshold (`E≥6` vs `E≥7`).
5. Behind-on-crowns Giant gate (`E≥7` vs `E≥8`).
6. Lower Knight (`E≥6`) / Goblins (`E≥7`) gates for the second-wave support behind a live Giant.

Result: **53.1% / 2000 games** vs the prior champion across 10 disjoint seed
bands, p < 0.01 binomial. Stays at 64–68% against the prior-prior generation,
so the new levers don't trade away the existing dominance over weaker bots.

Because matches are reproducible, a regression in win rate is a real signal,
not noise, and every kept lever has logged evidence in the bot file header.

---

## 9. Determinism contract

- Single seeded PRNG (`mulberry32`) lives on the state; used only for deck shuffles and the
  (rare) tower-HP-tiebreak. Combat/movement are fully deterministic.
- Fixed timestep; no `Date.now()` / `Math.random()` anywhere in the engine.
- Therefore `(seed, botA, botB)` ⇒ identical match every time, in browser or Node.
- Bots must not call `Math.random()` either; if you need pseudo-randomness, derive it
  from `view.tick` or a hash of the game state so the whole pipeline stays reproducible.

## 10. Possible extensions (post-v1)

Projectile travel time; unit collision/pushback; more cards; fog of war (hide enemy hand/elixir)
as a difficulty switch; tournament/Elo harness across many bot versions; record & replay files.
