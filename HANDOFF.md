# Conflict Royale — Engineering Handoff

Read [`DESIGN.md`](DESIGN.md) first for game rules, arena geometry, the card table
(real Clash Royale Level 11 data), and the bot/view API. This document is the
**state of the work**: what exists, what's been tried, what's broken, and where
to go next. Goal of the project: a coding agent iteratively writes a script that
plays this Clash-Royale-like game and maximizes win rate; matches are watchable
in the browser and fully logged for analysis.

---

## 1. TL;DR for the next agent

- The game engine, web viewer, and a full **self-play + trace** toolchain are
  done and working. Determinism is verified.
- Bot lineage: `defender` → v1 → v10 → v16 → **`champion.js` = "v17"**
  (auto-promoted, 64.5%/200 vs v16; robust 57–64.5% over 4 seed ranges; vs idle
  100%, defender 97.5%, rush 95%). `smart.js` is now v17 too — build v18.
- Two promotion paths now exist:
  1. `tools/selfplay.js smart 200 --promote` — single-champion mirror, ≥55%.
     **Stalled at v17**: the strong mirror is a coin-flip (see §5 v18 table).
  2. `tools/ladder.js smart [games] --promote` — the §7.1 unlock, now built:
     full round-robin Elo (display) + the real gate = mean win rate vs the
     **stable discriminating field** (defender/rush/smart_v8–v11), 3-seed-
     averaged, promote on ≥+0.5pp over champion AND ≥45% vs champion. Field
     score is **deterministic** (zero noise) so a reproducible margin is a
     genuine generalist gain; an identical-to-champion bot scores Δ 0.00 and is
     correctly NOT promoted (validated). Prefer this — it can climb past the
     mirror stall by rewarding the best generalist.
- **Do not re-explore the dead ends in §5.** They are measured and reproducible.
- The coin-flip mirror WAS cracked (v12→v16, see §5): not by one lever but by
  a package — lane concentration + supported-Giant gate + *not* over-defending
  (counter-attack past pushes) + split-lane raid + zero elixir leak. The single
  biggest jump was the zero-leak fix alone (W109→W119).
- **Promotion-gate rounding gotcha:** `aggregate()` r1-rounds `winRate` to 1
  decimal, so the gate needs **≥110/200 wins** (54.5% rounds to 0.5 and FAILS;
  55.0% rounds to 0.6). The printed "50.0%" can mean anything 45–55%; always
  read raw `W` not the percentage.

---

## 2. How to run things

```bash
# fast win rate, no logging
node tools/arena.js <A> <B> [games=100] [seed=1]

# one game: full diagnosis (why it lost) ; or aggregate over a series
node tools/analyze.js <A> <B> [seed=1]
node tools/analyze.js <A> <B> --series 100

# challenger vs bots/champion.js ; --promote overwrites champion iff it clears the bar
node tools/selfplay.js <challenger> [games=200] [--promote] [--seed S]

# ONE fully-instrumented game -> traces/<A>-vs-<B>-seed<n>.{txt,jsonl}
node tools/trace.js <A> <B> [seed=1]

# watch in browser
npm run serve         # then open http://localhost:8080  (or use the preview tool)
```

Bots are loaded by filename from `bots/<name>.js` (default export
`(view) => action | null`). Add new bots there; register in
`src/registry.js` (one line) only if you want them in the viewer dropdown.

---

## 3. File map (status)

| Path | Purpose | Touch with care? |
|---|---|---|
| `src/config.js` | Arena, timing, elixir, **real L11 tower stats**. | Balance knob box. |
| `src/cards.js` | The 8 cards (**real L11 data**), spawn + spell logic, unit naming. | Stats are sourced; see DESIGN §5. |
| `src/rng.js` | Seeded mulberry32 + shuffle + `hash01`. | Determinism core. |
| `src/state.js` | Initial state, tower layout/names, opt-in `log`/`trace` flags. | — |
| `src/engine.js` | The whole tick: deploy, AI, combat, towers, win logic, instrumentation. | **Sim-critical.** Changing combat changes balance + invalidates the iteration log. |
| `src/view.js` | Builds the read-only per-tick scene graph (full info, incl. enemy). | Public bot API — keep stable. |
| `src/analysis.js` | `summarize`, `diagnose`, `aggregate`, `formatTrace`. | Reporting only. |
| `src/match.js` | `runHeadless` (returns **state**, has `.result`), `runSeries`, `runSeriesAnalyzed`, `createLiveMatch`. | — |
| `src/renderer.js`, `src/main.js`, `index.html` | Cheap 2D canvas viewer + controls + event feed. | UI only. |
| `bots/*.js` | `idle`,`random`,`rush`,`defender`,`example`,`lib`,`smart`(v8),`champion`(v1). | — |
| `tools/*.js` | `arena`,`analyze`,`selfplay`,`trace`,**`ladder`** (round-robin Elo + generalist gate, §1/§7.1). | — |
| `traces/` | Generated trace files (git-ignored conceptually; safe to delete). | — |

---

## 4. Instrumentation contract (important)

Two opt-in modes on `createInitialState(seed, opts)` / `runHeadless(a,b,seed,opts)`:

- `{ log:true }` — lightweight: `play`, `spell`, `playFailed`, `towerDestroyed`,
  `kingActivated`, `end` events + per-player `stats`. Used by analysis,
  selfplay, and the **live viewer** (so the viewer stays fast).
- `{ trace:true }` — verbose: everything in `log` **plus** a `damage` event for
  every hit and a `death` event per kill, with stable IDs, tiles, hp deltas.
  Heavy (hundreds–thousands of events/game). Used only by `tools/trace.js`.

**Verified invariant:** the simulation is byte-identical with logging/trace on
or off (`runHeadless` result equal). Never put logic behind `logEnabled` —
instrumentation must not affect the sim. Keep it that way.

Stable IDs: units `=<Card>_<A|B>_<n>` (A=P0, B=P1, n per owner+card), towers
`KingTower_A` / `PrincessTower_left_B` etc. Also exposed as `name` on
`view.units[]` / `view.towers[]` so a bot can correlate live state with traces.

Gotcha: `runHeadless` returns the **final `state`** (use `.result` for the
outcome). `runSeries` already does this internally.

---

## 5. Iteration log — what's been tried (DO NOT REPEAT)

Seed champion was `defender` (best hand-written bot, ~84% vs `rush`). `smart` was
iterated from logs; each line measured with `tools/selfplay.js` 80 games unless
noted. **`champion.js` currently holds v1.**

| Ver | Idea | Result vs champion | Verdict |
|---|---|---|---|
| v1 | Giant beatdown + value spells (vs `defender`) | 70% vs defender | **PROMOTED → champion** |
| v2 | v1 + heavy "closing" gates | 50% (over-defended, 48 draws) | reject |
| v3 | v1 aggression + `legalY` deploy fix | 60% W23 L15 D42 | best of the beatdown line |
| v4 | v3 + spell-chip while Giant past river | 60% (identical — Giant rarely crosses; dead path) | reject |
| v5 | v3 + lane-avoid + back-fed support | 50% (51 draws) | reject |
| v6 | fast-cycle chip archetype (no big push) | 50% (71 draws, never banks for Giant) | reject |
| v7 | trace-grounded: tank-first, support trails advanced lead, no naked swarm, spell-aim-at-tower, synergy counter table | 50% W28 L25 **D27** | mechanically fixed, win-neutral |
| v8 | v7 + Knight-lead push when no Giant, anti-leak | ~45–50% W22 L27 D31 | superseded |
| v10 | v8 + real spell projectile travel (lead the clump) | promoted (prev champion) | superseded by v16 |

### v12 → v16 — the package that cracked the v10 mirror (W/200 vs v10)

Measured one layer at a time; **only the combination clears the bar**:

| Ver | Change | W/200 | towerDmg | Verdict |
|---|---|---|---|---|
| v10 | (baseline mirror) | 93 | 3123 | — |
| v12 | lane concentration + opposite-default + supported-Giant gate | 95 | 3482 | keep (passive late) |
| v12b | same but champion-tempo Giant (E≥7) | 93 | 3059 | reject (reverts to mirror) |
| v13 | + counter-attack instead of over-defend + split-lane raid | 102 | 3841 | keep |
| v14 | + lane-lock to surviving princess + broaden anti-leak | 107 | 3824 | keep |
| v15 | + "never counter-attack past a tank" (!tank guard) | **77** | 3214 | **REJECT** (over-defense loses) |
| v15b | v14 + contested-defense explicitly converts to Giant push | 109 | 3951 | keep |
| **v16** | + §2 falls through near cap instead of holding (leak 1.5→**0**) | **119** | 4145 | **PROMOTED** 59.5% |

### v17 — cracked the v16 mirror with ONE trace-driven change

v16-vs-v16 was still a coin-flip stalemate. Trace of one P0 Giant: dropped at
y=12 it walked ~13 tiles **alone** for ~15 s; a single enemy Musketeer + tower
ground it to 0 **3 tiles short of the tower, 0 damage** (the elixir gap after
the 5-cost Giant means support never catches up). Fix: deploy the Giant
**forward at the bridge** (`giantY = mid∓1`, max legal y) not deep back.
Result vs v16: **W129/126/114/128 over seeds 1/201/401/601** (57–64.5%),
towerDmg 2616→3137. **PROMOTED at 64.5%/200.** Lesson: the bottleneck was
never *when* to commit the Giant (gates were already permissive) but its
**exposure time** — less walk = it connects before the wall forms.

### v18 — the v17 mirror is a TRUE coin-flip frontier (DO NOT REPEAT)

v17-vs-v17 (seed 7): 0-0 / 300 s, decided by **~164 tower HP** (both chip each
other's right princess ~2000, neither connects). Nine distinct levers tested,
each measured over **5 seed ranges** (baseSeed 1/201/401/601/801 × 200). ALL
landed in the ~47–54% noise band — none robustly ≥55%:

| v18 lever | result | verdict |
|---|---|---|
| counter-attack INTO enemy's just-vacated thin lane | ~52% | neutral; hurt concentration (towerDmg 2614) |
| enemy-hand/elixir "unanswerable" commit window | ~52% | neutral (gates already permissive — redundant) |
| unconditional cheap (Knight/Goblin) escort | ~38% | **bad** (spams cheap units, starves real support) |
| escort-in-hand gate on every Giant commit | ~53% | neutral (fewer Giants ≈ washes out) |
| Fireball-the-defense (clear blockers, n≥2) | ~53.5% | mild + (spell waste 6.8→3.9) but not robust |
| Fireball+Arrows-the-defense | ~53.8% | same — not robust |
| escort-gate + Fireball-defense combined | ~54% | doesn't stack to robust |
| anti-ranged-DPS lane + left tiebreak | ~46% | **bad** (dynamic lane flickers → loses concentration) |
| co-deploy escort at Giant (0.5 vs 2.5 behind) | ~52.7% | neutral |
| finish-mode (drop gates when a princess <45%) | ~51% | neutral |

**Conclusion (re-validates §5's core thesis):** against an *equal* strong
reactive bot the outcome is coin-flip dominated; offense/spell/lane micro-levers
do not break it (only ROOT-CAUSE structural fixes vs a *weaker* champion did:
concentration, zero-leak, forward-deploy). Recurring sub-lessons: stable lane
concentration > clever dynamic lane-picking; aggressive counter-attack >
over-defense; the leak fix and forward-deploy were the only big jumps.
**Do not promote a noise-band (~50-54%/200) candidate** — §6.2 (no
metric-gaming).

### v18 also explored under the NEW generalist (`ladder.js`) criterion

After building `tools/ladder.js`, the same levers were re-judged on the
deterministic 3-seed field score (vs defender/rush/smart_v8–v11). Clean v17 is
the ceiling there TOO: Fireball/Arrows-the-defense −0.83pp, opened-lane deep
lead-conversion **−3.89pp** (deep lone Giant dies to the now-active King),
finish-mode + co-deploy escort regressed, a full control archetype ~6% vs v17.
~14 distinct v18 attempts total; none robustly beats v17 on EITHER criterion.
The Giant-beatdown architecture is structurally dominant here AND v17 is its
robust optimum. Genuine further progress needs a fundamentally different
archetype (§7.2 push-timing model / §7.3 true split-lane) proven on the
`ladder.js` pool — not another beatdown micro-lever.

Key lessons: (1) aggressively counter-attacking *past* Giant pushes is the win
— over-defending, not the Giant, loses the mirror (v15 proved this at 40%).
(2) The largest single jump (W109→W119) was eliminating elixir leak, not any
tactical lever. (3) Concentration (lock the damaged-princess lane) is what
turns scattered 1.7k+1.7k chip into tower kills.

Trace-measured improvements v3 → v8 (these are real, keep them):
`Giant connects to a tower 56% → 90%`, `naked-swarm-wiped-by-1-spell 21 → 15`,
`draws 42 → 27`, `avg towerDmg 1670 → 2531`, `failed plays 0`.

**v8 vs the whole field (60 games each): idle 97%, random 92%, rush 90%,
defender 80%, champion ~45%.** So v8 is a strong *generalist*; it only fails to
clear the bar on the v1 near-mirror.

Key lesson: vs an equal reactive bot the matchup is draw/coin-flip dominated.
Micro-tuning thresholds (v2,v4,v5,v8) does not break it. The mechanical fixes
(v7) removed the draws but not the win-share gap.

---

## 6. Known issues / traps

1. **v1 champion has a real bug**: it deploys support at `myGiant.y ± 2` with no
   legal-zone clamp, so when its Giant crosses the river it spams
   `playFailed:illegalZone` (~17/game, wasting those turns). `smart` v3+ fixed
   this with `legalY`. The bug makes the mirror *noisy* but v1 still trades
   evenly via raw tempo. Exploit it or ignore it — your call — but know it's there.
2. **Promotion gate semantics**: `tools/selfplay.js` promotes only on
   ≥55% win **and** ≥50% decided **vs the single champion**. This under-rewards
   a better *generalist* (v8 beats `defender` 80% vs v1's ~70%, has 0 illegal
   plays, but is ~50% in the mirror). Consider a **round-robin criterion**
   (challenger must beat the whole pool's average / Elo) — this is probably the
   right unlock and a sanctioned next step. Do **not** just lower the threshold
   to force a pass (metric-gaming).
3. **Noisy diagnosis heuristic**: "First card only at ~8s — slow start" fires
   on essentially every game. Waiting to ~8s for the first Giant (start elixir
   5, Giant costs 5, push at E≥7) is *optimal*, not a mistake. Don't chase it.
   Consider raising the threshold in `src/analysis.js diagnose()` to ~12s.
4. **Mirror variance**: 60-game runs of v8 vs champion swing 45–55%. Use ≥150
   games before trusting a mirror delta.
5. The `closing`/overtime tower-chip paths in `smart` are rarely exercised
   (most games end in regulation). Low priority.

---

## 7. Recommended next steps (in priority order)

1. ~~**Change the win criterion to round-robin / Elo** (§6.2).~~ ✅ **DONE** —
   `tools/ladder.js` built & validated (full round-robin Elo display + the
   real gate = deterministic 3-seed mean win rate vs the stable discriminating
   field; identical-bot ⇒ Δ 0.00 ⇒ correctly not promoted). The ladder can now
   climb past the mirror stall by rewarding the best generalist. NOTE: v17 is
   also the robust optimum under THIS criterion (see §5 v18) — the next
   challenger must be a different archetype, not a v17 micro-lever.
2. **Push-timing prediction to crack the mirror.** The draws/coin-flips come
   from both bots reactively trading. An edge requires *predicting* the
   opponent: e.g., track enemy elixir (you can read `view.enemy.elixir`), and
   when the opponent is elixir-starved (just spent on defense), commit a Giant
   push they can't answer. Trace mining shows pushes that connect win; engineer
   *when* to commit using the readable enemy state. This is the real strategic
   depth.
3. **Split-lane / bait pressure.** v8 always pushes one (weakest) lane. A
   second-lane feint when the opponent over-commits one side should beat a
   single-lane reactive defender. Validate with `tools/trace.js` (look for
   "Giant connected" rate per lane).
4. **Counter-push conversion.** After a successful defense, the surviving
   defenders + a fresh Giant should immediately become an attack using the
   elixir lead. Partially present; quantify with traces and tighten timing.
5. Optional polish: projectile travel time, unit collision/pushback, fog-of-war
   difficulty switch (hide enemy hand/elixir in `view.js`), replay files.

Workflow for any of these: edit/add a bot → `node tools/selfplay.js <bot> 150`
→ read the aggregate diagnosis + sample loss → `node tools/trace.js <bot>
champion <seed>` on a specific loss to see the exact failing interactions →
form one hypothesis → change one thing → re-measure. Keep changes small and
measured; the harness rejects regressions for you.

---

## 8. Verification before you hand off again

```bash
node tools/arena.js smart idle 30          # sanity: smart ~>95%
node tools/arena.js smart defender 60      # smart should be ~80%
node tools/selfplay.js smart 120           # the mirror benchmark (~50%)
# determinism (must print true / true):
node -e "import('./src/match.js').then(async m=>{const s=(await import('./bots/smart.js')).default,c=(await import('./bots/champion.js')).default;const a=m.runHeadless(s,c,7,{trace:true}).result,b=m.runHeadless(s,c,7,{trace:true}).result,d=m.runHeadless(s,c,7).result;console.log(JSON.stringify(a)===JSON.stringify(b), JSON.stringify(a)===JSON.stringify(d));})"
```

If any of these regress, you broke the engine or a bot — bisect with the trace
tool. Never modify `src/engine.js` combat numbers without re-running the §5
benchmarks: it silently invalidates the entire iteration log.
