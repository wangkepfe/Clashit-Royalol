// Headless tournament runner — the agent's feedback loop.
//
//   node tools/arena.js <botA> <botB> [games=100] [baseSeed=1]
//   npm run arena -- mybot rush 200
//
// Bots are loaded by filename from ../bots/<name>.js (default export).
// Runs `games` deterministic matches with sides swapped each game for fairness,
// and prints win/loss/draw + win rate from botA's perspective.

import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeries } from '../src/match.js';

const here = dirname(fileURLToPath(import.meta.url));

async function loadBot(name) {
  const path = resolve(here, '..', 'bots', `${name}.js`);
  const mod = await import(pathToFileURL(path).href);
  if (typeof mod.default !== 'function') {
    throw new Error(`bot "${name}" must have a default-exported function`);
  }
  return mod.default;
}

async function main() {
  const [, , aName, bName, gamesArg, seedArg] = process.argv;
  if (!aName || !bName) {
    console.error('usage: node tools/arena.js <botA> <botB> [games=100] [baseSeed=1]');
    process.exit(1);
  }
  const games = Number(gamesArg) || 100;
  const baseSeed = Number(seedArg) || 1;

  const [botA, botB] = await Promise.all([loadBot(aName), loadBot(bName)]);

  const t0 = Date.now();
  const r = runSeries(botA, botB, games, baseSeed);
  const ms = Date.now() - t0;

  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log('');
  console.log(`  ${aName}  vs  ${bName}    (${games} games, ${ms} ms)`);
  console.log('  ' + '-'.repeat(46));
  console.log(`  ${aName} wins : ${r.aWins}`);
  console.log(`  ${bName} wins : ${r.bWins}`);
  console.log(`  draws       : ${r.draws}`);
  console.log('  ' + '-'.repeat(46));
  console.log(`  ${aName} win rate          : ${pct(r.winRate)}  (draws = ½)`);
  console.log(`  ${aName} win rate (decided): ${pct(r.winRateDecided)}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
