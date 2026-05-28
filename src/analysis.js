// Turns a finished, logged match into a summary + plain-language diagnosis of
// WHY a player lost. This is the feedback the agent reads to improve a script.
import { DECK } from './cards.js';

const r1 = (x) => Math.round(x * 10) / 10;

// Condense one finished state (must have been created with { log:true }).
export function summarize(state) {
  const res = state.result;
  const s = state.stats;
  const ev = state.events;
  const durationS = Math.max(1, Math.round(res.time));

  const firstPlay = [null, null];
  for (const e of ev) {
    if ((e.type === 'play' || e.type === 'spell') && firstPlay[e.owner] == null) {
      firstPlay[e.owner] = e.t;
    }
  }

  const perPlayer = [0, 1].map((p) => {
    const unused = DECK.filter((c) => !(s.cards[p][c] > 0));
    return {
      elixirSpent: r1(s.elixirSpent[p]),
      elixirLeaked: r1(s.elixirLeaked[p]),
      elixirPerMin: r1(s.elixirSpent[p] / (durationS / 60)),
      towerDmg: Math.round(s.towerDmg[p]),
      plays: s.plays[p],
      playsFailed: s.playsFailed[p],
      spellsCast: s.spellsCast[p],
      spellsWasted: s.spellsWasted[p],
      unitsKilled: s.unitsKilled[p],
      unitsLost: s.unitsLost[p],
      firstPlayT: firstPlay[p],
      cards: { ...s.cards[p] },
      unusedCards: unused,
      towersLost: state.towers.filter((t) => t.owner === p && !t.alive).length,
      towersTaken: state.towers.filter((t) => t.owner !== p && !t.alive).length,
    };
  });

  return {
    seed: state.seed,
    winner: res.winner,
    reason: res.reason,
    crowns: res.crowns,
    durationS,
    perPlayer,
    towerTimeline: ev
      .filter((e) => e.type === 'towerDestroyed')
      .map((e) => ({ t: e.t, lostBy: e.owner, by: e.by, kind: e.kind, side: e.side })),
  };
}

// Plain-language insights about `me` (0 or 1). Each string is an actionable lever.
export function diagnose(sum, me) {
  const opp = me === 0 ? 1 : 0;
  const a = sum.perPlayer[me];
  const b = sum.perPlayer[opp];
  const out = [];
  const won = sum.winner === me;
  const verdict =
    sum.winner === 'draw' ? 'DREW' : won ? 'WON' : 'LOST';
  out.push(`${verdict} (${sum.reason}, crowns ${sum.crowns[me]}-${sum.crowns[opp]}, ${sum.durationS}s)`);

  if (a.elixirLeaked >= 6) {
    out.push(
      `Leaked ${a.elixirLeaked} elixir sitting at cap (opp leaked ${b.elixirLeaked}). Cycle/spend sooner.`
    );
  }
  if (a.spellsCast > 0 && a.spellsWasted / a.spellsCast >= 0.4) {
    out.push(
      `${a.spellsWasted}/${a.spellsCast} spells hit nothing. Only cast spells on clustered enemies.`
    );
  }
  if (a.playsFailed >= 5) {
    out.push(`${a.playsFailed} illegal/failed play attempts — bot is emitting bad actions.`);
  }
  const spendGap = a.elixirSpent - b.elixirSpent;
  if (spendGap <= -12) {
    out.push(`Spent ${-spendGap} less elixir than opponent — too passive, not pressuring.`);
  } else if (spendGap >= 18) {
    out.push(`Spent ${spendGap} more elixir than opponent — possibly over-committing.`);
  }
  if (a.towerDmg < b.towerDmg * 0.5 && b.towerDmg > 300) {
    out.push(`Dealt only ${a.towerDmg} tower damage vs opp ${b.towerDmg} — offense too weak.`);
  }
  if (a.unusedCards.length >= 3) {
    out.push(`Never played: ${a.unusedCards.join(', ')} — deck underused.`);
  }
  // First-tower swing.
  const first = sum.towerTimeline[0];
  if (first && first.lostBy === me && !won) {
    out.push(
      `Conceded the first tower (${first.side} ${first.kind}) at ${first.t}s, then lost — defense too late or too weak on that lane.`
    );
  }
  if (a.firstPlayT != null && a.firstPlayT > 6) {
    out.push(`First card only at ${a.firstPlayT}s — slow start wastes opening elixir.`);
  }
  if (out.length === 1) out.push('No glaring inefficiency; margins are strategic, not mechanical.');
  return out;
}

export function formatGameReport(state) {
  const sum = summarize(state);
  const L = [];
  L.push(`Seed ${sum.seed} — winner: P${sum.winner} (${sum.reason})  crowns ${sum.crowns[0]}-${sum.crowns[1]}  ${sum.durationS}s`);
  L.push('');
  L.push('Tower timeline:');
  if (sum.towerTimeline.length === 0) L.push('  (no towers fell)');
  for (const t of sum.towerTimeline) {
    L.push(`  ${String(t.t).padStart(5)}s  P${t.lostBy} lost ${t.side} ${t.kind}  (to P${t.by})`);
  }
  L.push('');
  for (const p of [0, 1]) {
    const a = sum.perPlayer[p];
    L.push(`Player ${p}:`);
    L.push(`  spent ${a.elixirSpent} (${a.elixirPerMin}/min) | leaked ${a.elixirLeaked} | plays ${a.plays} (failed ${a.playsFailed})`);
    L.push(`  spells ${a.spellsCast} (wasted ${a.spellsWasted}) | kills ${a.unitsKilled} | lost ${a.unitsLost} | towerDmg ${a.towerDmg}`);
    L.push(`  cards: ${JSON.stringify(a.cards)}`);
  }
  L.push('');
  for (const p of [0, 1]) {
    L.push(`Diagnosis P${p}:`);
    for (const line of diagnose(sum, p)) L.push(`  - ${line}`);
  }
  return L.join('\n');
}

// Aggregate many game summaries from ONE bot's perspective (its player id varies
// per game because sides swap). `perspective` is an array of player ids aligned
// with `summaries`. Surfaces what correlates with losing.
export function aggregate(summaries, perspective, label) {
  const n = summaries.length;
  let wins = 0, losses = 0, draws = 0;
  const acc = { leaked: 0, leakedLoss: 0, spellWasteN: 0, spellCastN: 0, failed: 0, spent: 0, towerDmg: 0 };
  const lossReasons = {};
  const cardUse = {};
  let lossCount = 0;

  summaries.forEach((sum, i) => {
    const me = perspective[i];
    const a = sum.perPlayer[me];
    if (sum.winner === 'draw') draws++;
    else if (sum.winner === me) wins++;
    else losses++;
    acc.leaked += a.elixirLeaked;
    acc.spellWasteN += a.spellsWasted;
    acc.spellCastN += a.spellsCast;
    acc.failed += a.playsFailed;
    acc.spent += a.elixirSpent;
    acc.towerDmg += a.towerDmg;
    for (const [c, k] of Object.entries(a.cards)) cardUse[c] = (cardUse[c] || 0) + k;
    if (sum.winner !== me && sum.winner !== 'draw') {
      lossReasons[sum.reason] = (lossReasons[sum.reason] || 0) + 1;
      acc.leakedLoss += a.elixirLeaked;
      lossCount++;
    }
  });

  const avg = (x) => r1(x / n);
  return {
    label,
    games: n,
    wins,
    losses,
    draws,
    winRate: r1((wins + draws * 0.5) / n),
    avgElixirLeaked: avg(acc.leaked),
    avgElixirLeakedInLosses: lossCount ? r1(acc.leakedLoss / lossCount) : 0,
    avgElixirSpent: avg(acc.spent),
    avgTowerDmg: avg(acc.towerDmg),
    spellWastePct: acc.spellCastN ? r1((100 * acc.spellWasteN) / acc.spellCastN) : 0,
    avgFailedPlays: avg(acc.failed),
    lossReasons,
    cardUse,
  };
}

// Full chronological, human-readable trace of every card play and combat
// interaction. Requires a state created with { trace:true }. This is the
// "tracking file" content: each deploy (with spawned unit IDs) and each hit
// (attacker → victim, damage, position, hp delta, death).
const P = (o) => (o === 0 ? 'A' : o === 1 ? 'B' : '?');
const at = (e) => (e ? `(${e.x},${e.y})` : '(?)');
const ts = (t) => `${String(t.toFixed(1)).padStart(6)}s`;

export function formatTrace(state) {
  const L = [];
  L.push(`# Bot Royale trace — seed ${state.seed}`);
  L.push(`# Player A = P0, Player B = P1. Unit IDs: <Card>_<A|B>_<n>.`);
  L.push(`# result: ${state.result.winner === 'draw' ? 'DRAW' : 'P' + state.result.winner + ' wins'} (${state.result.reason}), crowns ${state.result.crowns.join('-')}, ${Math.round(state.result.time)}s`);
  L.push('');

  // Collapse runs of identical failed plays (a buggy bot can spam one per tick).
  let fail = null;
  const flushFail = () => {
    if (!fail) return;
    const span = fail.t0 === fail.t1 ? `${ts(fail.t0)} ` : `${ts(fail.t0)}…${fail.t1.toFixed(1)}s`;
    L.push(`${span}  P${fail.owner}(${P(fail.owner)}) play FAILED (${fail.reason}) ×${fail.n}`);
    fail = null;
  };

  for (const e of state.events) {
    if (e.type === 'playFailed') {
      if (fail && fail.owner === e.owner && fail.reason === e.reason) {
        fail.n++;
        fail.t1 = e.t;
      } else {
        flushFail();
        fail = { owner: e.owner, reason: e.reason, n: 1, t0: e.t, t1: e.t };
      }
      continue;
    }
    flushFail();
    const t = ts(e.t);
    if (e.type === 'play') {
      const sp = e.spawned.map((u) => `${u.name} @(${u.x},${u.y})`).join(', ');
      L.push(`${t}  P${e.owner}(${P(e.owner)}) played ${e.card} @(${e.x},${e.y}) ${e.cost}⚡  →  spawned: ${sp}`);
    } else if (e.type === 'spell') {
      L.push(`${t}  P${e.owner}(${P(e.owner)}) cast ${e.card} @(${e.x},${e.y})  (${e.hits} target${e.hits === 1 ? '' : 's'} in radius)`);
    } else if (e.type === 'damage') {
      const tail = e.killed ? `  ‹${e.dst.name} DIES — killed by ${e.src ? e.src.name : '?'}›` : '';
      L.push(
        `${t}  ${e.src ? e.src.name : '?'} ${at(e.src)} dealt ${e.dmg} dmg to ${e.dst.name} ${at(e.dst)}` +
          `  [hp ${e.hpBefore}→${e.hpAfter}]${tail}`
      );
    } else if (e.type === 'towerDestroyed') {
      L.push(`${t}  *** ${e.tower} ${at(e)} DESTROYED by ${e.byName || 'P' + e.by} ***`);
    } else if (e.type === 'buildingDestroyed') {
      L.push(`${t}  ## ${e.name} ${at(e)} DESTROYED by ${e.byName || 'P' + e.by} ##`);
    } else if (e.type === 'buildingExpired') {
      L.push(`${t}  ## ${e.name} ${at(e)} expired (lifetime ended) ##`);
    } else if (e.type === 'kingActivated') {
      L.push(`${t}  ${e.tower} ACTIVATED (${e.cause})`);
    } else if (e.type === 'end') {
      L.push(`${t}  ===== ${e.winner === 'draw' ? 'DRAW' : 'P' + e.winner + ' WINS'} (${e.reason}) =====`);
    }
  }
  flushFail();
  return L.join('\n');
}
