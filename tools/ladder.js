// Round-robin Elo ladder — the generalist promotion criterion (HANDOFF §7.1).
//
//   node tools/ladder.js <challenger> [games=60] [--promote] [--seed S]
//
// WHY THIS EXISTS: the single-champion gate (tools/selfplay.js) stalls once the
// champion is strong — an equal reactive bot is a coin-flip mirror (~50%), so a
// genuinely better GENERALIST can never clear ≥55% in that one matchup and the
// ladder freezes (measured: v17-vs-v17, nine micro-levers + a control archetype
// all ~50%). This tool plays a full deterministic round-robin over the ENTIRE
// pool and fits an Elo rating (shown for insight), but the PROMOTION DECISION
// is the mean win rate vs the STABLE DISCRIMINATING FIELD — the strong-but-
// beatable bots (defender, rush, the smart_v* archives) where margins are
// real and low-variance. The coin-flip champion mirror and the saturated
// trivial bots (idle/random/example) are deliberately EXCLUDED from the score
// (they are pure noise / ~100% for everyone). Promote iff the challenger beats
// that field clearly better than the incumbent champion does AND is not itself
// exploitable by the champion. Sanity-checked: a bot byte-identical to the
// champion scores equal on the field and is correctly NOT promoted.

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { runSeries } from '../src/match.js';

const here = dirname(fileURLToPath(import.meta.url));
const botsDir = resolve(here, '..', 'bots');
const botPath = (name) => resolve(botsDir, `${name}.js`);

async function loadBot(name) {
  const mod = await import(pathToFileURL(botPath(name)).href);
  if (typeof mod.default !== 'function') throw new Error(`no default fn`);
  return mod.default;
}

// The stable discriminating field — strong-but-beatable bots where win-rate
// margins are real and low-variance (unlike the ~50% champion mirror and the
// ~100%-for-everyone trivial bots). The promotion decision is mean win rate
// vs whichever of these are present in bots/.
const DISCRIMINATING = ['defender', 'rush', 'smart_v8', 'smart_v9', 'smart_v10', 'smart_v11'];
// Promote only on a clear generalist edge over the incumbent — and never a bot
// that is itself badly exploitable by the champion it would replace.
// Field score is deterministic (no noise) and 3-seed-averaged, so a reproducible
// +0.5pp over the incumbent is a genuine generalist gain, not luck.
const FIELD_MARGIN = 0.005; // challenger's field score must beat champion's by ≥0.5pp
const MIN_VS_CHAMP = 0.45; // ...and not lose the head-to-head worse than this

async function main() {
  const args = process.argv.slice(2);
  const chalName = args[0];
  if (!chalName) {
    console.error('usage: node tools/ladder.js <challenger> [games] [--promote] [--seed S]');
    process.exit(1);
  }
  const games = Number(args[1]) || 60;
  const promote = args.includes('--promote');
  const si = args.indexOf('--seed');
  const baseSeed = si !== -1 ? Number(args[si + 1]) || 1 : 1;

  // Pool = every loadable bot except the pure-helper lib and the challenger
  // itself. Includes champion, the smart_v* archives, and the baselines —
  // a wide, skill-diverse field so Elo measures true generalist strength.
  const files = readdirSync(botsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .filter((n) => n !== 'lib' && n !== chalName)
    .sort();

  const names = [chalName, ...files];
  const bots = {};
  for (const n of names) {
    try {
      bots[n] = await loadBot(n);
    } catch (e) {
      if (n === chalName) {
        console.error(`challenger "${chalName}" failed to load: ${e.message}`);
        process.exit(1);
      } // else: silently skip non-bot files
    }
  }
  const players = names.filter((n) => bots[n]);

  // Full round-robin, each pair averaged over 3 base seeds. runSeries is fully
  // deterministic and swaps sides every game (fair), so field score has ZERO
  // noise — but a single seed can still be over-fit, so averaging 3 seeds
  // makes a positive margin a robust, reproducible generalist gain.
  const SEEDS = [baseSeed, baseSeed + 1, baseSeed + 2];
  const t0 = Date.now();
  const score = {}; // "a|b" -> a's win rate (draws = ½), avg over SEEDS
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      let wr = 0;
      for (const s of SEEDS) wr += runSeries(bots[a], bots[b], games, s).winRate;
      wr /= SEEDS.length;
      score[`${a}|${b}`] = wr;
      score[`${b}|${a}`] = 1 - wr;
    }
  }

  // Fit Elo by deterministic iterative update (inputs are fixed, so this
  // converges to the same ratings every run). Mean anchored to 1500.
  const R = {};
  for (const p of players) R[p] = 1500;
  for (let epoch = 0; epoch < 6000; epoch++) {
    const K = epoch < 3000 ? 6 : 2;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const sa = score[`${a}|${b}`];
        const ea = 1 / (1 + 10 ** ((R[b] - R[a]) / 400));
        const d = K * (sa - ea);
        R[a] += d;
        R[b] -= d;
      }
    }
    let mean = 0;
    for (const p of players) mean += R[p];
    mean /= players.length;
    for (const p of players) R[p] += 1500 - mean;
  }

  const ranked = [...players].sort((a, b) => R[b] - R[a]);
  const ms = Date.now() - t0;

  console.log(`\n  ELO LADDER — challenger ${chalName}  (${players.length} bots, ${games} games/pair, ${ms} ms)`);
  console.log('  ' + '='.repeat(58));
  ranked.forEach((p, i) => {
    const tag = p === chalName ? ' ← challenger' : p === 'champion' ? ' ← champion' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${p.padEnd(12)} ${Math.round(R[p])}${tag}`);
  });

  console.log('  ' + '-'.repeat(58));
  console.log(`  ${chalName} win rate vs field:`);
  for (const p of ranked) {
    if (p === chalName) continue;
    const wr = score[`${chalName}|${p}`];
    console.log(`    vs ${p.padEnd(12)} ${(wr * 100).toFixed(1)}%`);
  }

  // Decisive metric: mean win rate vs the stable discriminating field.
  const field = DISCRIMINATING.filter((d) => d !== chalName && bots[d]);
  const fieldScore = (x) =>
    field.reduce((s, d) => s + score[`${x}|${d}`], 0) / field.length;
  const chalField = fieldScore(chalName);
  const champField = 'champion' in bots ? fieldScore('champion') : null;
  const vsChamp = score[`${chalName}|champion`];

  const beatsChampField =
    champField == null || chalField >= champField + FIELD_MARGIN;
  const notExploitable = vsChamp == null || vsChamp >= MIN_VS_CHAMP;
  const passes = beatsChampField && notExploitable;

  console.log('  ' + '-'.repeat(58));
  console.log(`  Discriminating field: ${field.join(', ')}`);
  console.log(
    `  field score:  ${chalName} ${(chalField * 100).toFixed(1)}%` +
      (champField == null ? '' : `   champion ${(champField * 100).toFixed(1)}%   Δ ${((chalField - champField) * 100).toFixed(1)}pp`)
  );
  console.log('  ' + '='.repeat(58));
  console.log(
    `  Verdict: ${passes ? 'CHALLENGER IS THE BETTER GENERALIST' : 'champion holds'}`
  );
  console.log(
    `    field Δ ≥ +${(FIELD_MARGIN * 100).toFixed(1)}pp: ${beatsChampField} | ` +
      `vs champion ${vsChamp == null ? 'n/a' : (vsChamp * 100).toFixed(1) + '%'} (need ≥${MIN_VS_CHAMP * 100}%): ${notExploitable}`
  );

  if (promote) {
    if (passes) {
      const src = readFileSync(botPath(chalName), 'utf8');
      const banner =
        `// PROMOTED CHAMPION — copied from bots/${chalName}.js by tools/ladder.js\n` +
        `// better generalist: field score ${(chalField * 100).toFixed(1)}% vs prev champion ` +
        `${(champField * 100).toFixed(1)}% (${games} games/pair)\n\n`;
      writeFileSync(botPath('champion'), banner + src);
      console.log(`  >> PROMOTED: bots/champion.js is now ${chalName}.`);
    } else {
      console.log('  >> Not promoted (not the clear best generalist).');
    }
  } else if (passes) {
    console.log('  (run again with --promote to crown it)');
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
