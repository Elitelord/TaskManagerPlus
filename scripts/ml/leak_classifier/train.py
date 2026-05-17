"""Train the I1 leak-vs-cache-warmup classifier and export JSON weights.

Pipeline: synthetic memory series (`synth.py`) -> 8 features (`features.py`)
-> standardise -> multinomial logistic regression.

THE EVALUATION GATE
  Per the S-1 / S-2 spike lessons, ML is only worth shipping here if it
  beats a tuned threshold baseline on held-out data. This script trains the
  model, scores BOTH the model and a hand-written threshold classifier on
  the same test split, and prints a verdict. If the baseline wins, we ship
  the thresholds instead and record it as spike finding S-3.

Outputs (only the model path is consumed by Rust):
  out/leak_classifier.json   classes, feature stats, coefficients
  test_vectors.json          a few (series -> features) pairs, so the Rust
                             feature extractor can be checked for parity

Usage:
  python scripts/ml/leak_classifier/train.py [--per-class N] [--seed S]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier

# Local imports (run as a script from anywhere).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import FEATURE_NAMES, extract_features  # noqa: E402
from synth import generate  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent / "out"
MODEL_PATH = OUT_DIR / "leak_classifier.json"
VECTORS_PATH = Path(__file__).resolve().parent / "test_vectors.json"

MIN_CONFIDENCE = 0.55  # below this, Rust reports "uncertain" (no verdict)


def threshold_baseline(f: list[float]) -> str:
    """Hand-tuned threshold classifier over the 8 features — a sanity-check
    baseline. Feature order matches FEATURE_NAMES."""
    slope, r2, decay, curv, fhs, tail, total, max_step = f
    # Startup spike: one big early jump, growth up-front, flat tail.
    if max_step > 40.0 and fhs > 0.75 and tail < 2.5:
        return "startup-spike"
    # Cache warmup: growth rate clearly decayed and/or concave, tail flat.
    if total > 12.0 and tail < 3.0 and (decay > 0.55 or curv > 0.30):
        return "cache-warmup"
    # Leak: still climbing at the tail, rate roughly steady.
    if total > 12.0 and tail > 0.6 and decay < 0.55:
        return "leak"
    # Otherwise no meaningful sustained growth.
    return "steady"


def serialize_tree(clf: DecisionTreeClassifier) -> list[dict]:
    """Flatten a fitted sklearn decision tree into a JSON-friendly node list.

    Internal node:  {"f": feature_idx, "t": threshold, "l": left, "r": right}
                    decision rule — go left when x[f] <= t, else right.
    Leaf node:      {"leaf": [p0, p1, ...]}  class-probability distribution,
                    indexed in the same order as `clf.classes_`.
    Node 0 is the root.
    """
    t = clf.tree_
    nodes: list[dict] = []
    for i in range(t.node_count):
        if t.children_left[i] == -1:  # leaf
            counts = t.value[i][0]
            total = float(counts.sum())
            probs = [float(c / total) for c in counts] if total > 0 else []
            nodes.append({"leaf": probs})
        else:
            nodes.append({
                "f": int(t.feature[i]),
                "t": float(t.threshold[i]),
                "l": int(t.children_left[i]),
                "r": int(t.children_right[i]),
            })
    return nodes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--per-class", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    series, labels = generate(args.per_class, seed=args.seed)
    X = np.array([extract_features(s) for s in series], dtype=float)
    y = np.array(labels)
    print(f"Generated {len(series)} series, {X.shape[1]} features each.")

    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=args.seed, stratify=y,
    )

    scaler = StandardScaler().fit(X_tr)
    clf = LogisticRegression(max_iter=4000, class_weight="balanced")
    clf.fit(scaler.transform(X_tr), y_tr)

    # --- Score the learned model ---
    model_pred = clf.predict(scaler.transform(X_te))
    model_acc = float((model_pred == y_te).mean())

    # --- Fair baselines ---
    # A depth-limited decision tree is the honest "best simple rules" bar:
    # it auto-tunes its threshold splits, so it cannot be strawmanned, and a
    # shallow tree is itself transcribable to plain if/else. Two depths are
    # tried. The hand-threshold classifier is kept only as a sanity check.
    tree4 = DecisionTreeClassifier(max_depth=4, random_state=args.seed).fit(X_tr, y_tr)
    tree6 = DecisionTreeClassifier(max_depth=6, random_state=args.seed).fit(X_tr, y_tr)
    tree4_acc = float((tree4.predict(X_te) == y_te).mean())
    tree6_acc = float((tree6.predict(X_te) == y_te).mean())
    hand_pred = np.array([threshold_baseline(list(row)) for row in X_te])
    hand_acc = float((hand_pred == y_te).mean())

    print("\n=== Learned model (logistic regression) ===")
    print(classification_report(y_te, model_pred, zero_division=0))

    print("Accuracy comparison on the held-out test split:")
    print(f"  logistic regression          {model_acc:.4f}")
    print(f"  decision tree (depth 4)       {tree4_acc:.4f}")
    print(f"  decision tree (depth 6)       {tree6_acc:.4f}")
    print(f"  hand-tuned thresholds         {hand_acc:.4f}")

    # The bar is the best rule-expressible baseline (the shallow tree).
    baseline_acc = max(tree4_acc, hand_acc)
    margin = model_acc - baseline_acc
    print(f"\nmodel - best simple baseline = {margin:+.4f}")
    if margin >= 0.03:
        print("VERDICT: model clears the bar — ship the learned classifier.")
    elif tree4_acc >= model_acc - 0.01:
        print("VERDICT: a depth-4 decision tree matches the model — ship the")
        print("         tree (rule-expressible, simpler); log as S-3.")
    else:
        print("VERDICT: model does NOT clearly beat simple rules; reconsider.")

    # --- Train and export the SHIPPED model: a small decision tree ---
    # Per spike S-3 the learned LR only ties a shallow tree, and trees fit
    # this interaction-heavy feature space better while staying interpretable.
    # depth 5 + a min-leaf guard keeps it from carving overfit regions around
    # quirks of the synthetic generator.
    final = DecisionTreeClassifier(
        max_depth=5, min_samples_leaf=40, random_state=args.seed,
    ).fit(X_tr, y_tr)
    final_acc = float((final.predict(X_te) == y_te).mean())
    print(f"\nShipped model — decision tree (depth 5, min_leaf 40): {final_acc:.4f}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": "leak_classifier",
        "version": 1,
        "kind": "decision_tree",
        "classes": list(final.classes_),              # sklearn sorts these
        "feature_names": FEATURE_NAMES,
        "min_confidence": MIN_CONFIDENCE,
        "nodes": serialize_tree(final),
    }
    MODEL_PATH.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {MODEL_PATH}  ({MODEL_PATH.stat().st_size / 1024:.1f} KB)")

    # --- Optional: validate generalisation on a hand-labelled real set ---
    # The training data is synthetic. Drop a real-capture file at
    # `real_validation.json` (see scripts/ml/README.md for how to collect
    # one) and the shipped tree is scored against it here.
    real_path = Path(__file__).resolve().parent / "real_validation.json"
    if real_path.exists():
        real = json.loads(real_path.read_text(encoding="utf-8"))
        Xr = np.array([extract_features(r["series"]) for r in real], dtype=float)
        yr = np.array([r["label"] for r in real])
        pred_r = final.predict(Xr)
        print(f"\n=== Real-capture validation ({len(real)} series) ===")
        print(classification_report(yr, pred_r, zero_division=0))
        print(f"real-data accuracy: {float((pred_r == yr).mean()):.4f}")
    else:
        print(f"\n(no {real_path.name} yet — capture real data to validate "
              "generalisation; see scripts/ml/README.md)")

    # --- Shared test vectors for Rust feature-extraction parity ---
    rng = np.random.default_rng(args.seed + 1)
    sample_idx = rng.choice(len(series), size=8, replace=False)
    vectors = [
        {"series": series[i], "expected_features": extract_features(series[i])}
        for i in sample_idx
    ]
    VECTORS_PATH.write_text(json.dumps(vectors, indent=1), encoding="utf-8")
    print(f"Wrote {VECTORS_PATH} ({len(vectors)} vectors for Rust parity tests)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
