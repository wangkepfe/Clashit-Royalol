// Champion vs Challenger self-play — the iteration harness.
//
//   node tools/selfplay.js <challenger> [games=200] [--promote] [--seed S]
//
// Runs a fair, fully-logged series between <challenger> and the reigning
// champion (bots/champion.js). Prints the win rate and an aggregate diagnosis
// of how the challenger played, plus one concrete loss. With --promote, if the
// challenger clears the bar it is copied over bots/champion.js.

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { runSeriesAnalyzed } from '../src/match.js';
import { summarize, aggregate, diagnose, formatGameReport } from '../src/analysis.js';

const here = dirname(fileURLToPath(import.meta.url));
const botPath = (name) => resolve(here, '..', 'bots', `${name}.js`);

async function loadBot(name) {
  const mod = await import(pathToFileURL(botPath(name)).href);
  if (typeof mod.default !== 'function') throw new Error(`bot "${name}" has no default function`);
  return mod.default;
}

const PROMOTE_WINRATE = 0.55; // challenger must clearly beat the champion
const MIN_DECIDED = 0.5; // and at least half the games must be decisive

async function main() {
  const args = process.argv.slice(2);
  const chalName = args[0];
  if (!chalName) {
    console.error('usage: node tools/selfplay.js <challenger> [games] [--promote] [--seed S]');
    process.exit(1);
  }
  if (chalName === 'champion') {
    console.error('challenger cannot be "champion" itself');
    process.exit(1);
  }
  const games = Number(args[1]) || 200;
  const promote = args.includes('--promote');
  const si = args.indexOf('--seed');
  const baseSeed = si !== -1 ? Number(args[si + 1]) || 1 : 1;

  const [chal, champ] = await Promise.all([loadBot(chalName), loadBot('champion')]);

  const t0 = Date.now();
  const { states, perspective } = runSeriesAnalyzed(chal, champ, games, baseSeed);
  const ms = Date.now() - t0;
  const summaries = states.map(summarize);
  const agg = aggregate(summaries, perspective, chalName);

  const decided = agg.wins + agg.losses;
  const decidedRate = decided / games;

  console.log(`\n  CHALLENGER  ${chalName}   vs   CHAMPION   (${games} games, ${ms} ms)`);
  console.log('  ' + '='.repeat(56));
  console.log(`  ${chalName}: W ${agg.wins}  L ${agg.losses}  D ${agg.draws}`);
  console.log(`  win rate (draws = ½) : ${(agg.winRate * 100).toFixed(1)}%`);
  console.log('  ' + '-'.repeat(56));
  console.log('  How the challenger played (averaged):');
  console.log(`    elixir leaked : ${agg.avgElixirLeaked}   (in losses: ${agg.avgElixirLeakedInLosses})`);
  console.log(`    elixir spent  : ${agg.avgElixirSpent}`);
  console.log(`    tower damage  : ${agg.avgTowerDmg}`);
  console.log(`    spell waste   : ${agg.spellWastePct}%`);
  console.log(`    failed plays  : ${agg.avgFailedPlays}`);
  console.log(`    loss reasons  : ${JSON.stringify(agg.lossReasons)}`);
  console.log(`    card usage    : ${JSON.stringify(agg.cardUse)}`);

  const lossIdx = summaries.findIndex(
    (s, i) => s.winner !== perspective[i] && s.winner !== 'draw'
  );
  if (lossIdx !== -1) {
    console.log(`\n  ── Sample LOSS for ${chalName} (seed ${summaries[lossIdx].seed}) ──`);
    console.log(formatGameReport(states[lossIdx]).split('\n').map((l) => '  ' + l).join('\n'));
  } else {
    console.log(`\n  (no losses — ${chalName} did not lose a single game)`);
  }

  const passes = agg.winRate >= PROMOTE_WINRATE && decidedRate >= MIN_DECIDED;
  console.log('\n  ' + '='.repeat(56));
  console.log(
    `  Verdict: ${passes ? 'CHALLENGER IS STRONGER' : 'champion holds'} ` +
      `(need ≥${PROMOTE_WINRATE * 100}% win & ≥${MIN_DECIDED * 100}% decided; ` +
      `got ${(agg.winRate * 100).toFixed(1)}% & ${(decidedRate * 100).toFixed(0)}%)`
  );

  if (promote) {
    if (passes) {
      const src = readFileSync(botPath(chalName), 'utf8');
      const banner =
        `// PROMOTED CHAMPION — copied from bots/${chalName}.js by tools/selfplay.js\n` +
        `// win rate vs previous champion: ${(agg.winRate * 100).toFixed(1)}% over ${games} games\n\n`;
      writeFileSync(botPath('champion'), banner + src);
      console.log(`  >> PROMOTED: bots/champion.js is now ${chalName}.`);
    } else {
      console.log('  >> Not promoted (did not clear the bar).');
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
