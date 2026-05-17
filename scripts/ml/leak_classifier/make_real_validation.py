"""Turn a raw memory-history dump into a labelled real-validation set.

INPUT  scripts/ml/leak_classifier/real_capture_raw.json
       The object produced by `window.__tmplusDumpMemHistory()` in the app's
       DevTools console — `{ "process name": [mb, mb, ...], ... }`.

OUTPUT scripts/ml/leak_classifier/real_validation.json
       `[{ "name": ..., "series": [...], "label": ... }, ...]` — the format
       `train.py` scores the shipped model against.

LABELLING
  Labels here are GROUND TRUTH, assigned by a simple, independent shape
  rule — deliberately NOT the 8-feature decision tree, so scoring the tree
  against them is a real test, not a tautology. The rule:

    leak           gradual sustained growth, still rising at the tail, NOT
                   dominated by any single jump
    cache-warmup   strong growth that has flattened by the tail
    startup-spike  one large step (anywhere in the window) that accounts for
                   most of the growth — the rest of the window is flat
    steady         everything else (flat, or noisy with no real trend)

  A 5-minute idle capture is almost entirely `steady`; that's correct, and
  it validates the model's false-positive rate. Capturing leaks / warmups
  needs a longer session with real app launches. Any series the rule does
  NOT call `steady` is printed for you to eyeball — hand-correct
  `real_validation.json` if a label looks wrong before running `train.py`.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW_PATH = HERE / "real_capture_raw.json"
OUT_PATH = HERE / "real_validation.json"

MIN_SAMPLES = 30


def _slope_per_min(series: list[float]) -> float:
    """Least-squares slope in MB/min (samples are ~1 s apart)."""
    n = len(series)
    sx = sum(range(n))
    sy = sum(series)
    sxx = sum(i * i for i in range(n))
    sxy = sum(i * v for i, v in enumerate(series))
    denom = n * sxx - sx * sx
    if denom == 0:
        return 0.0
    return (n * sxy - sx * sy) / denom * 60.0


def label_series(series: list[float]) -> str:
    """Independent, shape-based ground-truth label. See module docstring."""
    n = len(series)
    med = statistics.median(series) or 1.0
    net = series[-1] - series[0]
    growth_pct = net / med

    quarter = max(2, n // 4)
    tail_slope = _slope_per_min(series[-quarter:])
    head_slope = _slope_per_min(series[:quarter])
    # Largest single-sample jump, anywhere in the window.
    max_step = max((series[i + 1] - series[i] for i in range(n - 1)), default=0.0)

    # No meaningful net growth -> steady (flat, or noisy with no trend).
    if growth_pct <= 0.10 or net <= 20.0:
        return "steady"

    # There IS sustained growth. Classify the shape:
    step_dominates = max_step > 0.5 * net  # one jump = most of the growth
    # A single jump bigger than half the total growth is a discrete STEP,
    # not a gradual leak — regardless of WHERE in the window it lands or
    # whether the tail is still flat. Real captures routinely show a
    # process sitting flat for the whole session then jumping once near the
    # end (Defender starting a scan, PowerShell running a script). That is
    # startup-spike shaped, never a leak — a leak's growth is spread across
    # the window, not concentrated in one sample.
    if step_dominates:
        return "startup-spike"
    if tail_slope > 0.5 and tail_slope > head_slope * 0.4:
        return "leak"                     # gradual, still climbing at the tail
    return "cache-warmup"                 # grew then flattened, no single step


def main() -> int:
    if not RAW_PATH.exists():
        sys.exit(
            f"error: {RAW_PATH} not found.\n"
            "Save the JSON from window.__tmplusDumpMemHistory() to that path "
            "first (see scripts/ml/README.md)."
        )
    raw = json.loads(RAW_PATH.read_text(encoding="utf-8"))

    out: list[dict] = []
    skipped_short = 0
    for name, series in raw.items():
        series = [float(v) for v in series]
        if len(series) < MIN_SAMPLES:
            skipped_short += 1
            continue
        out.append({"name": name, "series": series, "label": label_series(series)})

    OUT_PATH.write_text(json.dumps(out, indent=1), encoding="utf-8")

    tally: dict[str, int] = {}
    for r in out:
        tally[r["label"]] = tally.get(r["label"], 0) + 1
    print(f"Wrote {len(out)} labelled series to {OUT_PATH.name}")
    print(f"  ({skipped_short} series skipped — under {MIN_SAMPLES} samples)")
    print("\nLabel distribution:")
    for label, count in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {label:14s} {count}")

    movers = [r for r in out if r["label"] != "steady"]
    if movers:
        print("\nNon-steady labels — eyeball these, hand-correct if wrong:")
        for r in movers:
            print(f"  {r['label']:14s} {r['name']}")
    else:
        print("\nEvery series labelled 'steady' (expected for a short idle "
              "capture). This validates false-positive rate only.")
    print("\nNext: python scripts/ml/leak_classifier/train.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
