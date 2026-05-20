// Single source of truth for the arena->screen projection. No DOM imports, so
// both the browser renderer and the Node bake tool import this and stay
// pixel-aligned. Border thickness (px) of the decorative platform ring — wide
// enough for the Clash-Royale-style stands, banners and props.
export const padPx = (tile) => Math.round(tile * 2.8);
