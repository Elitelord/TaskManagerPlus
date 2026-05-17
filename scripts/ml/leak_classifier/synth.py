"""Synthetic memory-series generator for the I1 leak classifier.

Produces labelled per-process memory series for the four classes the
classifier must tell apart:

  leak           steady, unbounded linear (occasionally super-linear) growth
  cache-warmup   saturating-exponential growth that plateaus within the window
  startup-spike  a flat baseline, one sharp early jump, then flat again
  steady         flat, with at most a tiny drift

Every series gets realistic corruption — Gaussian jitter, an optional
GC-style sawtooth, integer (MB) quantisation, and a randomised window
length / baseline / scale. Parameter ranges deliberately overlap at the
edges (a very slow leak vs. drifting-steady; a long-tau warmup vs. linear)
so the dataset contains genuinely hard cases and the evaluation stays
honest.

Primary training data. A small hand-labelled real-capture set validates
that a model trained here generalises off the generator — see README.
"""

from __future__ import annotations

import math

import numpy as np

CLASSES = ["leak", "cache-warmup", "startup-spike", "steady"]


def _random_walk(n: int, rng: np.random.Generator, step_sigma: float) -> list[float]:
    """A centered random walk — autocorrelated wander with no net drift."""
    walk = [0.0]
    for _ in range(n - 1):
        walk.append(walk[-1] + rng.normal(0.0, step_sigma))
    mean = sum(walk) / n
    return [w - mean for w in walk]


def _apply_noise(
    clean: list[float], rng: np.random.Generator, sigma: float, base: float
) -> list[float]:
    """Add realistic corruption to a clean shape, then quantise to MB:
      - an autocorrelated random-walk wander (real memory MEANDERS even when
        it is not leaking — this is what teaches the model that a noisy
        upward excursion with a low linear fit is still 'steady'),
      - IID Gaussian jitter,
      - an optional GC sawtooth.
    The walk is centered (no net drift), so a class's trend still comes only
    from its own shape; the walk just makes that trend harder to see —
    exactly as in real captures."""
    n = len(clean)
    out = list(clean)
    walk_step = base * rng.uniform(0.0004, 0.0018)  # wander ~0.5-2% of base
    walk = _random_walk(n, rng, walk_step)
    jitter = rng.normal(0.0, sigma, n)
    # ~45% of processes show a GC sawtooth: memory ramps then drops on collect.
    if rng.random() < 0.45:
        period = int(rng.integers(15, 60))
        amp = rng.uniform(1.0, 8.0)
        for i in range(n):
            out[i] += (i % period) / period * amp
    for i in range(n):
        out[i] += walk[i] + jitter[i]
        out[i] = float(max(1, round(out[i])))  # quantise to MB, keep positive
    return out


def _common(rng: np.random.Generator) -> tuple[int, float, float]:
    """Random window length, baseline MB, and noise sigma shared by all classes."""
    n = int(rng.integers(30, 201))
    base = float(rng.uniform(50, 3000))
    sigma = float(rng.uniform(0.3, 3.0) + base * rng.uniform(0.0, 0.004))
    return n, base, sigma


def gen_leak(rng: np.random.Generator) -> list[float]:
    n, base, sigma = _common(rng)
    # Min 1 MB/min: a leak slower than that is indistinguishable from wander
    # in a short window, and not worth flagging anyway.
    rate = rng.uniform(1.0, 12.0) / 60.0          # MB per sample (1-12 MB/min)
    accel = rng.uniform(0.0, 0.015) if rng.random() < 0.3 else 0.0
    clean = [base + rate * i + 0.5 * accel * i * i for i in range(n)]
    return _apply_noise(clean, rng, sigma, base)


def gen_warmup(rng: np.random.Generator) -> list[float]:
    n, base, sigma = _common(rng)
    ceiling = rng.uniform(20.0, 800.0)            # total warmup growth
    tau = rng.uniform(n * 0.08, n * 0.55)         # time constant (samples)
    clean = [base + ceiling * (1.0 - math.exp(-i / tau)) for i in range(n)]
    return _apply_noise(clean, rng, sigma, base)


def gen_startup(rng: np.random.Generator) -> list[float]:
    n, base, sigma = _common(rng)
    step = rng.uniform(25.0, 900.0)
    t0 = float(rng.integers(2, max(3, n // 6)))   # jump happens early
    w = rng.uniform(0.5, 3.5)                     # sharpness of the rise
    clean = [base + step / (1.0 + math.exp(-(i - t0) / w)) for i in range(n)]
    return _apply_noise(clean, rng, sigma, base)


def gen_steady(rng: np.random.Generator) -> list[float]:
    n, base, sigma = _common(rng)
    drift = rng.uniform(-0.3, 0.3) / 60.0         # MB per sample — tiny
    clean = [base + drift * i for i in range(n)]
    # The random-walk wander in _apply_noise is what makes 'steady' realistic
    # — a meandering idle process, not a dead-flat line.
    return _apply_noise(clean, rng, sigma, base)


_GENERATORS = {
    "leak": gen_leak,
    "cache-warmup": gen_warmup,
    "startup-spike": gen_startup,
    "steady": gen_steady,
}


def generate(n_per_class: int, seed: int = 42) -> tuple[list[list[float]], list[str]]:
    """Return (series_list, labels) with `n_per_class` examples of each class."""
    rng = np.random.default_rng(seed)
    series: list[list[float]] = []
    labels: list[str] = []
    for label in CLASSES:
        gen = _GENERATORS[label]
        for _ in range(n_per_class):
            series.append(gen(rng))
            labels.append(label)
    return series, labels
