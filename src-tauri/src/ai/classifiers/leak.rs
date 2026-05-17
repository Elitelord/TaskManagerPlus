//! I1 — memory leak vs. cache-warmup classifier.
//!
//! Tells a genuine memory leak apart from benign growth (cache warmup,
//! startup spike, steady). Given a per-process memory series it extracts 8
//! features and runs them through a small decision tree.
//!
//! The model is a depth-5 decision tree trained by
//! `scripts/ml/leak_classifier/train.py` and bundled as JSON
//! (`src-tauri/models/leak_classifier.json`, ~3 KB) — embedded into the
//! binary at compile time, so there is no runtime model file to ship.
//!
//! FEATURE EXTRACTION IS A CONTRACT. `extract_features` below must stay
//! bit-for-bit equivalent to `scripts/ml/leak_classifier/features.py`. The
//! parity test at the bottom checks it against `test_vectors.json`, which
//! `train.py` regenerates. Changing one without the other will silently
//! corrupt classification.

use serde::Deserialize;
use std::sync::OnceLock;

const EPS: f64 = 1e-9;
const SAMPLES_PER_MIN: f64 = 60.0;
/// Series shorter than this can't be classified meaningfully — callers
/// (the leak detector) already require far more history than this.
const MIN_SAMPLES: usize = 30;

/// Bundled model JSON, embedded at compile time.
const MODEL_JSON: &str = include_str!("../../../models/leak_classifier.json");

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(untagged)]
enum TreeNode {
    /// Leaf — class-probability distribution, indexed like `LeakModel::classes`.
    Leaf { leaf: Vec<f64> },
    /// Internal — go left when `x[f] <= t`, else right. `l`/`r` are node indices.
    Internal { f: usize, t: f64, l: usize, r: usize },
}

#[derive(Deserialize)]
struct LeakModel {
    classes: Vec<String>,
    #[allow(dead_code)] // feature order is the contract; names are informational
    feature_names: Vec<String>,
    min_confidence: f64,
    nodes: Vec<TreeNode>,
}

fn model() -> Option<&'static LeakModel> {
    static MODEL: OnceLock<Option<LeakModel>> = OnceLock::new();
    MODEL
        .get_or_init(|| match serde_json::from_str::<LeakModel>(MODEL_JSON) {
            Ok(m) => Some(m),
            Err(e) => {
                log::error!("leak classifier: failed to parse bundled model: {e}");
                None
            }
        })
        .as_ref()
}

/// A classification verdict. `None` from `classify` means "no verdict" —
/// the series was too short, or the tree's leaf was below `min_confidence`.
pub struct LeakVerdict {
    pub class: String,
    pub confidence: f32,
}

// ---------------------------------------------------------------------------
// Feature extraction — MIRROR of scripts/ml/leak_classifier/features.py
// ---------------------------------------------------------------------------

/// Least-squares fit of `values` against x = 0,1,2,...  Returns
/// (slope_per_sample, r2). Mirrors `_linfit` in features.py.
fn linfit(values: &[f64]) -> (f64, f64) {
    let n = values.len();
    if n < 2 {
        return (0.0, 0.0);
    }
    let nf = n as f64;
    let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
    for (i, &y) in values.iter().enumerate() {
        let x = i as f64;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    let denom = nf * sxx - sx * sx;
    if denom.abs() < EPS {
        return (0.0, 0.0);
    }
    let slope = (nf * sxy - sx * sy) / denom;
    let intercept = (sy - slope * sx) / nf;
    let mean = sy / nf;
    let (mut ss_tot, mut ss_res) = (0.0, 0.0);
    for (i, &y) in values.iter().enumerate() {
        let x = i as f64;
        ss_tot += (y - mean) * (y - mean);
        let resid = y - (slope * x + intercept);
        ss_res += resid * resid;
    }
    let mut r2 = if ss_tot > EPS { 1.0 - ss_res / ss_tot } else { 0.0 };
    if r2 < 0.0 {
        r2 = 0.0;
    }
    (slope, r2)
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Extract the 8-feature vector from a memory series. Mirrors
/// `extract_features` in features.py — see the module-level CONTRACT note.
fn extract_features(series: &[f64]) -> [f64; 8] {
    let n = series.len();
    if n < 2 {
        return [0.0; 8];
    }
    let first = series[0];
    let last = series[n - 1];
    let total_growth = last - first;

    // 0,1 — whole-window linear fit.
    let (slope_ps, r2) = linfit(series);
    let slope_mb_min = slope_ps * SAMPLES_PER_MIN;

    // 2 — slope decay across thirds.
    let third = (n / 3).max(2);
    let (first_slope, _) = linfit(&series[..third]);
    let (last_slope, _) = linfit(&series[n - third..]);
    let denom = first_slope.abs() + last_slope.abs() + EPS;
    let slope_decay = clamp((first_slope - last_slope) / denom, -1.0, 1.0);

    // 3 — curvature: smoothed mid-sample vs the endpoint chord.
    let mid = n / 2;
    let lo = mid.saturating_sub(2);
    let hi = (mid + 3).min(n);
    let mid_smooth = series[lo..hi].iter().sum::<f64>() / (hi - lo) as f64;
    let chord_mid = (first + last) / 2.0;
    let rng = total_growth.abs() + EPS;
    let curvature = clamp((mid_smooth - chord_mid) / rng, -1.5, 1.5);

    // 4 — share of total growth in the first half.
    let first_half_growth = series[mid] - first;
    let first_half_share = if total_growth.abs() > 1.0 {
        clamp(first_half_growth / total_growth, -1.0, 2.0)
    } else {
        0.5
    };

    // 5 — slope of the final 20% of the window.
    let tail_len = (n / 5).max(5);
    let (tail_slope_ps, _) = linfit(&series[n - tail_len..]);
    let tail_slope_mb_min = tail_slope_ps * SAMPLES_PER_MIN;

    // 7 — largest single-sample increase.
    let mut max_step = 0.0_f64;
    for i in 1..n {
        let step = series[i] - series[i - 1];
        if step > max_step {
            max_step = step;
        }
    }

    [
        slope_mb_min,
        r2,
        slope_decay,
        curvature,
        first_half_share,
        tail_slope_mb_min,
        total_growth,
        max_step,
    ]
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Classify a per-process memory series (MB samples, ~1 Hz, oldest first).
/// Returns `None` when the series is too short or the model is unsure.
pub fn classify(series: &[f32]) -> Option<LeakVerdict> {
    if series.len() < MIN_SAMPLES {
        return None;
    }
    let model = model()?;
    let s: Vec<f64> = series.iter().map(|&v| v as f64).collect();
    let feats = extract_features(&s);

    // Walk the tree from the root. The iteration cap is a guard against a
    // malformed model causing an infinite loop — a valid tree terminates
    // in far fewer steps than its node count.
    let mut idx = 0usize;
    for _ in 0..model.nodes.len() + 1 {
        match model.nodes.get(idx)? {
            TreeNode::Leaf { leaf } => {
                let (best, &prob) = leaf
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
                if prob < model.min_confidence {
                    return None; // leaf too impure — no confident verdict
                }
                let class = model.classes.get(best)?.clone();
                return Some(LeakVerdict { class, confidence: prob as f32 });
            }
            TreeNode::Internal { f, t, l, r } => {
                let x = *feats.get(*f)?;
                idx = if x <= *t { *l } else { *r };
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct TestVector {
        series: Vec<f64>,
        expected_features: Vec<f64>,
    }

    /// Feature-extraction parity: the Rust `extract_features` must produce
    /// the same vectors as the Python `features.py` that trained the model.
    /// `test_vectors.json` is regenerated by `train.py`.
    #[test]
    fn feature_extraction_matches_python() {
        const VECTORS: &str =
            include_str!("../../../../scripts/ml/leak_classifier/test_vectors.json");
        let vectors: Vec<TestVector> =
            serde_json::from_str(VECTORS).expect("parse test_vectors.json");
        assert!(!vectors.is_empty(), "no test vectors");
        for (vi, v) in vectors.iter().enumerate() {
            let got = extract_features(&v.series);
            assert_eq!(v.expected_features.len(), 8);
            for k in 0..8 {
                let diff = (got[k] - v.expected_features[k]).abs();
                assert!(
                    diff < 1e-6,
                    "vector {vi} feature {k}: rust={} python={} (diff {diff})",
                    got[k],
                    v.expected_features[k],
                );
            }
        }
    }

    #[test]
    fn bundled_model_parses() {
        assert!(model().is_some(), "bundled leak model failed to parse");
    }

    #[test]
    fn classifies_a_clear_linear_leak() {
        // ~6 MB/min steady linear growth over 120 samples.
        let series: Vec<f32> = (0..120).map(|i| 100.0 + 0.1 * i as f32).collect();
        let v = classify(&series).expect("should produce a verdict");
        assert_eq!(v.class, "leak");
    }

    #[test]
    fn classifies_a_cache_warmup() {
        // Saturating-exponential growth that plateaus inside the window.
        let series: Vec<f32> = (0..120)
            .map(|i| 100.0 + 200.0 * (1.0 - (-(i as f32) / 20.0).exp()))
            .collect();
        let v = classify(&series).expect("should produce a verdict");
        assert_eq!(v.class, "cache-warmup");
    }

    #[test]
    fn rejects_a_too_short_series() {
        let series: Vec<f32> = (0..10).map(|i| 100.0 + i as f32).collect();
        assert!(classify(&series).is_none());
    }
}
