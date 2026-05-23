# Clashit Royalol — Engineering Handoff

Read [`DESIGN.md`](DESIGN.md) first for game rules, arena geometry, the card
table (real Clash Royale Level 11 data), and the bot/view API. This document
is the **state of the work**: what exists, where the strategy notes live, and
what to do next.

Goal of the project: a coding agent iteratively writes a script that plays
this Clash-Royale-like game and maximizes its win rate; matches are
watchable in the browser and fully logged for analysis.

---

## 1. TL;DR for the next agent

- The game engine, the browser viewer, and the headless arena are done and
  working. Determinism is verified (logged-vs-unlogged byte equality).
- The repo ships **exactly one bot**: `bots/Claude_Opus_4_7.js`. The file's
  HEADER is the canonical strategy doc — every kept lever and every
  measured dead-end is documented there, so the next iteration doesn't blindly
  re-explore them.
- Current performance: `Claude_Opus_4_7` mirror is the new equilibrium (50%
  vs itself by symmetry). It beat the prior in-repo champion at **53.1% /
  2000 games** across 10 disjoint seed bands (p < 0.01 binomial).
- The cheap iteration loop is just two CLIs: `tools/arena.js` for fast win
  rate, `tools/analyze.js` for per-game / per-series diagnosis.
- **Mirror variance is real.** A 200-game band has ~3.5pp noise (σ ≈ 1.75pp);
  trust a delta only when it's reproducible across at least 3 disjoint seed
  bands.

---

## 2. How to run things

```bash
# fast win rate, A vs B, sides swapped every other game
node tools/arena.js <A> <B> [games=100] [baseSeed=1]

# one game: full diagnosis (why P0 / P1 lost), or aggregate over a series
node tools/analyze.js <A> <B> [seed=1]
node tools/analyze.js <A> <B> --series 50

# watch in browser (the dropdown defaults to Claude_Opus_4_7 vs Claude_Opus_4_7)
npm run serve         # then open http://localhost:8080
```

Bots are loaded by filename from `bots/<name>.js` (default export
`(view) => action | null`). Add new bots there; register in `src/registry.js`
(one line) only if you want them in the viewer dropdown — `arena.js` and
`analyze.js` load by filename and don't need registration.

---

## 3. File map (status)

| Path | Purpose | Touch with care? |
|---|---|---|
| `src/config.js`   | Arena, timing, elixir, **real L11 tower stats**. | Balance knob box. |
| `src/cards.js`    | The 8 cards (**real L11 data**), spawn + spell logic, unit naming. | Stats are sourced; see DESIGN §5. |
| `src/rng.js`      | Seeded mulberry32 + shuffle + `hash01`. | Determinism core. |
| `src/state.js`    | Initial state, tower layout/names, opt-in `log`/`trace` flags. | — |
| `src/engine.js`   | The whole tick: deploy, AI, combat, towers, projectiles, win logic, instrumentation. | **Sim-critical.** Changing combat numbers invalidates every measured benchmark. |
| `src/view.js`     | Builds the read-only per-tick scene graph (full info, incl. enemy hand). | Public bot API — keep stable. |
| `src/analysis.js` | `summarize` / `diagnose` / `aggregate` / `formatGameReport`. | Reporting only. |
| `src/match.js`    | `runHeadless` (returns **state**, has `.result`), `runSeries`, `runSeriesAnalyzed`, `createLiveMatch`. | — |
| `src/renderer.js`, `src/sprites.js`, `src/main.js`, `index.html` | 2D canvas viewer + sprite draw routines + controls + event feed. | UI only. |
| `bots/Claude_Opus_4_7.js` | The bot. Header documents kept levers + dead ends. | The whole iteration log lives in the file's header. |
| `bots/lib.js`     | Helper functions a bot may import (`dist`, `myUnits`, `enemyUnits`, `myTowers`, `enemyTowers`, …). | — |
| `tools/arena.js`  | Fast win-rate runner; sides alternate. | — |
| `tools/analyze.js`| Single-game or `--series N` diagnosis. | — |
| `tools/bake-bg.js`, `tools/bg-scene.js` | Offline arena background pre-bake. | Asset tooling only. |

---

## 4. Instrumentation contract (important)

Two opt-in modes on `createInitialState(seed, opts)` /
`runHeadless(a, b, seed, opts)`:

- `{ log: true }` — lightweight: `play`, `spell`, `playFailed`,
  `towerDestroyed`, `buildingDestroyed`, `buildingExpired`, `kingActivated`,
  `end` events + per-player `stats`. Used by analysis and the **live viewer**
  (the viewer stays fast under this mode).
- `{ trace: true }` — verbose: everything in `log` **plus** a `damage` event
  for every hit and a `death` event per kill, with stable IDs, tiles, hp
  deltas. Heavy (hundreds–thousands of events per game).

**Verified invariant:** the simulation is byte-identical with logging/trace
on or off (`runHeadless` result equal). Never put logic behind `logEnabled` —
instrumentation must not affect the sim. Keep it that way.

Stable IDs: units `<Card>_<A|B>_<n>` (A=P0, B=P1, n per owner+card), towers
`KingTower_A` / `PrincessTower_left_B` etc. Also exposed as `name` on
`view.units[]` / `view.towers[]` so a bot can correlate live state with logs.

Gotcha: `runHeadless` returns the **final `state`** (use `.result` for the
outcome). `runSeries` does this internally.

---

## 5. Where the strategy lives

The bot's strategy is **fully documented in `bots/Claude_Opus_4_7.js`'s
header comment**, not here. The header covers:

- Each kept lever, with the measured delta and the reason it works (target
  lock math for the forward Cannon, elixir-math for the spell preference,
  etc.).
- Each measured **dead end** with the result (e.g., "Goblins as Giant escort:
  -3.3pp — Goblins speed 2.0 outruns the slow Giant, dies alone to
  defenders"). Read these before retrying anything.

Keep that header up to date when you change the bot. If the strategy notes
ever grow past what's reasonable in a source file, split them into
`bots/Claude_Opus_4_7.md` next to the bot — but a single file is the cleanest
default.

---

## 6. Known traps & gotchas

1. **Determinism is mandatory.** Bots must not call `Math.random()`. If you
   need pseudo-randomness, derive it from `view.tick` or other game state.
   `runHeadless` byte-equality with/without `{ trace: true }` is the
   verification step in §8.
2. **Mirror variance:** 200-game runs swing about ±3.5pp around the mean.
   A single seed band's 53% can drift to 49% on the next. Always run multiple
   disjoint seed bands (`baseSeed=1`, `201`, `401`, …) before believing a
   delta. p < 0.01 needs ~2000 games for a 2-3pp edge.
3. **Promotion-gate rounding (analyze.js):** `aggregate()` r1-rounds
   `winRate` to one decimal. The printed "50.0%" can mean anything in 49.5%
   to 50.5%; always read the raw `W` count, not the percentage.
4. **Noisy diagnosis heuristic:** "First card only at ~8s — slow start" fires
   on essentially every game. Waiting ~8s for the first Giant (start elixir
   5, Giant cost 5, push at E≥7-8) is *optimal*, not a mistake; don't chase
   that line of the diagnosis. If it bothers you, raise the threshold in
   `src/analysis.js diagnose()` to ~12s.
5. **Cannon position vs Giant target-lock:** the Cannon must be in the
   Giant's sight (6.0 tiles) **before** the Giant aggros my princess.
   `(W/2, mid-1.5)` puts the Cannon at 5.85 from a lane-deployed Giant —
   inside sight, locks on deploy. `(W/2, mid-2.5)` is at 6.04 — out of
   sight, locks 1.5 tiles later. This 0.2-tile delta is one of the
   measurable levers in the current bot's header.

---

## 7. Recommended next steps (in priority order)

1. **Push-timing prediction.** The view exposes `enemy.elixir`,
   `enemy.hand`, `enemy.next`. The current bot only uses `enemy.elixir ≤ 2`
   (the `enemyStarved` gate). A more interesting commit window is when the
   opponent **just spent on defense** and their hand has no immediate Giant
   counter (Cannon / Goblins / Knight). Earlier attempts at this lever
   regressed (see the bot header dead-end list) because the cycle refills
   too fast; a fix would probably also need to gate on the visible
   `enemy.next` and a longer time-since-their-last-cheap-defense window.
2. **Split-lane archetype.** The current bot is mono-lane (lane-locked
   beatdown with a one-shot raid). A bot whose *baseline* is a coordinated
   two-lane push — Giant + escort one side, Knight + ranged the other —
   might break the mirror by making the opponent's single-lane reactive
   defense always wrong. The repo's tooling supports this; nobody's built
   it yet.
3. **Counter-push conversion timing.** Smart's contested-defense → Giant
   counter is good but coarse. Trace-mine seeds where my counter-push
   fizzles at the bridge to find the exact timing/position fixes (escort
   y too far back? escort drops one tile sooner?).
4. **Optional polish:** fog-of-war difficulty switch (hide enemy hand /
   elixir in `view.js`), replay files for the viewer (`{ log: true }`
   already captures everything needed).

Workflow for any of these: edit the bot → `node tools/arena.js mybot
Claude_Opus_4_7 200 [seed]` across 3+ disjoint seed bands → if it holds up,
`node tools/analyze.js mybot Claude_Opus_4_7 --series 50` to read the
diagnosis → form one hypothesis → change one thing → re-measure. Keep
changes small, kept changes only when they hold across bands, and document
both wins and dead-ends in the bot file's header.

---

## 8. Verification before you hand off again

```powershell
# sanity: mirror is the new 50%
node tools/arena.js Claude_Opus_4_7 Claude_Opus_4_7 200

# determinism (must print "true / true"):
node -e "import('./src/match.js').then(async m=>{const c=(await import('./bots/Claude_Opus_4_7.js')).default;const a=m.runHeadless(c,c,7,{trace:true}).result,b=m.runHeadless(c,c,7,{trace:true}).result,d=m.runHeadless(c,c,7).result;console.log(JSON.stringify(a)===JSON.stringify(b), JSON.stringify(a)===JSON.stringify(d));})"
```

If any of these regress, you broke the engine or the bot — bisect from the
last green commit. Never modify `src/engine.js` combat numbers without
re-running multi-seed-band benchmarks: combat changes silently invalidate
every measured win-rate in this repo.
