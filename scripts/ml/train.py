"""Train the I3 process-category classifier and export ONNX.

Architecture: a tiny scikit-learn pipeline:

    TfidfVectorizer(analyzer='char_wb', ngram_range=(2,5))
        -> LogisticRegression(class_weight='balanced', solver='lbfgs')

Char n-grams capture the patterns that matter on short exe strings —
substring matches (``chrome`` inside ``chromedriver.exe``), shared suffixes
(``-win64-shipping``), and vendor prefixes (``msedge``, ``adobe``). The
classifier is small (~200-800 KB ONNX), fast (<1 ms inference on CPU), and
deterministic.

The vectorizer learns a fixed char-ngram vocabulary from the training set.
Exe names never seen during training still classify reasonably because
they share n-grams with names that were seen (``obsidian-helper.exe`` and
``obsidian.exe`` overlap heavily) — which is the point of a classifier
over a plain regex lookup. (HashingVectorizer would avoid the fixed vocab
entirely but skl2onnx has no ONNX converter for it.)

Outputs:
    scripts/ml/out/process_classifier.onnx
    scripts/ml/out/process_classifier_meta.json   (category index + thresholds)

Usage:
    python scripts/ml/train.py [--seed N]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline


ROOT = Path(__file__).resolve().parents[2]
ML_DIR = ROOT / "scripts" / "ml"
DATA_PATH = ML_DIR / "data" / "labeled.csv"
OUT_DIR = ML_DIR / "out"
MODEL_PATH = OUT_DIR / "process_classifier.json"

# Hyperparameters — tuned conservatively. Char n-grams 2-5 are enough to
# pick up vendor / suffix patterns on short exe strings.
NGRAM_RANGE = (2, 5)
TEST_SIZE = 0.2


def load_dataset() -> tuple[list[str], list[str]]:
    if not DATA_PATH.exists():
        sys.exit(f"error: {DATA_PATH} not found — run curate.py first")
    names: list[str] = []
    labels: list[str] = []
    with DATA_PATH.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            name = row.get("name", "").strip().lower()
            label = row.get("label", "").strip().lower()
            if name and label:
                names.append(name)
                labels.append(label)
    if not names:
        sys.exit(f"error: {DATA_PATH} is empty")
    return names, labels


def build_pipeline() -> Pipeline:
    return Pipeline([
        ("vec", TfidfVectorizer(
            analyzer="char_wb",
            ngram_range=NGRAM_RANGE,
            min_df=1,            # keep every n-gram — the dataset is small
            sublinear_tf=True,   # damps repeated n-grams in long exe names
            lowercase=True,
        )),
        ("clf", LogisticRegression(
            max_iter=4000,
            class_weight="balanced",
            # lbfgs handles native multinomial multiclass and is
            # deterministic. (liblinear dropped multiclass support in
            # scikit-learn 1.8.) 4000 iters gives lbfgs room to fully
            # converge on the sparse 65k-feature hashing space.
            solver="lbfgs",
        )),
    ])


def export_weights(pipeline: Pipeline, classes: list[str]) -> None:
    """Export the trained pipeline as a plain-JSON weights file.

    For a linear model (TF-IDF + logistic regression) there is no need for
    ONNX Runtime — the whole model is a vocabulary, an IDF vector, a
    coefficient matrix, and an intercept vector. The Rust side replicates
    the (deterministic, simple) char-ngram TF-IDF transform and does one
    matmul. This keeps the Lite tier dependency-free and the model file
    tiny and auditable. See `docs/AI_INTEGRATION_PLAN.md` §3.

    The Rust loader (`src-tauri/src/ai/classifiers/process_category.rs`)
    must stay in lockstep with the transform described by these fields:
      - char_wb n-gram extraction, ngram_range
      - term frequency, sublinear (tf = 1 + ln(count))
      - multiply by idf
      - L2-normalize the feature vector
      - scores = coef @ x + intercept ; softmax ; argmax
    """
    vec: TfidfVectorizer = pipeline.named_steps["vec"]
    clf: LogisticRegression = pipeline.named_steps["clf"]

    # vocabulary_: {ngram: index}. idf_: array indexed by feature index.
    vocab = vec.vocabulary_
    idf = vec.idf_.tolist()

    # coef_ is [n_classes, n_features]; intercept_ is [n_classes].
    coef = clf.coef_.astype(float).tolist()
    intercept = clf.intercept_.astype(float).tolist()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": "process_classifier",
        "version": 1,
        # Class order matches the rows of `coef` / entries of `intercept`.
        "classes": classes,
        "ngram_range": list(NGRAM_RANGE),
        "analyzer": "char_wb",
        "sublinear_tf": True,
        "norm": "l2",
        "lowercase": True,
        "min_confidence": 0.40,  # below this, the Rust side returns "no prediction"
        # Transform parameters.
        "vocabulary": vocab,           # {ngram: feature_index}
        "idf": idf,                    # [n_features]
        # Classifier parameters.
        "coef": coef,                  # [n_classes][n_features]
        "intercept": intercept,        # [n_classes]
    }
    MODEL_PATH.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for the train/test split")
    args = parser.parse_args()

    names, labels = load_dataset()
    print(f"Loaded {len(names)} examples across {len(set(labels))} classes.")

    # Stratified split so every class shows up in both train and test.
    X_train, X_test, y_train, y_test = train_test_split(
        names,
        labels,
        test_size=TEST_SIZE,
        random_state=args.seed,
        stratify=labels,
    )
    print(f"Train: {len(X_train)}   Test: {len(X_test)}")

    pipeline = build_pipeline()
    pipeline.fit(X_train, y_train)

    y_pred = pipeline.predict(X_test)
    print("\nClassification report:")
    print(classification_report(y_test, y_pred, zero_division=0))

    print("Confusion matrix (rows=true, cols=pred):")
    classes = sorted(set(labels))
    cm = confusion_matrix(y_test, y_pred, labels=classes)
    header = "                 " + " ".join(f"{c[:8]:>8s}" for c in classes)
    print(header)
    for cls, row in zip(classes, cm):
        cells = " ".join(f"{v:>8d}" for v in row)
        print(f"  {cls[:14]:14s} {cells}")

    # Export the model as plain-JSON weights for the pure-Rust loader.
    print("\nExporting weights...")
    export_weights(pipeline, classes=list(pipeline.classes_))
    size_kb = MODEL_PATH.stat().st_size / 1024
    print(f"Wrote {MODEL_PATH}  ({size_kb:.1f} KB)")

    # Quick sanity inference on a handful of canonical inputs so the
    # operator can eyeball the result without spinning up Rust.
    samples = [
        "chrome.exe", "code.exe", "valorant-win64-shipping.exe",
        "svchost.exe", "discord.exe", "photoshop.exe",
        "obviously-not-a-real-app.exe",
    ]
    probs = pipeline.predict_proba(samples)
    preds = pipeline.classes_[np.argmax(probs, axis=1)]
    confs = probs.max(axis=1)
    print("\nSpot-check:")
    for name, label, conf in zip(samples, preds, confs):
        print(f"  {name:42s} -> {label:14s} ({conf*100:5.1f}%)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
