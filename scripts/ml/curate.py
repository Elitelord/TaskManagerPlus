"""Build the training CSV from the curated seed dataset.

DESIGN — read this before changing anything:

The training set is built **only from the curated seed JSON**, which is
hand-labeled, correct, and not tied to any single machine. We deliberately
do NOT auto-label machine-walked exe names, because defaulting unknown
walked entries to ``other`` would actively mislabel training data — a game
or browser you have installed that isn't in the seed would teach the model
that a real game is ``other``, poisoning it.

Walked names (from ``walk_program_files.ps1``) are instead written to
``review_candidates.csv`` with a blank label column. They are NOT training
data until a human fills in a correct label. On the next run, any
``review_candidates.csv`` row that has a non-empty, valid label is merged
into the training set; rows still blank stay pending. This makes
"train on machine data" an explicit, manually-reviewed opt-in.

Usage:
    python scripts/ml/curate.py
        Reads:
          scripts/ml/data/seed_processes.json   (required — the gold set)
          scripts/ml/data/walked_processes.txt  (optional — review candidates)
          scripts/ml/data/review_candidates.csv (optional — prior manual labels)
        Writes:
          scripts/ml/data/labeled.csv           (training set: seed + reviewed)
          scripts/ml/data/review_candidates.csv  (walked names pending review)

CSV columns:
  labeled.csv            -> name,label,source     (source: seed | reviewed)
  review_candidates.csv  -> name,label            (label blank = pending)
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ML_DIR = ROOT / "scripts" / "ml"
DATA_DIR = ML_DIR / "data"

SEED_PATH = DATA_DIR / "seed_processes.json"
WALK_PATH = DATA_DIR / "walked_processes.txt"
REVIEW_PATH = DATA_DIR / "review_candidates.csv"
OUT_PATH = DATA_DIR / "labeled.csv"

VALID_LABELS = {
    "gaming", "editing", "development", "browsing",
    "communication", "office", "streaming", "system", "other",
}


def load_seed() -> dict[str, str]:
    """Return ``{name: label}`` from the seed JSON. Names lowercased."""
    if not SEED_PATH.exists():
        sys.exit(f"error: missing {SEED_PATH}")
    with SEED_PATH.open(encoding="utf-8") as f:
        raw = json.load(f)
    labeled: dict[str, str] = {}
    conflicts: list[tuple[str, str, str]] = []
    for label, names in raw.items():
        if label.startswith("_"):
            continue
        if label not in VALID_LABELS:
            sys.exit(f"error: seed contains unknown category {label!r}")
        for n in names:
            key = n.strip().lower()
            if not key:
                continue
            if key in labeled and labeled[key] != label:
                conflicts.append((key, labeled[key], label))
            labeled[key] = label
    if conflicts:
        print("warning: seed has conflicting labels for the same name:")
        for name, a, b in conflicts:
            print(f"  {name!r}: {a!r} vs {b!r} (last wins)")
    return labeled


def load_walked() -> list[str]:
    if not WALK_PATH.exists():
        return []
    out: list[str] = []
    for line in WALK_PATH.read_text(encoding="utf-8").splitlines():
        s = line.strip().lower()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def load_review() -> dict[str, str]:
    """Return ``{name: label}`` from review_candidates.csv. Blank labels are
    skipped. Invalid labels abort with an error so typos don't silently
    poison the training set."""
    if not REVIEW_PATH.exists():
        return {}
    out: dict[str, str] = {}
    with REVIEW_PATH.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            name = row.get("name", "").strip().lower()
            label = row.get("label", "").strip().lower()
            if not name:
                continue
            if not label:
                continue  # still pending review
            if label not in VALID_LABELS:
                sys.exit(
                    f"error: review_candidates.csv has invalid label "
                    f"{label!r} for {name!r}. Valid: {sorted(VALID_LABELS)}"
                )
            out[name] = label
    return out


def main() -> int:
    seed = load_seed()
    walked = load_walked()
    reviewed = load_review()

    # --- Training set: seed + manually-reviewed walked entries only. ---
    rows: list[tuple[str, str, str]] = []
    for name, label in seed.items():
        rows.append((name, label, "seed"))
    for name, label in reviewed.items():
        if name in seed:
            continue  # seed wins; don't double-count
        rows.append((name, label, "reviewed"))
    rows.sort(key=lambda r: (r[1], r[0]))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["name", "label", "source"])
        w.writerows(rows)

    # --- Review queue: walked names not in seed and not yet reviewed. ---
    # Preserve any labels already present in review_candidates.csv so a
    # re-run doesn't wipe manual work.
    pending: list[tuple[str, str]] = []
    known = set(seed)
    for name in sorted(set(walked)):
        if name in known:
            continue
        pending.append((name, reviewed.get(name, "")))
    if pending:
        with REVIEW_PATH.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(["name", "label"])
            w.writerows(pending)

    # --- Report ---
    tally: dict[str, int] = {}
    for _, label, _ in rows:
        tally[label] = tally.get(label, 0) + 1
    print(f"Training set: {len(rows)} rows -> {OUT_PATH}")
    print(f"  (seed: {len(seed)}, manually reviewed: {len(rows) - len(seed)})")
    print("\nLabel distribution:")
    for label in sorted(tally, key=lambda k: -tally[k]):
        print(f"  {label:14s} {tally[label]:5d}")

    if pending:
        unlabeled = sum(1 for _, lbl in pending if not lbl)
        print(
            f"\n{len(pending)} walked exe names written to {REVIEW_PATH.name} "
            f"({unlabeled} unlabeled)."
        )
        print(
            "  These are NOT in the training set. To use any of them, open "
            "the file,\n  fill the 'label' column with a valid category, and "
            "re-run curate.py."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
