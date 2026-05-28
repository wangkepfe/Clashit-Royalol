// ─────────────────────────────────────────────────────────────────────────────
//  DeepSeek V4 Pro — Production tournament bot for Bot Royale
//  Strategy: Reactive Beatdown — defend with Cannon + Knight + spells,
//  counter-push with Giant + Musketeer, cycle leak-free, maximise spell value.
// ─────────────────────────────────────────────────────────────────────────────

export default function bot(view) {
  const { self, enemy, units, towers, arena, phase, elixirMult, time, crowns, tick } = view;

  // ── Direction & identity ──
  const FWD = self.id === 0 ? 1 : -1;
  const P0  = self.id === 0;
  const MID = arena.mid;                        // 16
  const W   = arena.width;                      // 18
  const H   = arena.height;                     // 32
  const [BR_L, BR_R] = arena.bridges;           // [3.5, 14.5]
  const HALF = W / 2;                           // 9

  // ── Deterministic hash for tie-breaking ──
  const hash01 = (n) => { let x = (n | 0) ^ 0x9e3779b9; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

  // ═══════════════════════════════════════════════════════════════════════════
  //  FAST QUERIES  (avoid repeated allocation via for-loops where possible)
  // ═══════════════════════════════════════════════════════════════════════════

  const enUnits  = () => { const r = []; for (let i = 0; i < units.length; i++) if (!units[i].mine) r.push(units[i]); return r; };
  const myUnits  = () => { const r = []; for (let i = 0; i < units.length; i++) if (units[i].mine)  r.push(units[i]); return r; };

  const canPlay = (card) => { for (let i = 0; i < self.hand.length; i++) if (self.hand[i].card === card) return self.elixir >= self.hand[i].cost; return false; };

  const cheapest = () => { let b = null, bc = 99; for (let i = 0; i < self.hand.length; i++) { const h = self.hand[i]; if (self.elixir >= h.cost && h.cost < bc) { b = h; bc = h.cost; } } return b; };

  const E = self.elixir;
  const atCap   = E >= self.elixirMax - 0.005;
  const nearCap = E >= 9;
  const isOT    = phase === 'overtime';
  const is2x    = elixirMult >= 2;
  const is3x    = elixirMult >= 3;

  // ═══════════════════════════════════════════════════════════════════════════
  //  GEOMETRY
  // ═══════════════════════════════════════════════════════════════════════════

  const laneX   = (l) => l === 'left' ? W * 0.25 : W * 0.75;   // 4.5 | 13.5
  const bridgeX = (l) => l === 'left' ? BR_L : BR_R;            // 3.5 | 14.5
  const ownHalfYmax = () => P0 ? MID - 0.5 : H - 0.5;          // 15.5 | 31.5
  const ownHalfYmin = () => P0 ? 0.5 : MID + 0.5;              //  0.5 | 16.5
  const ownMidY     = () => (ownHalfYmin() + ownHalfYmax()) / 2;
  const defendY     = () => P0 ? MID - 3.5 : MID + 3.5;        // behind princess
  const backY       = () => P0 ? 1.5 : H - 1.5;                // behind king
  const riverY      = () => P0 ? MID - 0.5 : MID + 0.5;        // at bridge
  const cannonY     = () => P0 ? MID - 4.5 : MID + 4.5;        // centre pull
  const fwdY        = () => P0 ? H - 6.5 : 6.5;                // forward deploy

  // ═══════════════════════════════════════════════════════════════════════════
  //  TOWER STATE
  // ═══════════════════════════════════════════════════════════════════════════

  const enPrincess = (lane) => { for (let i = 0; i < towers.length; i++) { const t = towers[i]; if (!t.mine && t.kind === 'princess' && t.side === lane) return t; } return null; };
  const myPrincess = (lane) => { for (let i = 0; i < towers.length; i++) { const t = towers[i]; if (t.mine && t.kind === 'princess' && t.side === lane) return t; } return null; };
  const enKing = () => { for (let i = 0; i < towers.length; i++) { const t = towers[i]; if (!t.mine && t.kind === 'king') return t; } return null; };
  const enPrincessDown = (lane) => { const p = enPrincess(lane); return p && !p.alive; };

  // Weakest enemy lane
  const weakLane = () => {
    const lp = enPrincess('left'), rp = enPrincess('right');
    const lHp = lp ? lp.hp : 0, rHp = rp ? rp.hp : 0;
    if (!lp || !lp.alive) return 'left';
    if (!rp || !rp.alive) return 'right';
    if (lHp !== rHp) return lHp < rHp ? 'left' : 'right';
    return (tick & 1) ? 'left' : 'right';
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  THREAT ASSESSMENT
  // ═══════════════════════════════════════════════════════════════════════════

  const enemiesOnMySide = () => {
    const r = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.mine || u.building) continue;
      if (P0 ? u.y < MID + 4 : u.y > MID - 4) r.push(u);
    }
    return r;
  };

  const laneThreat = () => {
    let L = 0, R = 0;
    const en = enemiesOnMySide();
    for (let i = 0; i < en.length; i++) { if (en[i].x < HALF) L += en[i].maxHp; else R += en[i].maxHp; }
    return { left: L, right: R };
  };

  const threatenedLane = () => { const t = laneThreat(); return (t.left === 0 && t.right === 0) ? null : (t.left >= t.right ? 'left' : 'right'); };
  const underAttack = () => { const t = laneThreat(); return t.left > 0 || t.right > 0; };

  // Enemy Giant on my side (needs Cannon response)
  const enemyGiantClose = () => {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.mine && u.card === 'Giant' && !u.building && (P0 ? u.y < MID + 4 : u.y > MID - 4)) return u;
    }
    return null;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  MY UNIT STATE
  // ═══════════════════════════════════════════════════════════════════════════

  const myGiant = () => { for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.mine && u.card === 'Giant' && !u.building && u.hp > 0) return u; } return null; };
  const myCannon = () => { for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.mine && u.building && u.hp > 0) return u; } return null; };

  // My troops on the enemy side (counter-push indicator)
  const myPushOnEnemySide = () => {
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.mine && !u.building && u.hp > 0 && (P0 ? u.y > MID - 2 : u.y < MID + 2)) return true;
    }
    return false;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  SPELL TARGETING
  // ═══════════════════════════════════════════════════════════════════════════

  const clusterAt = (cx, cy, rad) => {
    let n = 0, hp = 0;
    const r2 = rad * rad;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.mine || u.building) continue;
      const dx = u.x - cx, dy = u.y - cy;
      if (dx * dx + dy * dy <= r2) { n++; hp += u.hp; }
    }
    return { x: cx, y: cy, n, hp };
  };

  // Returns best cluster centre for a spell, requiring ≥ minN enemies
  const bestSpellTgt = (rad, minN) => {
    const en = enUnits();
    if (en.length < minN) return null;
    let best = null, bv = -1;
    for (let i = 0; i < en.length; i++) {
      const c = clusterAt(en[i].x, en[i].y, rad);
      if (c.n >= minN && c.n * 10000 + c.hp > bv) { bv = c.n * 10000 + c.hp; best = c; }
    }
    return best;
  };

  const countNear = (x, y, r) => { let n = 0; const r2 = r * r; for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.mine || u.building) continue; const dx = u.x - x, dy = u.y - y; if (dx * dx + dy * dy <= r2) n++; } return n; };

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEPLOY LEGALITY (mirrors engine checks for safety)
  // ═══════════════════════════════════════════════════════════════════════════

  const inOwnHalf = (y) => P0 ? (y >= 0.5 && y <= MID - 0.5) : (y >= MID + 0.5 && y <= H - 0.5);
  const inFwdZone = (y, lane) => enPrincessDown(lane) && (P0 ? y <= H - 6.0 : y >= 6.0);
  const inArena   = (x, y) => x >= 0.5 && x <= W - 0.5 && y >= 0.5 && y <= H - 0.5;
  const legalXY   = (x, y, lane) => inArena(x, y) && (inOwnHalf(y) || inFwdZone(y, lane));
  const legalSpell = (x, y) => x >= 0 && x <= W && y >= 0 && y <= H;

  // Cannon x positions that never overlap towers (Cannon r=1.5, princess r=1.5 → min sep=3.0; king r=2.0 → min sep=3.5)
  const cannonX = (lane) => lane === 'left' ? 6.0 : 12.0;

  const play = (card, x, y) => ({ card, x, y });

  // ═══════════════════════════════════════════════════════════════════════════
  //  OPENING  (first 10 s, no crowns lost yet — prefer cheap cycle)
  // ═══════════════════════════════════════════════════════════════════════════

  if (time < 10 && crowns.self === 0 && crowns.enemy === 0 && !underAttack()) {
    if (E < 6) return null;  // accumulate elixir to 6

    // Preferred openers: Goblins (best), Archers (safe), Knight (tanky)
    if (canPlay('Goblins'))  return play('Goblins', bridgeX(weakLane()), riverY());
    if (canPlay('Archers'))  return play('Archers', laneX(weakLane()), backY());
    if (canPlay('Knight'))   return play('Knight', bridgeX(weakLane()), riverY());
    // If none of the preferred openers are in hand, fall through to normal logic
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P1 — DEFENCE  (enemy on my side of the field)
  // ═══════════════════════════════════════════════════════════════════════════
  if (underAttack()) {
    const lane = threatenedLane();
    const t    = laneThreat();
    const lx   = laneX(lane);
    const bx   = bridgeX(lane);
    const eg   = enemyGiantClose();

    // ── Cannon is the #1 defensive card ──
    if (canPlay('Cannon') && !myCannon()) {
      if (eg || t[lane] > 600 || (is2x && t[lane] > 300)) {
        return play('Cannon', cannonX(lane), cannonY());
      }
    }

    // ── Fireball value on clumped enemies ──
    if (canPlay('Fireball')) {
      const fb = bestSpellTgt(2.5, 2);
      if (fb && legalSpell(fb.x, fb.y)) return play('Fireball', fb.x, fb.y);
      // Fireball a single high-value target: Musketeer (721 HP, Fireball does 688)
      // If it's already damaged, Fireball kills it — even trade at worst.
      const en = enUnits();
      for (let i = 0; i < en.length; i++) {
        const u = en[i];
        if ((u.card === 'Musketeer' && u.hp <= 688) || (u.card === 'Archers' && u.hp <= 688)) {
          if (legalSpell(u.x, u.y)) return play('Fireball', u.x, u.y);
        }
      }
      // Also Fireball a Cannon if it's low and there's a push
      for (let i = 0; i < en.length; i++) {
        const u = en[i];
        if (u.building && u.hp <= 688 && legalSpell(u.x, u.y)) {
          const nearCount = countNear(u.x, u.y, 2.5);
          if (nearCount >= 1) return play('Fireball', u.x, u.y);
        }
      }
    }

    // ── Arrows on Goblins / Archers ──
    if (canPlay('Arrows')) {
      const ar = bestSpellTgt(3.5, 2);
      if (ar && legalSpell(ar.x, ar.y)) return play('Arrows', ar.x, ar.y);
    }

    // ── Knight: drop behind the push to tank / kill support ──
    if (canPlay('Knight')) return play('Knight', lx, defendY());

    // ── Musketeer: high DPS from safety ──
    if (canPlay('Musketeer')) return play('Musketeer', lx, ownMidY());

    // ── Archers: cheap ranged defence ──
    if (canPlay('Archers')) return play('Archers', lx, defendY());

    // ── Goblins: emergency melee DPS ──
    if (canPlay('Goblins')) return play('Goblins', bx, P0 ? MID - 1.5 : MID + 1.5);

    // ── Giant as emergency meat-shield (only double+ elixir) ──
    if (canPlay('Giant') && is2x && t[lane] > 1500) return play('Giant', lx, defendY());

    // Low on elixir — save for a better response next tick
    if (E < 3) return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P2 — OFFENCE  (build & support Giant beatdown pushes)
  // ═══════════════════════════════════════════════════════════════════════════

  const mg  = myGiant();
  const pushActive = mg && (P0 ? mg.y > MID - 7 : mg.y < MID + 7); // Giant past own half

  // ── Start Giant push from back ──
  if (!mg && canPlay('Giant') && E >= 7) {
    return play('Giant', laneX(weakLane()), backY());
  }

  // ── Support active Giant ──
  if (pushActive) {
    const pl = mg.x < HALF ? 'left' : 'right';

    // Musketeer is the #1 support (highest DPS)
    if (canPlay('Musketeer')) {
      const y = Math.max(0.5, Math.min(H - 0.5, mg.y - FWD * 4));
      if (legalXY(laneX(pl), y, pl)) return play('Musketeer', laneX(pl), y);
    }

    // Archers behind Giant
    if (canPlay('Archers')) {
      const y = Math.max(0.5, Math.min(H - 0.5, mg.y - FWD * 3));
      if (legalXY(laneX(pl), y, pl)) return play('Archers', laneX(pl), y);
    }

    // Fireball enemy defenders in front of Giant
    if (canPlay('Fireball')) {
      const ax = mg.x, ay = mg.y + FWD * 3.5;
      if (countNear(ax, ay, 2.5) >= 2 && legalSpell(ax, ay)) return play('Fireball', ax, ay);
    }

    // Goblins for burst DPS
    if (canPlay('Goblins')) {
      const y = Math.max(0.5, Math.min(H - 0.5, mg.y - FWD * 1.5));
      if (legalXY(bridgeX(pl), y, pl)) return play('Goblins', bridgeX(pl), y);
    }

    // Knight as secondary mini-tank
    if (canPlay('Knight') && E >= 7) {
      const y = Math.max(0.5, Math.min(H - 0.5, mg.y - FWD * 2));
      if (legalXY(bridgeX(pl), y, pl)) return play('Knight', bridgeX(pl), y);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P3 — PRESSURE / CYCLE  (safe proactive plays)
  // ═══════════════════════════════════════════════════════════════════════════

  // Forward-deploy into a lane where the enemy princess is dead
  for (const lane of ['left', 'right']) {
    if (!enPrincessDown(lane)) continue;
    const fx = bridgeX(lane), fy = fwdY();
    if (canPlay('Goblins') && nearCap)               return play('Goblins', fx, fy);
    if (canPlay('Knight') && E >= 5)                 return play('Knight', fx, fy);
    if (canPlay('Musketeer') && E >= 6)              return play('Musketeer', laneX(lane), Math.max(0.5, Math.min(H - 0.5, fy - FWD * 2)));
    if (canPlay('Archers') && nearCap)               return play('Archers', laneX(lane), fy - FWD * 1.5);
  }

  // Goblins at bridge: cheap pressure, fast cycle
  if (canPlay('Goblins') && (nearCap || (E >= 6 && !mg && !underAttack()))) {
    return play('Goblins', bridgeX(weakLane()), riverY());
  }

  // Archers behind king: safe cycle, builds value over time
  if (canPlay('Archers') && nearCap && !underAttack() && !mg) {
    return play('Archers', laneX(weakLane()), backY());
  }

  // Knight at bridge: mini-tank pressure
  if (canPlay('Knight') && nearCap && !underAttack() && !mg) {
    return play('Knight', bridgeX(weakLane()), riverY());
  }

  // Musketeer investment (only when very safe)
  if (canPlay('Musketeer') && E >= 8.5 && !underAttack() && !mg) {
    return play('Musketeer', laneX(weakLane()), backY());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P4 — SPELL FINISH  (tower at lethal range)
  // ═══════════════════════════════════════════════════════════════════════════

  if (canPlay('Fireball')) {
    const fbd = view.cards.Fireball.towerDmg;  // 207
    for (const lane of ['left', 'right']) {
      const p = enPrincess(lane);
      if (p && p.alive && p.hp > 0 && p.hp <= fbd + 30) return play('Fireball', p.x, p.y);
    }
    const k = enKing();
    if (k && k.alive && k.hp > 0 && k.hp <= fbd) return play('Fireball', k.x, k.y);
    // In overtime with a crown lead, Fireball cycle the king
    if (isOT && crowns.self > crowns.enemy) {
      const k2 = enKing();
      if (k2 && k2.alive) return play('Fireball', k2.x, k2.y);
    }
  }

  if (canPlay('Arrows')) {
    const ad = view.cards.Arrows.towerDmg;  // 93
    for (const lane of ['left', 'right']) {
      const p = enPrincess(lane);
      if (p && p.alive && p.hp > 0 && p.hp <= ad + 10) return play('Arrows', p.x, p.y);
    }
    const k = enKing();
    if (k && k.alive && k.hp > 0 && k.hp <= ad) return play('Arrows', k.x, k.y);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P5 — PROACTIVE CANNON  (place before enemy pushes)
  // ═══════════════════════════════════════════════════════════════════════════
  if (canPlay('Cannon') && !myCannon() && nearCap && !underAttack() && !mg) {
    return play('Cannon', cannonX(weakLane()), cannonY());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P6 — ANTI-LEAK  (must spend NOW — elixir at cap)
  // ═══════════════════════════════════════════════════════════════════════════
  if (atCap) {
    // Spell value first — only if targets exist
    if (canPlay('Fireball')) {
      const fb = bestSpellTgt(2.5, 1);
      if (fb && legalSpell(fb.x, fb.y)) return play('Fireball', fb.x, fb.y);
    }
    if (canPlay('Arrows')) {
      const ar = bestSpellTgt(3.5, 2);
      if (ar && legalSpell(ar.x, ar.y)) return play('Arrows', ar.x, ar.y);
    }

    // Troops: cheapest first for fastest cycle
    if (canPlay('Goblins'))              return play('Goblins', bridgeX(weakLane()), riverY());
    if (canPlay('Archers'))              return play('Archers', laneX(weakLane()), backY());
    if (canPlay('Knight'))               return play('Knight', bridgeX(weakLane()), riverY());
    if (canPlay('Cannon') && !myCannon()) return play('Cannon', cannonX(weakLane()), cannonY());
    if (canPlay('Musketeer'))            return play('Musketeer', laneX(weakLane()), backY());
    if (canPlay('Giant'))                return play('Giant', laneX(weakLane()), backY());

    // Only spell-cycle towers as absolute last resort, and only in OT or with crown lead
    if (isOT || crowns.self > crowns.enemy) {
      if (canPlay('Fireball')) {
        const k = enKing(); if (k && k.alive) return play('Fireball', k.x, k.y);
        const p = enPrincess(weakLane()); if (p && p.alive) return play('Fireball', p.x, p.y);
      }
      if (canPlay('Arrows')) {
        const p = enPrincess(weakLane()); if (p && p.alive) return play('Arrows', p.x, p.y);
      }
    }
    // If nothing else: accept a tiny leak rather than waste a spell in normal time
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  P7 — NEAR-CAP SOFT FALLBACK  (spend rather than leak, but don't waste spells)
  // ═══════════════════════════════════════════════════════════════════════════
  if (nearCap) {
    const ch = cheapest();
    if (!ch) return null;
    const c = ch.card, k = ch.kind;

    // Never waste a spell just to avoid leaking — save it for value
    if (k === 'spell') {
      // Only spell at near-cap in overtime (chip tower) or if targets exist
      if (isOT && crowns.self >= crowns.enemy) {
        const tgt = enPrincess(weakLane()) || enKing();
        if (tgt && tgt.alive) return play(c, tgt.x, tgt.y);
      }
      return null; // leaking 0.5 elixir is better than wasting a Fireball
    }
    if (k === 'building' && !myCannon()) return play(c, cannonX(weakLane()), cannonY());
    // Troop at bridge
    return play(c, bridgeX(weakLane()), riverY());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEFAULT: bank elixir for a reactive counter-play
  // ═══════════════════════════════════════════════════════════════════════════
  return null;
}
