// Bots selectable in the browser viewer. The repo ships exactly one bot —
// Claude_Opus_4_7, the current adaptive play script. Both player slots
// default to it, so the viewer runs a Claude_Opus_4_7 vs Claude_Opus_4_7
// mirror by default.
import Claude_Opus_4_7 from '../bots/Claude_Opus_4_7.js';

export const BOTS = { Claude_Opus_4_7 };
