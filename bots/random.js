// Baseline opponent: plays a random legal card at a random spot, sometimes.
// Deterministic (seeded by tick + player id) so matches stay reproducible.
import { hash01 } from '../src/rng.js';

export default function random(v) {
  const r = hash01(v.tick * 7 + v.self.id * 101);
  if (r > 0.06) return null; // act ~ a few times per second at most

  const affordable = v.self.hand.filter((h) => v.self.elixir >= h.cost);
  if (affordable.length === 0) return null;

  const pick = affordable[Math.floor(hash01(v.tick * 13 + 1) * affordable.length)];
  const z = v.self.deployZone;
  const x = z.minX + hash01(v.tick * 17 + 2) * (z.maxX - z.minX);
  const y = z.minY + hash01(v.tick * 19 + 3) * (z.maxY - z.minY);
  return { card: pick.card, x, y };
}
