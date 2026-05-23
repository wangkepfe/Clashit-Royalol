export default function bot(view) {
    const s = view.self;
    const a = view.arena;
    const mid = a.mid;
    const id = s.id;
    const dir = id === 0 ? 1 : -1;
    
    function canPlay(card) {
        let c = s.hand.find(x => x.card === card);
        return c && s.elixir >= c.cost;
    }
    
    function clampX(x) { return Math.max(0.5, Math.min(x, a.width - 0.5)); }
    function clampY(y) {
        if (id === 0) return Math.max(0.5, Math.min(y, mid - 0.5));
        else return Math.max(mid + 0.5, Math.min(y, a.height - 0.5));
    }
    
    const eUnits = view.units.filter(u => !u.mine);
    const mUnits = view.units.filter(u => u.mine);
    const eTowers = view.towers.filter(t => !t.mine && t.alive);
    const mTowers = view.towers.filter(t => t.mine && t.alive);

    // 1. GUARANTEED LETHAL SPELL
    let lowestEnemyTower = eTowers.reduce((acc, t) => t.hp < acc.hp ? t : acc, eTowers[0]);
    if (lowestEnemyTower) {
        if (lowestEnemyTower.hp <= 207 && canPlay('Fireball')) return { card: 'Fireball', x: lowestEnemyTower.x, y: lowestEnemyTower.y };
        if (lowestEnemyTower.hp <= 93 && canPlay('Arrows')) return { card: 'Arrows', x: lowestEnemyTower.x, y: lowestEnemyTower.y };
    }

    // 2. SPELL VALUE CLUSTERING (O(N^2))
    let bestFbX = 0, bestFbY = 0, bestFbVal = 0;
    let bestArX = 0, bestArY = 0, bestArVal = 0;
    
    for (let u of eUnits) {
        let fbVal = 0, arVal = 0;
        for (let u2 of eUnits) {
            let dx = u.x - u2.x; let dy = u.y - u2.y;
            let d2 = dx*dx + dy*dy;
            if (d2 <= 2.5 * 2.5) fbVal += u2.hp;
            if (d2 <= 3.5 * 3.5) arVal += u2.hp;
        }
        for (let t of eTowers) {
            let dx = u.x - t.x; let dy = u.y - t.y;
            let d2 = dx*dx + dy*dy;
            if (d2 <= 2.5 * 2.5) fbVal += 200;
            if (d2 <= 3.5 * 3.5) arVal += 100;
        }
        if (fbVal > bestFbVal) { bestFbVal = fbVal; bestFbX = u.x; bestFbY = u.y; }
        if (arVal > bestArVal) { bestArVal = arVal; bestArX = u.x; bestArY = u.y; }
    }
    
    if (canPlay('Fireball') && bestFbVal >= 700) return { card: 'Fireball', x: bestFbX, y: bestFbY };
    if (canPlay('Arrows') && bestArVal >= 400) return { card: 'Arrows', x: bestArX, y: bestArY };

    // 3. THREAT EVALUATION AND DEFENSE
    let closestEnemy = null;
    let minDistToTower = 999;
    
    for (let u of eUnits) {
        for (let t of mTowers) {
            let d = Math.hypot(u.x - t.x, u.y - t.y);
            if (d < minDistToTower) {
                minDistToTower = d;
                closestEnemy = u;
            }
        }
    }
    
    let isThreat = false;
    if (closestEnemy && minDistToTower < 12) isThreat = true;

    if (isThreat && closestEnemy) {
        let lx = closestEnemy.x < a.width / 2 ? a.bridges[0] : a.bridges[1];
        let pullX = closestEnemy.x < a.width / 2 ? a.width/2 - 2 : a.width/2 + 2;
        let pullY = clampY(mid - dir * 4);

        if (closestEnemy.card === 'Giant' && canPlay('Cannon')) {
            return { card: 'Cannon', x: a.width/2, y: clampY(mid - dir * 4) };
        }
        if (canPlay('Knight')) return { card: 'Knight', x: pullX, y: pullY };
        if (canPlay('Goblins')) return { card: 'Goblins', x: pullX, y: pullY };
        if (canPlay('Archers')) return { card: 'Archers', x: lx, y: clampY(mid - dir * 6) };
        if (canPlay('Musketeer')) return { card: 'Musketeer', x: lx, y: clampY(mid - dir * 7) };
    }

    // 4. BEATDOWN ASSAULT / PUSH
    if (s.elixir > 8 || (!isThreat && s.elixir >= 6)) {
        let myTroopsLeft = 0, myTroopsRight = 0;
        for (let u of mUnits) {
            if (u.x < a.width/2) myTroopsLeft += u.hp;
            else myTroopsRight += u.hp;
        }
        let pushLane = myTroopsLeft > myTroopsRight ? 'left' : 'right';
        let lx = pushLane === 'left' ? a.bridges[0] : a.bridges[1];
        
        let eTower = eTowers.find(t => t.side === pushLane) || eTowers.find(t => t.side === 'center');
        if (eTower && eTower.hp < 200 && canPlay('Fireball')) return { card: 'Fireball', x: eTower.x, y: eTower.y };
        if (eTower && eTower.hp < 100 && canPlay('Arrows')) return { card: 'Arrows', x: eTower.x, y: eTower.y };
        
        if (canPlay('Giant')) {
            let support = pushLane === 'left' ? myTroopsLeft : myTroopsRight;
            // Bridge deploy if we have surviving troops supporting, otherwise base deploy
            let y = support > 300 ? clampY(mid - dir * 1) : clampY(id === 0 ? 1 : a.height - 1);
            return { card: 'Giant', x: lx, y: y };
        }
        if (canPlay('Musketeer')) return { card: 'Musketeer', x: lx, y: clampY(id === 0 ? 1 : a.height - 1) };
        if (canPlay('Archers')) return { card: 'Archers', x: lx, y: clampY(id === 0 ? 1 : a.height - 1) };
        if (canPlay('Knight')) return { card: 'Knight', x: lx, y: clampY(mid - dir * 1) };
        if (canPlay('Goblins')) return { card: 'Goblins', x: lx, y: clampY(mid - dir * 1) };
    }

    // 5. CYCLE (PREVENT ELIXIR LEAK)
    if (s.elixir >= 9.5) {
        let troops = s.hand.filter(h => h.kind === 'troop');
        if (troops.length > 0) {
            return { card: troops[0].card, x: a.bridges[0], y: clampY(id === 0 ? 1 : a.height - 1) };
        }
        let buildings = s.hand.filter(h => h.kind === 'building');
        if (buildings.length > 0) {
            return { card: buildings[0].card, x: a.width/2, y: clampY(mid - dir * 2) };
        }
        if (lowestEnemyTower) {
            let spells = s.hand.filter(h => h.kind === 'spell');
            if (spells.length > 0) {
                return { card: spells[0].card, x: lowestEnemyTower.x, y: lowestEnemyTower.y };
            }
        }
    }

    return null;
}