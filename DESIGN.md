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
package.json            # type:module; npm run arena / npm run serve
index.html              # browser viewer
src/
  rng.js                # mulberry32 seeded PRNG
  config.js             # arena, timing, elixir, tower constants
  cards.js              # the 8 card definitions + spawn logic
  state.js              # initial state factory, deck shuffling, tower layout
  engine.js             # step(state, actions): the whole simulation tick
  view.js               # builds the read-only scene graph handed to a bot
  match.js              # headless + interactive match drivers
  renderer.js           # cheap canvas 2D drawing
  registry.js           # list of selectable bots for the viewer
  main.js               # viewer wiring: dropdowns, play/pause/speed
bots/
  lib.js                # helper functions bots may import (dist, nearest…)
  idle.js               # baseline: does nothing
  random.js             # baseline: random legal plays (seeded by tick)
  rush.js               # simple one-lane aggression
  defender.js           # reactive defense + counter-push
  example.js            # heavily commented template for the agent
tools/
  arena.js              # node tools/arena.js <botA> <botB> [games]
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

| Card      | Cost | Kind  | Count | HP   | Dmg | Hit(s) | Range | Speed | Air? | Targets        |
|-----------|------|-------|-------|------|-----|--------|-------|-------|------|----------------|
| Knight    | 3    | troop | 1     | 1766 | 202 | 1.2    | 1.2   | 1.00  | no   | ground         |
| Archers   | 3    | troop | 2     | 304  | 112 | 0.9    | 5.0   | 1.00  | no   | ground + air   |
| Goblins   | 2    | troop | 4     | 202  | 120 | 1.1    | 0.5   | 2.00  | no   | ground         |
| Giant     | 5    | troop | 1     | 3968 | 253 | 1.5    | 1.2   | 0.75  | no   | buildings only |
| Minions   | 3    | troop | 3     | 230  | 107 | 1.1    | 2.5   | 1.50  | yes  | ground + air   |
| Musketeer | 4    | troop | 1     | 721  | 217 | 1.0    | 6.0   | 1.00  | no   | ground + air   |
| Fireball  | 4    | spell | —     | —    | 688 | —      | 2.5r  | —     | —    | area (207 → towers) |
| Arrows    | 3    | spell | —     | —    | 366 | —      | 3.5r  | —     | —    | area (93 → towers)  |

All values are **real Clash Royale data at Tournament Standard (Level 11)** — the
long-standing competitive reference. Source: Liquipedia (current, 2026 patch notes)
cross-validated against the Fandom wiki / RoyaleAPI / deckshop. Conversions: speed =
CR tiles/min ÷ 60 (Slow 45→0.75, Medium 60→1.00, Fast 90→1.50, Very Fast 120→2.00);
range/radius in tiles (melee Short=0.5, Medium=1.2); hit speed/deploy in seconds
(deploy = standard 1.0 s). Spells deal real reduced crown-tower damage. `sight`/aggro
range (~5.5 tiles, slightly beyond a ranged unit's range) is the one engine
convention — it isn't a cleanly published per-card stat. All values live in
`src/cards.js`.

**Design intent of this set:** a tank (Giant), a mini-tank (Knight), swarm (Goblins/Minions),
ranged support (Archers/Musketeer), an air unit (Minions), single-target spell (Fireball),
swarm-clear spell (Arrows). Enough rock-paper-scissors for strategy to matter.

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
  tick, time, timeRemaining, phase: 'normal'|'overtime', doubleElixir: bool,
  arena: { width, height, mid, river:[lo,hi], bridges:[x1,x2] },
  self:  {
    id, elixir, elixirMax,
    hand: [{ card, cost, kind }, x4],
    next: { card, cost, kind },
    deck: [cardName x8],
    deployZone: { minX, maxX, minY, maxY },   // legal troop placement rect
  },
  enemy: { id, elixir, hand:[...], next:{...}, deck:[...] },   // visible too
  towers: [{ id, owner, kind:'king'|'princess', side, x, y, hp, maxHp, alive, activated }],
  units:  [{ id, owner, card, x, y, hp, maxHp, flying, range, speed, deploying, targetId }],
  cards:  { Knight:{...defs}, ... },          // static stats for planning
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

This is the whole purpose of the project. Three CLI tools drive it:

| Tool | Command | Purpose |
|------|---------|---------|
| Arena | `node tools/arena.js A B [games]` | Fast win rate, A vs B (no logging). |
| Analyze | `node tools/analyze.js A B [seed]`<br>`node tools/analyze.js A B --series N` | Full event log + per-player efficiency + a plain-language *why-it-lost* diagnosis for one game, or aggregated over a series. |
| Self-play | `node tools/selfplay.js <challenger> [games] [--promote]` | Challenger vs the reigning `bots/champion.js`. Prints win rate + an aggregate diagnosis of how the challenger played + one concrete loss. `--promote` overwrites the champion **iff** the challenger clears the bar (≥55% win **and** ≥50% decided). |
| Trace | `node tools/trace.js A B [seed]` | One fully-instrumented game → `traces/A-vs-B-seed<n>.{txt,jsonl}`. Every card play (with spawned unit IDs) and **every combat hit**: attacker→victim, damage, tile, hp delta, death. Stable IDs `<Card>_<A\|B>_<n>` (A=P0, B=P1). Verbose `trace` mode is opt-in and never touches the sim or the live viewer. |

Loop:

1. Write / edit a bot in `bots/` (start from `bots/example.js`).
2. `node tools/selfplay.js mybot 80` — measure vs champion and **read the diagnosis**
   (elixir leaked, spell waste, failed plays, loss reasons, the sample loss report).
3. Form a hypothesis from the log, change the strategy, repeat.
4. `--promote` when it clears the bar; the champion advances and the ladder continues.
5. `node tools/analyze.js mybot champion 7` to inspect a single game tick-by-tick;
   `npm run serve` to watch it in the browser (`smart` and `champion` are registered).

### 8.1 Worked example (this is real, reproducible output)

The seed champion was `defender` (the strongest hand-written bot, ~84% vs `rush`).
A challenger `smart` was then iterated **from the logs**:

```
v1  Giant beatdown + value spells .......... 70% vs defender  -> PROMOTED champion
v2  + heavy "closing" gates ............... 50% (over-defended, 48 draws)   reject
v3  v1 aggression + legal-deploy fix ....... 60%  W23 L15 D42  (best variant)
v4  + spell-chip while Giant crossed ....... 60% (dead path: Giant rarely crosses)
v5  + lane-avoid + back-fed support ........ 50% (51 draws)                  reject
v6  fast-cycle chip archetype .............. 50% (71 draws)                  reject
```

`smart` (v3) beats the original `defender` **86.7% (22-0-8, 100% of decided games)**
— a large, measured improvement the loop produced and locked in. Note the loop also
*correctly rejected* v2/v5/v6 regressions: the promotion gate is what keeps win-rate
gains real. The remaining draws are an equal-vs-equal mirror artifact (both bots defend
optimally); breaking it needs a deeper push-timing model or a wider opponent pool —
the harness is built for exactly that next step.

Because matches are reproducible, a regression in win rate is a real signal, not noise,
and every promotion is backed by logged evidence.

---

## 9. Determinism contract

- Single seeded PRNG (`mulberry32`) lives on the state; used only for deck shuffles and the
  (rare) tie-break. Combat/movement are fully deterministic.
- Fixed timestep; no `Date.now()` / `Math.random()` anywhere in the engine.
- Therefore `(seed, botA, botB)` ⇒ identical match every time, in browser or Node.
- Sample bots avoid `Math.random()` (the `random` bot is seeded from the tick) so the whole
  pipeline stays reproducible.

## 10. Possible extensions (post-v1)

Projectile travel time; unit collision/pushback; more cards; fog of war (hide enemy hand/elixir)
as a difficulty switch; tournament/Elo harness across many bot versions; record & replay files.
