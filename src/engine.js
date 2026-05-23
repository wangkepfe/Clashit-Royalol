import { DT } from './config.js';
import { CARDS, deployCard, applySpell } from './cards.js';
import { crownsFor } from './state.js';

// ───────────────────────── helpers ─────────────────────────

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Reach radius used when deciding if an attack connects. For units this MUST
// match bodyRadius() — the collision resolver pushes overlapping bodies apart
// to exactly `bodyRadius(a) + bodyRadius(b)` center-to-center, so if attack
// reach used a smaller target radius the attacker would be permanently shoved
// outside its own hit distance. Goblins (range 0.5, radius 0.5) hit a Knight
// (radius 0.5) at center distance 1.0, which equals their collision sep —
// any smaller target radius and they could never land a swing on another
// ground troop (no rising cooldown edge → no attack animation either).
function entityRadius(e) {
  if (e._tower) return 1.4;
  if (e._building) return (e.def && e.def.radius) || 0.6;
  return (e.def && e.def.radius) || 0.4;
}

// Physical body radius for unit-vs-unit push-out (real CR CollisionRadius).
function bodyRadius(u) {
  return (u.def && u.def.radius) || 0.4;
}

function findEntity(state, id) {
  if (id == null) return null;
  for (const u of state.units) if (u.id === id && u.hp > 0) return u;
  for (const t of state.towers) if (t.id === id && t.alive) return t;
  return null;
}

// Spawn an in-flight projectile. `target` (homing) for arrows/bullets/tower
// shots; spells pass target=null and a fixed (tx,ty) aim point.
function spawnProjectile(state, p) {
  state.projectiles.push({
    id: state.nextId++,
    owner: p.owner,
    kind: p.kind, // 'bolt' (homing damage) | 'spell' (fixed-point AoE)
    x: p.x,
    y: p.y,
    speed: p.speed,
    targetId: p.targetId != null ? p.targetId : null,
    tx: p.tx,
    ty: p.ty,
    dmg: p.dmg || 0,
    card: p.card || null,
    src: p.src, // snapshot used for damage attribution + trace
    logEv: p.logEv || null,
  });
}

function logEvent(state, ev) {
  if (state.logEnabled) {
    ev.tick = state.tick;
    ev.t = Math.round(state.time * 10) / 10;
    state.events.push(ev);
  }
}

// Can `def` (an attacker's card def) damage entity `e`?
function canHit(def, e) {
  // Towers and defensive buildings count as "buildings": every ground/air
  // attacker can damage them, and the Giant (buildingsOnly) targets them.
  if (e._tower || e._building) return true;
  if (def.buildingsOnly) return false; // Giant ignores troops
  return e.flying ? def.targetsAir : def.targetsGround;
}

const r1 = (n) => Math.round(n * 10) / 10;

// Compact descriptor of an entity (unit / tower / spell source) for the trace.
function ref(e) {
  if (!e) return null;
  return {
    id: e.id != null ? e.id : null,
    name: e.name || e.card || e.kind || '?',
    owner: e.owner,
    kind: e._tower ? 'tower' : e._building ? 'building' : e._spell ? 'spell' : 'unit',
    x: r1(e.x),
    y: r1(e.y),
  };
}

// `source` is the attacker: a unit, a tower, or a spell descriptor
// ({ _spell, owner, card, name, x, y }). May be null for unattributed damage.
function applyDamage(state, e, dmg, source) {
  const attackerOwner = source && source.owner != null ? source.owner : null;
  const hpBefore = e.hp;
  e.hp -= dmg;
  const lethal = hpBefore > 0 && e.hp <= 0;

  if (state.logEnabled && attackerOwner != null) {
    if (e._tower) {
      state.stats.towerDmg[attackerOwner] += Math.min(dmg, Math.max(0, hpBefore));
    } else if (lethal) {
      state.stats.unitsKilled[attackerOwner] += 1;
      state.stats.unitsLost[e.owner] += 1;
    }
  }

  // Verbose per-hit trace: who hit whom, for how much, where, with hp delta.
  if (state.traceEnabled) {
    logEvent(state, {
      type: 'damage',
      src: ref(source),
      dst: ref(e),
      dmg,
      hpBefore: Math.round(hpBefore),
      hpAfter: Math.max(0, Math.round(e.hp)),
      killed: lethal,
    });
  }

  if (e._tower) {
    if (e.kind === 'king' && !e.activated) {
      e.activated = true;
      logEvent(state, { type: 'kingActivated', owner: e.owner, tower: e.name, cause: 'damage' });
    }
    if (e.hp <= 0 && e.alive) {
      e.hp = 0;
      e.alive = false;
      if (e.kind === 'princess') {
        const king = state.towers.find((t) => t.owner === e.owner && t.kind === 'king');
        if (king && !king.activated) {
          king.activated = true;
          logEvent(state, { type: 'kingActivated', owner: e.owner, tower: king.name, cause: 'princessLost' });
        }
      }
      logEvent(state, {
        type: 'towerDestroyed',
        owner: e.owner,
        by: attackerOwner,
        tower: e.name,
        byName: source ? source.name : null,
        kind: e.kind,
        side: e.side,
        x: r1(e.x),
        y: r1(e.y),
      });
      state.effects.push({ kind: 'towerDown', x: e.x, y: e.y, ttl: 0.5 });
    }
  } else if (lethal) {
    if (e._building) {
      // Buildings get a dedicated event so the feed can show "Cannon ✖" the
      // same way a tower destruction is shown. Always logged (not gated on
      // traceEnabled) so the event feed picks it up.
      logEvent(state, {
        type: 'buildingDestroyed',
        owner: e.owner,
        by: attackerOwner,
        card: e.card,
        name: e.name,
        byName: source ? source.name : null,
        x: r1(e.x),
        y: r1(e.y),
        cause: 'damage',
      });
      state.effects.push({ kind: 'towerDown', x: e.x, y: e.y, ttl: 0.5 });
    } else {
      // Unit death cue for the audio layer — pushed for *every* unit kill,
      // independent of trace logging. The renderer ignores 'death' effects;
      // they exist purely so SFX can play a per-card scream / grunt / squeak.
      state.effects.push({
        kind: 'death',
        card: e.card,
        owner: e.owner,
        x: e.x,
        y: e.y,
        ttl: 0.1,
      });
    }
    if (state.traceEnabled) {
      logEvent(state, { type: 'death', unit: ref(e), by: ref(source) });
    }
  }
}

// ───────────────────────── deploy validation ─────────────────────────

function legalTroopZone(state, owner, x, y) {
  const A = state.config.arena;
  if (x < 0.5 || x > A.width - 0.5 || y < 0.5 || y > A.height - 0.5) return false;

  if (owner === 0) {
    if (y <= A.mid - 0.5) return true; // own half
    // Forward deploy if the enemy princess in this lane is down.
    const side = x < A.width / 2 ? 'left' : 'right';
    const enemyPrincess = state.towers.find(
      (t) => t.owner === 1 && t.kind === 'princess' && t.side === side
    );
    if (enemyPrincess && !enemyPrincess.alive) return y <= A.height - 6.0;
    return false;
  } else {
    if (y >= A.mid + 0.5) return true;
    const side = x < A.width / 2 ? 'left' : 'right';
    const enemyPrincess = state.towers.find(
      (t) => t.owner === 0 && t.kind === 'princess' && t.side === side
    );
    if (enemyPrincess && !enemyPrincess.alive) return y >= 6.0;
    return false;
  }
}

function failPlay(state, owner, reason) {
  if (state.logEnabled) {
    state.stats.playsFailed[owner] += 1;
    logEvent(state, { type: 'playFailed', owner, reason });
  }
}

function tryDeploy(state, owner, action) {
  if (action == null) return; // doing nothing is not a failure
  if (typeof action !== 'object') return failPlay(state, owner, 'badAction');
  const player = state.players[owner];

  let idx = -1;
  if (Number.isInteger(action.handIndex)) idx = action.handIndex;
  else if (typeof action.card === 'string') idx = player.hand.indexOf(action.card);
  if (idx < 0 || idx > 3) return failPlay(state, owner, 'notInHand');

  const cardName = player.hand[idx];
  const def = CARDS[cardName];
  if (!def) return failPlay(state, owner, 'unknownCard');

  const x = action.x, y = action.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return failPlay(state, owner, 'badCoords');
  if (player.elixir < def.cost) return failPlay(state, owner, 'notEnoughElixir');

  if (def.kind === 'spell') {
    const A = state.config.arena;
    if (x < 0 || x > A.width || y < 0 || y > A.height) return failPlay(state, owner, 'offArena');
  } else if (!legalTroopZone(state, owner, x, y)) {
    return failPlay(state, owner, 'illegalZone');
  }

  // Buildings cannot be placed overlapping a crown tower or an existing building.
  if (def.kind === 'building') {
    const br = def.radius || 1.5;
    const fp = state.config.towerFootprint;
    for (const t of state.towers) {
      if (!t.alive) continue;
      const tr = t.kind === 'king' ? fp.king : fp.princess;
      const dx = x - t.x, dy = y - t.y;
      if (dx * dx + dy * dy < (br + tr) * (br + tr)) return failPlay(state, owner, 'blockedByTower');
    }
    for (const u of state.units) {
      if (!u._building || u.hp <= 0) continue;
      const ur = (u.def && u.def.radius) || 1.5;
      const dx = x - u.x, dy = y - u.y;
      if (dx * dx + dy * dy < (br + ur) * (br + ur)) return failPlay(state, owner, 'blockedByBuilding');
    }
  }

  // Commit: pay, cycle the card.
  player.elixir -= def.cost;
  player.hand[idx] = player.cycle.shift();
  player.cycle.push(cardName);

  if (state.logEnabled) {
    state.stats.elixirSpent[owner] += def.cost;
    state.stats.plays[owner] += 1;
    state.stats.cards[owner][cardName] = (state.stats.cards[owner][cardName] || 0) + 1;
  }

  if (def.kind === 'spell') {
    // Spell launches from the caster's King tower and lands at the aim point
    // after a FIXED delay (real CR behavior: ~1.0 s cast-to-land regardless of
    // distance). We normalize the projectile's speed at cast so travel time =
    // SPELL_DELAY exactly — this keeps the existing King-origin visual but
    // makes far spells viable instead of taking 2-3 s to arrive.
    let logEv = null;
    if (state.logEnabled) {
      state.stats.spellsCast[owner] += 1;
      // Logged at cast (keeps first-play timing + viewer marker correct);
      // `hits` is filled in when the spell actually lands.
      logEv = { type: 'spell', owner, card: cardName, x: r1(x), y: r1(y), hits: 0 };
      logEvent(state, logEv);
    }
    const king = state.towers.find((t) => t.owner === owner && t.kind === 'king');
    const startX = king ? king.x : x;
    const startY = king ? king.y : y;
    const flightDist = Math.hypot(x - startX, y - startY);
    const normSpeed = flightDist > 0.01
      ? flightDist / state.config.spellCastDelay
      : def.projectileSpeed;
    spawnProjectile(state, {
      owner,
      kind: 'spell',
      x: startX,
      y: startY,
      speed: normSpeed,
      tx: x,
      ty: y,
      card: cardName,
      logEv,
    });
  } else {
    const before = state.units.length;
    deployCard(state, owner, cardName, x, y, applyDamage);
    if (state.logEnabled) {
      const spawned = state.units.slice(before).map((u) => ({
        id: u.id,
        name: u.name,
        x: r1(u.x),
        y: r1(u.y),
      }));
      logEvent(state, {
        type: 'play',
        owner,
        card: cardName,
        x: r1(x),
        y: r1(y),
        cost: def.cost,
        spawned,
      });
    }
  }
}

// ───────────────────────── unit AI ─────────────────────────

function enemyEntities(state, owner) {
  const out = [];
  for (const u of state.units) if (u.owner !== owner && u.hp > 0) out.push(u);
  for (const t of state.towers) if (t.owner !== owner && t.alive) out.push(t);
  return out;
}

// Real-CR target lock: once a unit aggros (an enemy enters its sight), the
// target STICKS until it dies, becomes uncannot-hit, or leaves the leash
// (sight range). A newly-spawned closer enemy will NOT pull the unit off its
// current aggro target — this is what makes early defensive-building placement
// matter (drop the Cannon BEFORE the Giant aggros the tower). Fallback "walk
// toward nearest tower" is NOT locked: units that haven't aggro'd anything yet
// keep scanning every tick, so a Cannon dropped while the Giant is still mid-
// walk *will* pull it.
function pickGoal(state, u) {
  // Aggro-locked: keep current target while it's still valid.
  if (u._aggroLocked && u.targetId != null) {
    const cur = findEntity(state, u.targetId);
    if (cur && cur.owner !== u.owner && canHit(u.def, cur) && dist(u, cur) <= u.def.sight) {
      // Tiny float-precision slack: collision resolution pushes overlapping
      // bodies to *exactly* minD apart, and sqrt() can come back with a 1e-12
      // error either side. Without the slack a melee attacker whose reach
      // equals the body-collision distance (e.g. Goblin range 0.5 + Knight
      // radius 0.5 = 1.0 = body sum) would flicker in and out of attack range
      // and rarely actually swing.
      const reach = u.def.range + entityRadius(cur) + 1e-4;
      return { goal: cur, attack: dist(u, cur) <= reach };
    }
    u._aggroLocked = false; // lock broken; fall through to re-acquire
  }

  // Re-acquire: scan for nearest hittable enemy in sight. If found, LOCK.
  const enemies = enemyEntities(state, u.owner);
  let best = null;
  let bestD = u.def.sight;
  for (const e of enemies) {
    if (!canHit(u.def, e)) continue;
    const d = dist(u, e);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best) {
    u._aggroLocked = true;
    return { goal: best, attack: true };
  }

  // Nothing in sight: march to the nearest enemy tower (NOT locked — keep
  // scanning each tick so a Cannon dropped in front pulls the unit).
  u._aggroLocked = false;
  let tower = null;
  let td = Infinity;
  for (const t of state.towers) {
    if (t.owner === u.owner || !t.alive) continue;
    const d = dist(u, t);
    if (d < td) {
      td = d;
      tower = t;
    }
  }
  return { goal: tower, attack: false };
}

// Slide a candidate step (nx,ny) tangentially around a single circular
// obstacle at (ox,oy) with combined radius `minD` (obstacle footprint + unit
// body). When the step would enter the circle we walk *along* the border
// toward whichever side makes progress to the goal (a pure radial push-out
// would pin a unit whose goal is straight behind the obstacle). The re-
// projected step keeps the same magnitude as the original linear step, so
// the unit slides past at full speed instead of stalling against the edge.
function slideAroundCircle(u, nx, ny, goal, ox, oy, minD) {
  const ddx = nx - ox, ddy = ny - oy;
  if (ddx * ddx + ddy * ddy >= minD * minD) return [nx, ny]; // step stays clear

  // Radius vector from the obstacle to the unit's current position (stable
  // even when the *intended* point is dead-centre behind the obstacle).
  let rx = u.x - ox, ry = u.y - oy;
  let rd = Math.hypot(rx, ry);
  if (rd < 1e-4) {
    rx = ddx; ry = ddy; rd = Math.hypot(rx, ry) || 1;
  }
  const mv = Math.hypot(nx - u.x, ny - u.y); // intended travel this tick

  // Tangent along the circle; pick the direction that heads toward the goal.
  let tnx = -ry / rd, tny = rx / rd;
  if (tnx * (goal.x - u.x) + tny * (goal.y - u.y) < 0) {
    tnx = -tnx; tny = -tny;
  }

  // Walk along the border: boundary point next to the unit, advance by the
  // tangent, then re-project so the path hugs the footprint edge.
  let bx = ox + (rx / rd) * minD + tnx * mv;
  let by = oy + (ry / rd) * minD + tny * mv;
  const bd = Math.hypot(bx - ox, by - oy) || 1;
  return [ox + ((bx - ox) / bd) * minD, oy + ((by - oy) / bd) * minD];
}

// Steer the unit around solid obstacles: crown towers AND defensive buildings
// (Cannon etc.). All obstacles share the circular-footprint model so the unit
// slides tangentially at full speed instead of getting jammed against a flat
// edge. The unit's own aggro target is excluded so it can still close into
// attack range.
function avoidObstacles(state, u, nx, ny, goal) {
  const fp = state.config.towerFootprint;
  const ur = bodyRadius(u);

  for (const t of state.towers) {
    if (!t.alive) continue;
    if (goal && goal._tower && goal.id === t.id) continue;
    const r = (t.kind === 'king' ? fp.king : fp.princess) + ur;
    [nx, ny] = slideAroundCircle(u, nx, ny, goal, t.x, t.y, r);
  }
  for (const b of state.units) {
    if (!b._building || b.hp <= 0 || b.id === u.id) continue;
    if (goal && goal.id === b.id) continue;
    const r = ((b.def && b.def.radius) || 0.6) + ur;
    [nx, ny] = slideAroundCircle(u, nx, ny, goal, b.x, b.y, r);
  }
  return [nx, ny];
}

function moveToward(state, u, goal) {
  const A = state.config.arena;
  const gx = goal.x, gy = goal.y;
  let tx = gx, ty = gy;

  // Ground units must use a bridge to cross the river. Steer along the
  // bridge x while still aiming at the goal's y, so the unit always keeps a
  // strong forward pull (advancing diagonally into the lane). Aiming at the
  // river mid-line instead would zero out forward progress right at the
  // water; keeping y = goal carries the unit across and out the far side.
  const crossing = !u.flying && (u.y - A.mid) * (gy - A.mid) < 0;
  if (crossing) {
    let bridgeX = A.bridges[0];
    if (Math.abs(u.x - A.bridges[1]) < Math.abs(u.x - A.bridges[0])) bridgeX = A.bridges[1];
    tx = bridgeX;
    ty = gy;
  }

  let dx = tx - u.x, dy = ty - u.y;
  const len = Math.hypot(dx, dy) || 1;
  const step = u.def.speed * DT;
  let nx = u.x + (dx / len) * step;
  let ny = u.y + (dy / len) * step;

  // River bank slide: ground units cannot enter the water except across a
  // bridge. The naive fix (clamp ny to the bank) throws away most of the
  // step's energy — a diagonal walker hitting the bank loses its big dy and
  // crawls toward the bridge using only the small dx component. Instead, the
  // blocked vertical motion is *redirected* into horizontal motion toward
  // the nearest bridge, so the unit slides along the bank at full walking
  // speed and naturally walks onto the bridge.
  if (!u.flying && ny > A.river[0] && ny < A.river[1]) {
    let nearBridge = false;
    let bestBx = A.bridges[0], bestBd = Infinity;
    for (const bx of A.bridges) {
      const d = Math.abs(nx - bx);
      if (d <= A.bridgeHalfWidth) nearBridge = true;
      if (d < bestBd) { bestBd = d; bestBx = bx; }
    }
    if (!nearBridge) {
      if (u.y > A.river[0] && u.y < A.river[1]) {
        // Already mid-bridge but knocked off horizontally (e.g. push from a
        // nearby unit). Pull x back onto the bridge so the crossing continues
        // — never teleport y back to a bank, that would undo crossing
        // progress already made.
        nx = bestBx;
      } else {
        // Approaching the river from a bank. Snap ny to the bank we came from
        // and convert the lost vertical step into a same-magnitude horizontal
        // step toward the nearest bridge (preserving total step length so
        // walking speed is unchanged).
        const bankY = u.y <= A.river[0] ? A.river[0] : A.river[1];
        const dyConsumed = bankY - u.y;
        const remaining = Math.sqrt(Math.max(0, step * step - dyConsumed * dyConsumed));
        ny = bankY;
        const dir = bestBx > u.x ? 1 : -1;
        let cand = u.x + dir * remaining;
        if ((dir > 0 && cand > bestBx) || (dir < 0 && cand < bestBx)) cand = bestBx;
        nx = cand;
      }
    }
  }

  [nx, ny] = avoidObstacles(state, u, nx, ny, goal);

  u.x = Math.max(0.3, Math.min(A.width - 0.3, nx));
  u.y = Math.max(0.3, Math.min(A.height - 0.3, ny));
}

function updateUnits(state) {
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.cooldown > 0) u.cooldown -= DT;

    if (u.deployTimer > 0) {
      u.deployTimer -= DT;
      u.targetId = null;
      continue; // frozen while deploying
    }

    // Buildings: tick lifetime — real CR self-destructs the entity after
    // `lifetime` seconds even at full HP. Despawn cleanly (no damage source,
    // log a dedicated "buildingExpired" event for the feed/trace).
    if (u._building) {
      u.lifetime -= DT;
      if (u.lifetime <= 0) {
        u.hp = 0;
        logEvent(state, {
          type: 'buildingExpired',
          owner: u.owner,
          card: u.card,
          name: u.name,
          x: r1(u.x),
          y: r1(u.y),
        });
        state.effects.push({ kind: 'towerDown', x: u.x, y: u.y, ttl: 0.5 });
        continue;
      }
    }

    const { goal, attack } = pickGoal(state, u);
    if (!goal) continue;
    // Buildings only carry a target id when they actually have something
    // they can shoot (attack=true). Otherwise leave targetId null so the
    // sprite barrel stays in its idle forward-facing pose instead of
    // pivoting across the map toward an out-of-range crown tower.
    if (u._building && !attack) {
      u.targetId = null;
      continue;
    }
    u.targetId = goal.id;

    // Same 1e-4 slack as pickGoal — see comment there. Without it, a Goblin
    // that has just been pushed to the body-collision boundary by the
    // resolver computes dist == reach in math but dist slightly > reach in
    // float, and silently never swings.
    const reach = u.def.range + entityRadius(goal) + 1e-4;
    if (attack && dist(u, goal) <= reach) {
      if (u.cooldown <= 0) {
        u.cooldown = u.def.hitSpeed;
        if (u.def.projectileSpeed) {
          // Ranged: launch a homing projectile; damage lands on arrival.
          spawnProjectile(state, {
            owner: u.owner,
            kind: 'bolt',
            x: u.x,
            y: u.y,
            speed: u.def.projectileSpeed,
            targetId: goal.id,
            dmg: u.def.dmg,
            src: { id: u.id, owner: u.owner, name: u.name, card: u.card, x: u.x, y: u.y },
          });
          // Audio-facing launch cue: lets the SFX layer play a bow twang,
          // gun crack, or mortar boom AT the firing unit, independently of
          // the eventual impact (which may land seconds later or fizzle).
          state.effects.push({
            kind: 'launch',
            card: u.card,
            owner: u.owner,
            x: u.x,
            y: u.y,
            ttl: 0.08,
          });
        } else {
          // Melee: instant damage on contact.
          applyDamage(state, goal, u.def.dmg, u);
          state.effects.push({
            kind: 'hit',
            x: goal.x,
            y: goal.y,
            fromX: u.x,
            fromY: u.y,
            owner: u.owner,
            ranged: false,
            attackerCard: u.card,
            ttl: 0.12,
          });
        }
      }
    } else if (!u._building) {
      // Buildings are stationary — they only attack what wanders into range.
      moveToward(state, u, goal);
    }
  }
}

function updateTowers(state) {
  for (const t of state.towers) {
    if (!t.alive || !t.activated) continue;
    if (t.cooldown > 0) t.cooldown -= DT;

    let best = null;
    let bestD = t.range;
    for (const u of state.units) {
      if (u.owner === t.owner || u.hp <= 0 || u.deployTimer > 0) continue;
      const d = dist(t, u);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    if (best && t.cooldown <= 0) {
      t.cooldown = t.hitSpeed;
      spawnProjectile(state, {
        owner: t.owner,
        kind: 'bolt',
        x: t.x,
        y: t.y,
        speed: state.config.towerProjectileSpeed,
        targetId: best.id,
        dmg: t.dmg,
        src: { id: t.id, owner: t.owner, name: t.name, kind: t.kind, x: t.x, y: t.y, _tower: true },
      });
      // Audio-facing launch cue at the tower's position. card='Tower' lets
      // the SFX layer pick a bow-twang voice instead of a unit's launch.
      state.effects.push({
        kind: 'launch',
        card: 'Tower',
        towerKind: t.kind,
        owner: t.owner,
        x: t.x,
        y: t.y,
        ttl: 0.08,
      });
    }
  }
}

// ───────────────────────── projectiles ─────────────────────────

function updateProjectiles(state) {
  if (!state.projectiles.length) return;
  for (const p of state.projectiles) {
    let aimX, aimY, tgt = null;
    if (p.kind === 'bolt') {
      tgt = findEntity(state, p.targetId);
      if (!tgt) {
        p.dead = true; // homing target died/vanished mid-flight -> fizzle
        continue;
      }
      aimX = tgt.x;
      aimY = tgt.y;
    } else {
      aimX = p.tx; // spell: fixed aim point
      aimY = p.ty;
    }

    const dx = aimX - p.x, dy = aimY - p.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * DT;

    if (d <= step || d < 1e-4) {
      if (p.kind === 'bolt') {
        applyDamage(state, tgt, p.dmg, p.src);
        state.effects.push({
          kind: 'hit',
          x: tgt.x,
          y: tgt.y,
          owner: p.owner,
          ranged: true,
          attackerCard: (p.src && p.src.card) || (p.src && p.src._tower ? 'Tower' : null),
          ttl: 0.12,
        });
      } else {
        const hits = applySpell(state, p.owner, p.card, p.tx, p.ty, applyDamage);
        if (state.logEnabled) {
          if (p.logEv) p.logEv.hits = hits;
          if (hits === 0) state.stats.spellsWasted[p.owner] += 1;
        }
      }
      p.dead = true;
    } else {
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
    }
  }
  if (state.projectiles.some((p) => p.dead)) {
    state.projectiles = state.projectiles.filter((p) => !p.dead);
  }
}

// Units have a physical body and cannot overlap: push pairs apart, heavier
// units yielding less (real CR Mass). Air and ground are independent layers.
function resolveUnitCollisions(state) {
  const us = state.units;
  const A = state.config.arena;
  for (let i = 0; i < us.length; i++) {
    const a = us[i];
    if (a.hp <= 0) continue;
    const ra = bodyRadius(a);
    const ma = (a.def && a.def.mass) || 1;
    for (let j = i + 1; j < us.length; j++) {
      const b = us[j];
      if (b.hp <= 0 || a.flying !== b.flying) continue;
      const minD = ra + bodyRadius(b);
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      if (d >= minD) continue;
      if (d < 1e-4) {
        dx = a.id <= b.id ? -1 : 1; // deterministic split when coincident
        dy = 0;
        d = 1;
      }
      const pen = minD - d;
      const mb = (b.def && b.def.mass) || 1;
      const ux = dx / d, uy = dy / d;
      // Real CR Mass values, but weighted by mass^3 so a large mass gap makes
      // the heavier unit effectively immovable (a Giant is not slowed by a
      // swarm of Goblins), while comparable masses still separate smoothly.
      const wa = ma * ma * ma, wb = mb * mb * mb;
      const aShare = pen * (wb / (wa + wb));
      const bShare = pen * (wa / (wa + wb));
      a.x -= ux * aShare;
      a.y -= uy * aShare;
      b.x += ux * bShare;
      b.y += uy * bShare;
    }
  }
  // Re-clamp to the arena and keep ground units out of the river off-bridge.
  // If a push has nudged a mid-crossing unit sideways off the bridge, snap
  // its x back onto the nearest bridge rather than its y to a bank — the
  // latter would cancel the crossing progress already made.
  for (const u of us) {
    if (u.hp <= 0) continue;
    u.x = Math.max(0.3, Math.min(A.width - 0.3, u.x));
    u.y = Math.max(0.3, Math.min(A.height - 0.3, u.y));
    if (!u.flying && u.y > A.river[0] && u.y < A.river[1]) {
      let nearBridge = false;
      let bestBx = A.bridges[0], bestBd = Infinity;
      for (const bx of A.bridges) {
        const d = Math.abs(u.x - bx);
        if (d <= A.bridgeHalfWidth) nearBridge = true;
        if (d < bestBd) { bestBd = d; bestBx = bx; }
      }
      if (!nearBridge) u.x = bestBx;
    }
  }
}

// ───────────────────────── win conditions ─────────────────────────

// There are no draws: a tied game is decided by total remaining tower HP
// (the player with the least tower HP loses). An exact HP tie — vanishingly
// rare with float HP — falls back to the seeded RNG so the outcome stays
// deterministic and reproducible.
export function decideByTowerHp(state) {
  let h0 = 0, h1 = 0;
  for (const t of state.towers) {
    if (!t.alive) continue;
    if (t.owner === 0) h0 += t.hp;
    else h1 += t.hp;
  }
  if (h0 !== h1) return h0 > h1 ? 0 : 1;
  return state.rng() < 0.5 ? 0 : 1;
}

function finish(state, winner, reason) {
  state.ended = true;
  state.phase = 'ended';
  state.winner = winner;
  state.result = {
    winner,
    crowns: [crownsFor(state, 0), crownsFor(state, 1)],
    reason,
    ticks: state.tick,
    time: state.time,
  };
  logEvent(state, { type: 'end', winner, reason, crowns: state.result.crowns });
}

function checkEnd(state) {
  // Instant win: enemy king destroyed.
  for (const t of state.towers) {
    if (t.kind === 'king' && !t.alive) {
      finish(state, t.owner === 0 ? 1 : 0, 'king');
      return;
    }
  }

  const c0 = crownsFor(state, 0);
  const c1 = crownsFor(state, 1);

  if (state.phase === 'normal' && state.time >= state.config.regulationTime) {
    if (c0 !== c1) {
      finish(state, c0 > c1 ? 0 : 1, 'crowns');
    } else {
      state.phase = 'overtime';
      state.overtimeEnd = state.time + state.config.overtimeTime;
    }
    return;
  }

  if (state.phase === 'overtime') {
    if (c0 !== c1) finish(state, c0 > c1 ? 0 : 1, 'suddenDeath');
    else if (state.time >= state.overtimeEnd) finish(state, decideByTowerHp(state), 'towerHp');
  }
}

// ───────────────────────── the tick ─────────────────────────

export function step(state, actions) {
  if (state.ended) return;

  // Elixir rate: 1× normally, 2× in the last `doubleElixirWindow` s of
  // regulation, 3× throughout overtime (real Clash Royale schedule).
  const cfg = state.config;
  let eTime, mult;
  if (state.phase === 'overtime') {
    eTime = cfg.elixirTimeTriple;
    mult = 3;
  } else if (state.time >= cfg.regulationTime - cfg.doubleElixirWindow) {
    eTime = cfg.elixirTimeDouble;
    mult = 2;
  } else {
    eTime = cfg.elixirTimeNormal;
    mult = 1;
  }
  state.elixirMult = mult;
  const max = cfg.maxElixir;
  for (let i = 0; i < 2; i++) {
    const p = state.players[i];
    const raw = p.elixir + DT / eTime;
    if (state.logEnabled && raw > max) state.stats.elixirLeaked[i] += raw - max;
    p.elixir = Math.min(max, raw);
  }

  tryDeploy(state, 0, actions && actions[0]);
  tryDeploy(state, 1, actions && actions[1]);

  updateUnits(state);
  updateTowers(state);
  updateProjectiles(state);
  resolveUnitCollisions(state);

  // Sweep dead units.
  if (state.units.some((u) => u.hp <= 0)) {
    state.units = state.units.filter((u) => u.hp > 0);
  }

  // Decay transient visual effects.
  if (state.effects.length) {
    for (const e of state.effects) e.ttl -= DT;
    state.effects = state.effects.filter((e) => e.ttl > 0);
  }

  state.time += DT;
  state.tick += 1;
  checkEnd(state);
}
