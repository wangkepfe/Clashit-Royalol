// Detailed match TRACE → tracking file.
//
//   node tools/trace.js <botA> <botB> [seed=1]
//
// Runs ONE fully-instrumented game (botA = P0, botB = P1) and writes:
//   traces/<A>-vs-<B>-seed<seed>.txt    human-readable: every card play (with
//                                       spawned unit IDs) and every combat hit
//                                       (attacker → victim, dmg, tile, hp, death)
//   traces/<A>-vs-<B>-seed<seed>.jsonl  one JSON event per line (programmatic)
//
// Unit IDs are stable & readable: <Card>_<A|B>_<n>  (A = P0, B = P1).

import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { runHeadless } from '../src/match.js';
import { formatTrace } from '../src/analysis.js';

const here = dirname(fileURLToPath(import.meta.url));

async function loadBot(name) {
  const mod = await import(pathToFileURL(resolve(here, '..', 'bots', `${name}.js`)).href);
  if (typeof mod.default !== 'function') throw new Error(`bot "${name}" has no default function`);
  return mod.default;
}

async function main() {
  const [, , aName, bName, seedArg] = process.argv;
  if (!aName || !bName) {
    console.error('usage: node tools/trace.js <botA> <botB> [seed=1]');
    process.exit(1);
  }
  const seed = Number(seedArg) || 1;
  const [botA, botB] = await Promise.all([loadBot(aName), loadBot(bName)]);

  const state = runHeadless(botA, botB, seed, { trace: true });

  const dir = resolve(here, '..', 'traces');
  mkdirSync(dir, { recursive: true });
  const stem = resolve(dir, `${aName}-vs-${bName}-seed${seed}`);
  const txt = `${stem}.txt`;
  const jsonl = `${stem}.jsonl`;

  writeFileSync(txt, formatTrace(state) + '\n');
  writeFileSync(jsonl, state.events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const counts = {};
  for (const e of state.events) counts[e.type] = (counts[e.type] || 0) + 1;
  const kb = (p) => (statSync(p).size / 1024).toFixed(1) + ' KB';

  console.log(`\n  ${aName} (P0/A)  vs  ${bName} (P1/B)   seed ${seed}`);
  console.log(`  result: ${state.result.winner === 'draw' ? 'DRAW' : 'P' + state.result.winner + ' wins'} ` +
    `(${state.result.reason}), crowns ${state.result.crowns.join('-')}, ${Math.round(state.result.time)}s`);
  console.log(`  events: ${state.events.length}  ${JSON.stringify(counts)}`);
  console.log(`  wrote ${txt}  (${kb(txt)})`);
  console.log(`  wrote ${jsonl}  (${kb(jsonl)})`);

  console.log('\n  ── first 24 trace lines ──');
  console.log(formatTrace(state).split('\n').slice(0, 24).map((l) => '  ' + l).join('\n'));
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
