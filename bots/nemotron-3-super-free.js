import { myUnits, enemyUnits, myTowers, enemyTowers, forward, inHand, canPlay, cheapestAffordable, behindTowerY, threatenedLane, laneX, bestSpellTarget, dist } from './lib.js';

export default function nemotron3superfree(view) {
  // Early exit if no elixir for cheapest card (Goblins = 2)
  if (view.self.elixir < 2) return null;

  const { self, enemy, arena, towers, units } = view;
  const myId = self.id;
  const mid = arena.mid;
  const myTowersAlive = myTowers(view).filter(t => t.alive);
  const enemyTowersAlive = enemyTowers(view).filter(t => t.alive);
  const myPrincesses = myTowersAlive.filter(t => t.kind === 'princess');
  const enemyPrincesses = enemyTowersAlive.filter(t => t.kind === 'princess');
  const myKing = myTowersAlive.find(t => t.kind === 'king');
  const enemyKing = enemyTowersAlive.find(t => t.kind === 'king');
  
  // Calculate elixir advantage
  const elixirAdvantage = self.elixir - enemy.elixir;
  
  // Count total princess tower HP remaining for both sides
  const myPrincessHP = myPrincesses.reduce((sum, p) => sum + p.hp, 0);
  const enemyPrincessHP = enemyPrincesses.reduce((sum, p) => sum + p.hp, 0);
  const princessHPAdvantage = myPrincessHP - enemyPrincessHP;

  // Helper to check if we can afford and play a card
  const canAffordAndPlay = (card) => {
    const h = self.hand.find(c => c.card === card);
    return h && self.elixir >= h.cost && canPlay(view, card);
  };

  // 1. DEFENSE: Respond to immediate threats with prioritization
  // Check for enemy units threatening our princess towers
  const defenseThreshold = 12; // tiles from princess (increased for earlier reaction)
  const threateningUnits = enemyUnits(view).filter(u => 
    myPrincesses.some(p => dist(u, p) < defenseThreshold)
  );

  if (threateningUnits.length > 0) {
    // Calculate threat level per princess
    const princessThreats = myPrincesses.map(p => ({
      princess: p,
      threat: threateningUnits.reduce((sum, u) => sum + (dist(u, p) < defenseThreshold ? 1 : 0), 0),
      threatWeight: threateningUnits.reduce((sum, u) => {
        if (dist(u, p) < defenseThreshold) {
          // Weight by unit threat (approximate by cost * proximity)
          const uCard = self.hand.find(h => h.card === u.card) || enemy.hand.find(h => h.card === u.card);
          const cost = uCard ? uCard.cost : 3; // default cost
          const proximity = 1 - (dist(u, p) / defenseThreshold);
          return sum + (cost * proximity);
        }
        return sum;
      }, 0)
    }));
    
    // Sort by threat weight (most threatening first)
    princessThreats.sort((a, b) => b.threatWeight - a.threatWeight);
    const mostThreatened = princessThreats[0];
    
    if (mostThreatened && mostThreatened.threatWeight > 0) {
      // Prefer Cannon for ground troops defense
      if (canAffordAndPlay('Cannon')) {
        const threatenedPrincess = mostThreatened.princess;
        // Deploy Cannon slightly towards enemy from princess, clamped to our half
        const deployX = threatenedPrincess.x;
        const deployY = myId === 0 ? 
          Math.min(threatenedPrincess.y + 2, mid - 0.5) : 
          Math.max(threatenedPrincess.y - 2, mid + 0.5);
        return { card: 'Cannon', x: deployX, y: deployY };
      }
      
      // Fallback to swarm defense for air or mixed threats
      if (canAffordAndPlay('Goblins')) {
        const threatenedPrincess = mostThreatened.princess;
        const deployX = threatenedPrincess.x;
        const deployY = myId === 0 ? 
          Math.min(threatenedPrincess.y + 2, mid - 0.5) : 
          Math.max(threatenedPrincess.y - 2, mid + 0.5);
        return { card: 'Goblins', x: deployX, y: deployY };
      }
      
      // Last resort: Knights for tanky defense
      if (canAffordAndPlay('Knight')) {
        const threatenedPrincess = mostThreatened.princess;
        const deployX = threatenedPrincess.x;
        const deployY = myId === 0 ? 
          Math.min(threatenedPrincess.y + 2, mid - 0.5) : 
          Math.max(threatenedPrincess.y - 2, mid + 0.5);
        return { card: 'Knight', x: deployX, y: deployY };
      }
    }
  }

  // 2. SPELL VALUE: Use spells for maximum efficiency
  // Only cast spells when we have elixir advantage or facing significant threat
  if ((self.elixir >= 3 && elixirAdvantage >= 0) || threateningUnits.length >= 3) {
    // Look for swarm targets with increasing thresholds based on elixir
    const minHp = Math.max(300, 600 - (self.elixir * 20)); // Lower threshold when low on elixir
    const swarmTarget = bestSpellTarget(view, 3.5, minHp);
    
    if (swarmTarget && swarmTarget.value >= minHp) {
      // Prefer Fireball for better value vs clumped units, Arrows for spread
      // Simple heuristic: if high value concentration, use Fireball
      if (canAffordAndPlay('Fireball') && swarmTarget.value >= 800) {
        return { card: 'Fireball', x: swarmTarget.x, y: swarmTarget.y };
      }
      if (canAffordAndPlay('Arrows')) {
        return { card: 'Arrows', x: swarmTarget.x, y: swarmTarget.y };
      }
    }
    
    // Also consider spell damage to princess towers when they're low
    if (enemyPrincessHP < 1000 && self.elixir >= 4) { // Fireball can finish
      const targetPrincess = enemyPrincesses.reduce((lowest, p) => 
        p.hp < lowest.hp ? p : lowest, enemyPrincesses[0] || { hp: 9999, x: 9, y: myId === 0 ? 6.5 : 25.5 });
      
      if (targetPrincess.hp < 1000 && canAffordAndPlay('Fireball')) {
        // Aim slightly inside tower radius for consistent hit
        return { card: 'Fireball', x: targetPrincess.x, y: targetPrincess.y };
      }
    }
  }

  // 3. PUSH: Coordinate pushes when we have advantage
  // Push conditions: elixir advantage, enemy weakened, or we have tank ready
  const shouldPush = elixirAdvantage >= 2 || 
                    enemyPrincessHP < myPrincessHP * 0.7 || 
                    (myPrincesses.length === 2 && enemyPrincesses.length < 2);
  
  if (shouldPush && canAffordAndPlay('Giant') && self.elixir >= 5) {
    // Smart lane selection based on multiple factors
    const lane = threatenedLane(view);
    
    // Factor 1: Enemy princess weakness (higher priority)
    let bestLane = null;
    let bestScore = -Infinity;
    
    ['left', 'right'].forEach(lane => {
      const enemyPrincessInLane = enemyPrincesses.find(p => p.side === lane);
      const princessScore = enemyPrincessInLane ? 
        (1000 - enemyPrincessInLane.hp) / 1000 : // Lower HP = higher score
        2.0; // Bonus for missing princess
      
      // Factor 2: Our troops already in lane (push synergy)
      const myUnitsInLane = myUnits(view).filter(u => 
        (lane === 'left' && u.x < arena.width / 2) || 
        (lane === 'right' && u.x >= arena.width / 2)
      ).length;
      const synergyScore = myUnitsInLane * 0.5;
      
      // Factor 3: Threatened lane (defensive push)
      const threatScore = (lane === threatenedLane(view)) ? 1.0 : 0.0;
      
      const totalScore = princessScore + synergyScore + threatScore;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestLane = lane;
      }
    });
    
    const pushLane = lane || bestLane || (view.tick % 2 === 0 ? 'left' : 'right'); // deterministic fallback
    const x = laneX(view, pushLane);
    const y = myId === 0 ? mid - 4 : mid + 4; // Safe deploy just across river
    
    return { card: 'Giant', x, y };
  }

  // 4. SUPPORT: Back up our troops with appropriate support
  const myGiants = myUnits(view).filter(u => u.card === 'Giant' && u.hp > 0);
  const myKnights = myUnits(view).filter(u => u.card === 'Knight' && u.hp > 0);
  const myTanks = [...myGiants, ...myKnights].filter(t => t.hp > 0);
  
  if (myTanks.length > 0 && self.elixir >= 3) {
    // Find the tank that's closest to enemy territory (most advanced)
    const advancedTank = myTanks.reduce((mostAdvanced, tank) => {
      const progress = myId === 0 ? tank.y : (arena.height - tank.y);
      return (mostAdvanced.progress || 0) > progress ? mostAdvanced : { ...tank, progress };
    }, { progress: -1 }).progress > -1 ? 
      myTanks.reduce((mostAdvanced, tank) => {
        const progress = myId === 0 ? tank.y : (arena.height - tank.y);
        return (mostAdvanced.progress || 0) > progress ? mostAdvanced : { ...tank, progress };
      }, { progress: -1 }) : myTanks[0];
    
    if (advancedTank.progress > -1) {
      const tank = { ...advancedTank };
      delete tank.progress;
      
      // Choose support based on what we have and what's needed
      const hasAirThreat = enemyUnits(view).some(u => u.flying && dist(u, tank) < 8);
      
      // Use deterministic choice based on tick instead of Math.random()
      const useMusketeer = (view.tick % 3) !== 0; // 2/3 of the time
      
      if (canAffordAndPlay('Musketeer') && (!hasAirThreat || useMusketeer)) {
        // Musketeer for ranged support
        const deployY = tank.y - forward(view) * 2;
        return { card: 'Musketeer', x: tank.x, y: deployY };
      }
      if (canAffordAndPlay('Knight')) {
        // Knight for melee support/tank
        const deployY = tank.y - forward(view) * 2;
        return { card: 'Knight', x: tank.x, y: deployY };
      }
      if (canAffordAndPlay('Goblins')) {
        // Goblins for swarm support
        const deployY = tank.y - forward(view) * 2;
        return { card: 'Goblins', x: tank.x, y: deployY };
      }
    }
  }

  // 5. CYCLE: Smart cycling to get to key cards
  // Cycle when we have excess elixir or are missing key cards in hand
  const keyCards = ['Giant', 'Cannon', 'Fireball'];
  const hasKeyCard = keyCards.some(card => self.hand.some(c => c.card === card));
  
  if ((self.elixir >= 6 && !hasKeyCard) || self.elixir >= 9) {
    const cheapCard = cheapestAffordable(view);
    if (cheapCard && canAffordAndPlay(cheapCard)) {
      // Cycle to sides to potentially bait enemy - deterministic based on tick
      const side = (view.tick % 2) === 0 ? 0.25 : 0.75;
      const x = arena.width * side;
      const y = myId === 0 ? arena.mid - 3 : arena.mid + 3;
      return { card: cheapCard, x, y };
    }
  }

  // 6. DEFAULT: Hold and wait for better opportunities
  // But hold defensively (back) when we're at elixir disadvantage
  if (elixirAdvantage < -2) {
    const x = arena.width / 2;
    const y = myId === 0 ? arena.mid - 4 : arena.mid + 4; // More defensive hold
    const cheapCard = cheapestAffordable(view);
    if (cheapCard && canAffordAndPlay(cheapCard)) {
      return { card: cheapCard, x, y };
    }
  }

  return null;
}