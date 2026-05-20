// Match analysis CLI — see exactly what happened and why a bot lost.
//
//   node tools/analyze.js <botA> <botB> [seed=1]      # full report for one game
//   node tools/analyze.js <botA> <botB> --series 100  # aggregate insight, A's view
//
// botA plays player 0 in single-game mode.

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless, runSeriesAnalyzed } from '../src/match.js';
import { formatGameReport, summarize, aggregate, diagnose } from '../src/analysis.js';

const here = dirname(fileURLToPath(import.meta.url));

async function loadBot(name) {
  const mod = await import(pathToFileURL(resolve(here, '..', 'bots', `${name}.js`)).href);
  if (typeof mod.default !== 'function') throw new Error(`bot "${name}" has no default function`);
  return mod.default;
}

async function main() {
  const args = process.argv.slice(2);
  const aName = args[0];
  const bName = args[1];
  if (!aName || !bName) {
    console.error('usage: node tools/analyze.js <botA> <botB> [seed | --series N]');
    process.exit(1);
  }
  const [botA, botB] = await Promise.all([loadBot(aName), loadBot(bName)]);

  const si = args.indexOf('--series');
  if (si !== -1) {
    const games = Number(args[si + 1]) || 50;
    const { states, perspective } = runSeriesAnalyzed(botA, botB, games, 1);
    const summaries = states.map(summarize);
    const agg = aggregate(summaries, perspective, aName);

    console.log(`\n  ${aName} vs ${bName} — ${games} games (analyzed)\n  ${'-'.repeat(50)}`);
    console.log(`  win rate          : ${(agg.winRate * 100).toFixed(1)}%  (W ${agg.wins} / L ${agg.losses} / D ${agg.draws})`);
    console.log(`  avg elixir leaked : ${agg.avgElixirLeaked}  (in losses: ${agg.avgElixirLeakedInLosses})`);
    console.log(`  avg elixir spent  : ${agg.avgElixirSpent}`);
    console.log(`  avg tower damage  : ${agg.avgTowerDmg}`);
    console.log(`  spell waste       : ${agg.spellWastePct}%`);
    console.log(`  avg failed plays  : ${agg.avgFailedPlays}`);
    console.log(`  loss reasons      : ${JSON.stringify(agg.lossReasons)}`);
    console.log(`  card usage (${aName}): ${JSON.stringify(agg.cardUse)}`);

    // Show one concrete loss so the agent sees a real failure.
    const lossIdx = summaries.findIndex(
      (s, i) => s.winner !== perspective[i] && s.winner !== 'draw'
    );
    if (lossIdx !== -1) {
      console.log(`\n  ── Sample LOSS (seed ${summaries[lossIdx].seed}) ──`);
      console.log(formatGameReport(states[lossIdx]).split('\n').map((l) => '  ' + l).join('\n'));
    }
    console.log('');
    return;
  }

  const seed = Number(args[2]) || 1;
  const state = runHeadless(botA, botB, seed, { log: true });
  console.log('\n' + formatGameReport(state) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
