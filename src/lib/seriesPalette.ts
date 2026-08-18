/**
 * Data-visualization palette — single source of truth.
 *
 * Two rules govern everything in here:
 *
 *  1. Hue is only spent where it *encodes* something. Severity, thermal bands,
 *     fan profiles and memory cache tiers all keep their colors because the
 *     color is the information. A file category, a folder in a donut, or an
 *     individual app in a stack is just an item in a list — those get a
 *     lightness ramp, not a hue each.
 *  2. Nothing hardcodes a series color at a call site. Values come from the
 *     --series-* tokens in tokens.css so the light theme can retune them
 *     without every caller knowing.
 *
 * Previously there were two divergent hardcoded arrays (12 and 13 entries)
 * plus ~20 one-off hexes scattered across the pages.
 */

/** Dark-theme values, mirroring tokens.css. Used if the tokens can't be read. */
const SERIES_FALLBACK = [
  "#60a5fa", "#34d399", "#fb923c", "#f87171", "#2dd4bf",
  "#f472b6", "#a3e635", "#94a3b8", "#c084fc", "#fbbf24",
];
const NEUTRAL_FALLBACK = "#71717a";

function isLight(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

/**
 * Token reads go through a cache because these are called from canvas draw
 * loops at frame rate, and getComputedStyle forces style resolution.
 *
 * The cache is invalidated explicitly by applyTheme() in lib/settings.ts,
 * which is the only place the theme attribute or the accent custom properties
 * change. Keying on the theme attribute alone would not be enough — the user
 * can change the accent without changing the theme.
 */
let cached: {
  series: string[];
  neutral: string;
  accent: string;
  graphBg: string;
} | null = null;

export function invalidatePalette(): void {
  cached = null;
  shadeCache.clear();
}

/**
 * Memo for shadesOf().
 *
 * Not premature: the memory graph rebuilds its full segment list for every
 * point in the buffer on every draw (`data.map(p => getStacked(p))`), and each
 * app segment asks for a shade. At ~60 buffered points, several apps each, and
 * a 60fps rAF loop while the y-axis eases, that is tens of thousands of
 * hex→HSL parses a second. The old code was an array index, so this would have
 * been a straight regression.
 *
 * Cleared by invalidatePalette(), same as the token cache — the inputs are the
 * base hue plus the theme, and the theme is what invalidation tracks.
 */
const shadeCache = new Map<string, string>();

function read() {
  if (cached) return cached;
  const cs = getComputedStyle(document.documentElement);
  cached = {
    series: SERIES_FALLBACK.map(
      (fb, i) => cs.getPropertyValue(`--series-${i + 1}`).trim() || fb,
    ),
    neutral: cs.getPropertyValue("--series-neutral").trim() || NEUTRAL_FALLBACK,
    accent: cs.getPropertyValue("--accent-primary").trim() || "#5b9cf6",
    graphBg: cs.getPropertyValue("--graph-bg").trim() || "transparent",
  };
  return cached;
}

/** The user's accent, resolved. Use instead of hardcoding a blue. */
export function accentColor(): string {
  return read().accent;
}

/** Canvas clear color for small inline charts. Theme-aware. */
export function graphBg(): string {
  return read().graphBg;
}

/** Ordered categorical palette. Take from the front: adjacent entries are the most separable. */
export function seriesPalette(): string[] {
  return read().series;
}

/** For an "Other" rollup, or any series whose identity carries no information. */
export function seriesNeutral(): string {
  return read().neutral;
}

// ── Lightness ramps ─────────────────────────────────────────────────────────
//
// For collections ordered by magnitude (donut slices by size, stacked app
// bands). Position in the ramp encodes rank, which is real information —
// unlike a hue per item, which encodes nothing and changes between scans.

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
}

/**
 * Apply an alpha to a color in whatever notation it arrived in.
 *
 * Replaces the `color + "44"` string-concatenation that used to do this: that
 * only worked for #rrggbb and silently produced an invalid color (which canvas
 * ignores, leaving the previous fillStyle in place) for anything else. The
 * ramps below emit hsl(), so the concat form would have broken outright.
 */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    const n = parseInt(c.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  // Modern space-separated forms accept a slash-alpha suffix directly.
  const fn = /^(hsl|rgb)\(([^)]*)\)$/i.exec(c);
  if (fn) {
    const inner = fn[2].split("/")[0].trim();
    return `${fn[1].toLowerCase()}(${inner} / ${alpha})`;
  }
  const fna = /^(hsla|rgba)\(([^)]*)\)$/i.exec(c);
  if (fna) {
    const parts = fna[2].split(",").map((p) => p.trim());
    if (parts.length === 4) {
      return `${fna[1].slice(0, 3)}a(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
  }
  return c;
}

/** Parse a #rrggbb into HSL degrees/percent. Returns null on anything else. */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

/** Interpolate across `count` steps, clamped so a 1-item ramp sits at the strong end. */
function step(i: number, count: number, from: number, to: number): number {
  if (count <= 1) return from;
  return from + ((to - from) * Math.min(i, count - 1)) / (count - 1);
}

/**
 * Pronounced shades of one base hue, for a small set of peers that belong to
 * the same family but still have to be told apart — the sidebar's resource
 * rows, the individual apps in the stacked memory graph.
 *
 * Wide lightness spread (56 points) and a gentle saturation falloff, because
 * each step must be individually legible rather than reading as one receding
 * gradient.
 *
 * Do NOT use a shade ramp where color is the link between a mark and a legend
 * row — a donut, a multi-series legend. The steps are too close to tell apart
 * there and the mapping breaks; that was tried on the storage donut and had to
 * be reverted to seriesPalette(). Distinguishing those items IS the encoding.
 */
export function shadesOf(baseHex: string, index: number, count: number): string {
  const key = `${baseHex}|${index}|${count}`;
  const hit = shadeCache.get(key);
  if (hit !== undefined) return hit;

  const base = hexToHsl(baseHex) ?? { h: 216, s: 89, l: 66 };
  const light = isLight();
  const l = light ? step(index, count, 26, 78) : step(index, count, 86, 30);
  const s = step(index, count, base.s, Math.max(base.s * 0.72, 32));
  const out = hsl(base.h, s, l);
  shadeCache.set(key, out);
  return out;
}

/** shadesOf() bound to the user's accent. */
export function accentShade(index: number, count: number): string {
  return shadesOf(accentColor(), index, count);
}

/**
 * Hue-free ramp for items that are merely items — individual apps in a stacked
 * memory graph, file categories in a breakdown bar. Slightly blue-tinted so it
 * sits with the UI neutrals rather than reading as pure grey.
 */
export function neutralRamp(index: number, count: number): string {
  const light = isLight();
  const l = light
    ? step(index, count, 42, 78)
    : step(index, count, 74, 32);
  return hsl(220, 9, l);
}
