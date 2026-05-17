"""Score the shipped leak classifier against a real-capture validation set.

Unlike `train.py`, this does NOT retrain anything — it loads the decision
tree already shipped in `src-tauri/models/leak_classifier.json`, runs it
over `real_validation.json`, and prints accuracy. It uses only the Python
standard library (plus the pure-Python `features.py`), so it runs with any
`python` — no sklearn / numpy needed.

Usage:
    python scripts/ml/leak_classifier/score_real.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from features import extract_features  # noqa: E402

MODEL_PATH = ROOT / "src-tauri" / "models" / "leak_classifier.json"
VALIDATION_PATH = HERE / "real_validation.json"


def predict(model: dict, feats: list[float]) -> tuple[str, float]:
    """Walk the decision tree. Returns (class, confidence)."""
    nodes = model["nodes"]
    classes = model["classes"]
    idx = 0
    for _ in range(len(nodes) + 1):
        node = nodes[idx]
        if "leaf" in node:
            probs = node["leaf"]
            best = max(range(len(probs)), key=lambda i: probs[i])
            return classes[best], probs[best]
        idx = node["l"] if feats[node["f"]] <= node["t"] else node["r"]
    raise RuntimeError("malformed tree — no leaf reached")


def main() -> int:
    if not MODEL_PATH.exists():
        sys.exit(f"error: {MODEL_PATH} not found")
    if not VALIDATION_PATH.exists():
        sys.exit(
            f"error: {VALIDATION_PATH.name} not found — run "
            "make_real_validation.py first."
        )
    model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    rows = json.loads(VALIDATION_PATH.read_text(encoding="utf-8"))
    classes = model["classes"]
    min_conf = model.get("min_confidence", 0.0)

    correct = 0
    low_conf = 0
    # confusion[true][pred]
    confusion = {t: {p: 0 for p in classes} for t in classes}
    misses: list[str] = []

    for row in rows:
        feats = extract_features([float(v) for v in row["series"]])
        pred, conf = predict(model, feats)
        true = row["label"]
        confusion.setdefault(true, {p: 0 for p in classes})
        confusion[true][pred] = confusion[true].get(pred, 0) + 1
        if pred == true:
            correct += 1
        else:
            misses.append(f"  {row.get('name', '?'):42s} true={true:14s} pred={pred}")
        if conf < min_conf:
            low_conf += 1

    n = len(rows)
    print(f"Scored {n} real-capture series against the shipped tree.\n")
    print(f"Accuracy: {correct}/{n} = {correct / n:.4f}")
    print(f"Below the {min_conf:.2f} confidence gate (runtime would say "
          f'"uncertain"): {low_conf}\n')

    print("Confusion (rows = true label, cols = predicted):")
    header = "                 " + " ".join(f"{c[:8]:>9s}" for c in classes)
    print(header)
    for t in classes:
        cells = " ".join(f"{confusion[t][p]:>9d}" for p in classes)
        print(f"  {t:14s} {cells}")

    if misses:
        print(f"\n{len(misses)} misclassified:")
        for m in misses:
            print(m)
    else:
        print("\nNo misclassifications.")

    # The headline number for a steady-dominated capture: false positives.
    steady_total = sum(confusion.get("steady", {}).values())
    steady_correct = confusion.get("steady", {}).get("steady", 0)
    if steady_total:
        fp = steady_total - steady_correct
        print(f"\nSteady-class false positives: {fp}/{steady_total} "
              f"({fp / steady_total:.1%}) idle/noisy processes wrongly "
              "flagged as leak/warmup/startup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
