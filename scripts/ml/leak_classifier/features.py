"""Feature extraction for the I1 leak-vs-cache-warmup classifier.

THIS FILE IS A CONTRACT. The Rust inference side
(`src-tauri/src/ai/classifiers/leak.rs`) must extract the exact same 8
features, in the same order, with the same arithmetic, from the same raw
memory series. Any change here requires the matching change in Rust,
re-training, and re-checking the shared test vectors in `test_vectors.json`.

Kept pure-Python (no numpy) so the logic is trivially mirrored in Rust.

INPUT
  A memory series: a list of floats — per-process memory in MB, sampled at
  ~1 Hz, oldest sample first. Callers must pass at least 30 samples; this
  module assumes that and does not re-check.

OUTPUT
  A fixed list of 8 floats, in this exact order:
    0  slope_mb_min       linear-fit slope of the whole window, MB/minute
    1  r2                 r-squared of that linear fit, 0..1
    2  slope_decay        (firstThirdSlope - lastThirdSlope) normalised to
                          [-1, 1]. ~0 for a leak (rate steady), ~+1 for a
                          warmup / startup (rate falls off), <0 accelerating
    3  curvature          deviation of the smoothed mid-sample from the
                          first..last chord, normalised to ~[-1.5, 1.5].
                          ~0 linear (leak), >0 concave (warmup), <0 convex
    4  first_half_share   fraction of total growth that happened in the
                          first half of the window
    5  tail_slope_mb_min  linear-fit slope of just the final 20% of the
                          window, MB/minute — "is it still growing?"
    6  total_growth_mb    m[last] - m[first]
    7  max_step_mb        largest single-sample increase in the window
"""

from __future__ import annotations

import math

FEATURE_NAMES = [
    "slope_mb_min",
    "r2",
    "slope_decay",
    "curvature",
    "first_half_share",
    "tail_slope_mb_min",
    "total_growth_mb",
    "max_step_mb",
]
N_FEATURES = len(FEATURE_NAMES)

_EPS = 1e-9
# A sample is ~1 second apart, so slope-per-sample * 60 = slope-per-minute.
_SAMPLES_PER_MIN = 60.0


def _linfit(values: list[float]) -> tuple[float, float]:
    """Least-squares fit of `values` against x = 0,1,2,...  Returns
    (slope_per_sample, r2). Mirrors the regression in insights.ts."""
    n = len(values)
    if n < 2:
        return 0.0, 0.0
    sx = sy = sxx = sxy = 0.0
    for i, y in enumerate(values):
        sx += i
        sy += y
        sxx += i * i
        sxy += i * y
    denom = n * sxx - sx * sx
    if abs(denom) < _EPS:
        return 0.0, 0.0
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    mean = sy / n
    ss_tot = 0.0
    ss_res = 0.0
    for i, y in enumerate(values):
        ss_tot += (y - mean) ** 2
        resid = y - (slope * i + intercept)
        ss_res += resid * resid
    r2 = 1.0 - ss_res / ss_tot if ss_tot > _EPS else 0.0
    if r2 < 0.0:
        r2 = 0.0
    return slope, r2


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def extract_features(series: list[float]) -> list[float]:
    """Extract the 8-feature vector from a memory series. See module docstring."""
    n = len(series)
    if n < 2:
        return [0.0] * N_FEATURES

    first = series[0]
    last = series[-1]
    total_growth = last - first

    # 0,1 — whole-window linear fit.
    slope_ps, r2 = _linfit(series)
    slope_mb_min = slope_ps * _SAMPLES_PER_MIN

    # 2 — slope decay across thirds.
    third = max(2, n // 3)
    first_slope, _ = _linfit(series[:third])
    last_slope, _ = _linfit(series[n - third:])
    denom = abs(first_slope) + abs(last_slope) + _EPS
    slope_decay = _clamp((first_slope - last_slope) / denom, -1.0, 1.0)

    # 3 — curvature: smoothed mid-sample vs the endpoint chord.
    mid = n // 2
    lo = max(0, mid - 2)
    hi = min(n, mid + 3)
    mid_smooth = sum(series[lo:hi]) / (hi - lo)
    chord_mid = (first + last) / 2.0
    rng = abs(total_growth) + _EPS
    curvature = _clamp((mid_smooth - chord_mid) / rng, -1.5, 1.5)

    # 4 — share of total growth in the first half.
    first_half_growth = series[mid] - first
    if abs(total_growth) > 1.0:
        first_half_share = _clamp(first_half_growth / total_growth, -1.0, 2.0)
    else:
        first_half_share = 0.5  # negligible total growth — neutral

    # 5 — slope of the final 20% of the window.
    tail_len = max(5, n // 5)
    tail_slope_ps, _ = _linfit(series[n - tail_len:])
    tail_slope_mb_min = tail_slope_ps * _SAMPLES_PER_MIN

    # 7 — largest single-sample increase.
    max_step = 0.0
    for i in range(1, n):
        step = series[i] - series[i - 1]
        if step > max_step:
            max_step = step

    return [
        slope_mb_min,
        r2,
        slope_decay,
        curvature,
        first_half_share,
        tail_slope_mb_min,
        total_growth,
        max_step,
    ]


# Sanity check when run directly: print features for a few canonical shapes.
if __name__ == "__main__":
    n = 120
    shapes = {
        "linear leak":  [100 + 0.05 * i for i in range(n)],
        "warmup":       [100 + 200 * (1 - math.exp(-i / 20)) for i in range(n)],
        "startup":      [100 + (300 if i > 8 else 0) for i in range(n)],
        "steady":       [100.0 for _ in range(n)],
    }
    for name, s in shapes.items():
        feats = extract_features(s)
        pairs = ", ".join(f"{k}={v:.3f}" for k, v in zip(FEATURE_NAMES, feats))
        print(f"{name:14s} {pairs}")
