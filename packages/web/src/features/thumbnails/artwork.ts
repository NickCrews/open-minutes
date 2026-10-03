/**
 * Generated artwork: every body's thumbnail, and the stand-in for a meeting
 * with no video. Everything is derived from string seeds, so the same
 * body or meeting draws the same picture on every page and every render, on
 * the server and in the browser alike. Kept free of Solid so it can be tested
 * on its own.
 */

/** The SVG canvas, in the 16:9 shape of a YouTube thumbnail. */
export const ARTWORK_WIDTH = 320;
export const ARTWORK_HEIGHT = 180;

export interface ArtworkShape {
  cx: number;
  cy: number;
  r: number;
  /** An HSL color. */
  fill: string;
  opacity: number;
}

export interface Artwork {
  /** The background gradient's two ends, top-left to bottom-right. */
  from: string;
  to: string;
  shapes: ArtworkShape[];
  /** Short text across the middle, eg "GBOS". Empty for none. */
  label: string;
}

/** FNV-1a: a small, stable 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a seeded PRNG yielding floats in [0, 1). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The artwork for a seed pair. `palette` picks the colors and `layout` places
 * the shapes, so a body's meetings (one palette, a layout each) read as a
 * family while still telling apart. Pass the same seed for both when there's
 * nothing to tell apart.
 */
export function artwork(seeds: {
  palette: string;
  layout: string;
  label?: string;
}): Artwork {
  const hue = hashString(seeds.palette) % 360;
  // A neighbouring hue for the gradient's far end, swung either way.
  const swing = (hashString(`${seeds.palette}:swing`) % 2 ? 1 : -1) * 40;
  const hue2 = (hue + swing + 360) % 360;
  const next = random(hashString(seeds.layout));
  const shapes: ArtworkShape[] = Array.from({ length: 5 }, () => {
    const shapeHue = (hue + (next() - 0.5) * 90 + 360) % 360;
    return {
      cx: Math.round(next() * ARTWORK_WIDTH),
      cy: Math.round(next() * ARTWORK_HEIGHT),
      r: Math.round(30 + next() * 90),
      fill: `hsl(${Math.round(shapeHue)} 70% ${Math.round(55 + next() * 20)}%)`,
      opacity: Math.round((0.15 + next() * 0.3) * 100) / 100,
    };
  });
  return {
    from: `hsl(${hue} 55% 38%)`,
    to: `hsl(${hue2} 60% 24%)`,
    shapes,
    label: (seeds.label ?? "").trim().slice(0, 8),
  };
}
