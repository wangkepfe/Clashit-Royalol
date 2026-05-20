// Bots selectable in the browser viewer. The agent: add a line here after
// creating bots/<name>.js. (The headless arena can also load bots by filename
// directly, so this registry is only required for the viewer dropdowns.)
//
// All iterated SCRIPT VERSIONS are exposed (not just one "smart"): pick any
// version vs any other, or vs a baseline opponent, and watch them play.
//   v8  = pre-projectile baseline (no spell-lead)
//   v9  = v8 + spell-lead + tower-HP game-state   (REJECTED: 70%→50%)
//   v10 = v8 + spell-lead  (CURRENT champion; spell waste 5.2%→2.4%)
//   v11 = v10 + enemy-elixir lever                (REJECTED: 50% vs mirror)
import smart_v8 from '../bots/smart_v8.js';
import smart_v9 from '../bots/smart_v9.js';
import smart_v10 from '../bots/smart_v10.js';
import smart_v11 from '../bots/smart_v11.js';
import smart from '../bots/smart.js';
import champion from '../bots/champion.js';
import idle from '../bots/idle.js';
import random from '../bots/random.js';
import rush from '../bots/rush.js';
import defender from '../bots/defender.js';
import example from '../bots/example.js';

export const BOTS = {
  smart_v8,
  smart_v9,
  smart_v10,
  smart_v11,
  smart,
  champion,
  idle,
  random,
  rush,
  defender,
  example,
};
