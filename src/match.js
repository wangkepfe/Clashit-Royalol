import { createInitialState } from './state.js';
import { buildView } from './view.js';
import { step, decideByTowerHp } from './engine.js';
import { CONFIG } from './config.js';

// A bot exception must never crash a match — a broken script just idles.
function safeCall(bot, view) {
  try {
    const a = bot(view);
    return a == null ? null : a;
  } catch (e) {
    return null;
  }
}

const MAX_TICKS =
  (CONFIG.regulationTime + CONFIG.overtimeTime + 5) * CONFIG.ticksPerSecond;

// Run one full match with no rendering, as fast as possible.
// `bot0` plays player 0, `bot1` plays player 1.
// opts.log = true enables event/stat instrumentation (used for analysis).
// Returns the final state (has .result, and .events/.stats when logging).
export function runHeadless(bot0, bot1, seed, opts) {
  const state = createInitialState(seed, opts);
  while (!state.ended && state.tick < MAX_TICKS) {
    const a0 = safeCall(bot0, buildView(state, 0));
    const a1 = safeCall(bot1, buildView(state, 1));
    step(state, { 0: a0, 1: a1 });
  }
  if (!state.ended) {
    // Safety: force a decision if we somehow hit the tick cap.
    state.ended = true;
    const w = decideByTowerHp(state);
    state.winner = w;
    state.result = { winner: w, reason: 'tickCap', ticks: state.tick };
  }
  return state;
}

// Run a fair series: sides are swapped every other game so neither bot keeps
// the deploy/elixir-tick advantage. Returns results from `botA`'s perspective.
export function runSeries(botA, botB, games, baseSeed = 1) {
  let aWins = 0, bWins = 0, draws = 0;
  for (let i = 0; i < games; i++) {
    const seed = baseSeed + i;
    const aIsP0 = i % 2 === 0;
    const r = (aIsP0 ? runHeadless(botA, botB, seed) : runHeadless(botB, botA, seed)).result;
    if (r.winner === 'draw') draws++;
    else {
      const aWon = aIsP0 ? r.winner === 0 : r.winner === 1;
      if (aWon) aWins++;
      else bWins++;
    }
  }
  const decided = aWins + bWins;
  return {
    games,
    aWins,
    bWins,
    draws,
    winRate: games ? (aWins + draws * 0.5) / games : 0,
    winRateDecided: decided ? aWins / decided : 0,
  };
}

// Like runSeries but logs every game and returns the summaries plus the
// player-id `botA` had each game (so analysis can aggregate from A's view).
export function runSeriesAnalyzed(botA, botB, games, baseSeed = 1) {
  const states = [];
  const perspective = []; // botA's player id per game
  for (let i = 0; i < games; i++) {
    const seed = baseSeed + i;
    const aIsP0 = i % 2 === 0;
    const st = aIsP0
      ? runHeadless(botA, botB, seed, { log: true })
      : runHeadless(botB, botA, seed, { log: true });
    states.push(st);
    perspective.push(aIsP0 ? 0 : 1);
  }
  return { states, perspective };
}

// Interactive driver for the browser viewer. Holds the live state and steps it.
export function createLiveMatch(bot0, bot1, seed) {
  // Log on so the viewer can show a live event feed (negligible cost).
  const state = createInitialState(seed, { log: true });
  return {
    state,
    seed,
    stepOnce() {
      if (state.ended) return false;
      const a0 = safeCall(bot0, buildView(state, 0));
      const a1 = safeCall(bot1, buildView(state, 1));
      step(state, { 0: a0, 1: a1 });
      return !state.ended;
    },
  };
}
