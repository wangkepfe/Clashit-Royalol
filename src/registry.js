// Bots selectable in the browser viewer. Only one bot lives in the repo:
// `smart` — the adaptive script that picks the best move per situation.
// Both player slots default to it, so the viewer runs a smart-vs-smart mirror.
import smart from '../bots/smart.js';

export const BOTS = { smart };
