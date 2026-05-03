/**
 * Memory composition / stacked graph palette — fixed hues, not --accent-primary.
 * Do not substitute the user accent for multi-segment categories, traffic-light
 * tiers (CPU/GPU/NPU bars), or Insights QuickStat health states; keep accent for
 * chrome (nav, buttons, borders, decorative tiles) only.
 *
 * Fixed “user / process RAM” hue for composition + top consumers — not the
 * theme accent — so it never collides with kernel purple, GPU orange, or cache
 * tiers when users pick those presets.
 */
export const MEMORY_APPS_SEGMENT_COLOR = "#5b9cf6";

/**
 * Committed memory vs commit limit bar — distinct from kernel memory (#a78bfa)
 * on the composition strip (virtual commit is a different concept).
 */
export const MEMORY_COMMIT_USAGE_BAR_COLOR = "#6366f1";

/** Kernel / GPU shared / modified pages — shared by Memory composition + stacked memory graph */
export const MEMORY_KERNEL_SEGMENT_COLOR = "#a78bfa";
export const MEMORY_GPU_SHARED_SEGMENT_COLOR = "#f59e0b";
export const MEMORY_MOD_PAGES_SEGMENT_COLOR = "#0ea5e9";

/**
 * Fixed hues for standby/cache tiers so they stay distinct from each other and
 * from kernel purple (#a78bfa) regardless of the user's accent color.
 */
export const MEMORY_CACHE_TIER_COLORS = {
  recentFiles: "#38bdf8",
  quickLaunch: "#eab308",
  freeToReuse: "#059669",
} as const;

/** When the OS does not expose standby breakdown, use a single cache stripe */
export const MEMORY_CACHED_FILES_AGGREGATE_COLOR = MEMORY_CACHE_TIER_COLORS.recentFiles;
