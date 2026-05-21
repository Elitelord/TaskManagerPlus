//! Text embedding runtime (Phase 3 / S4) — pure-Rust ONNX inference via
//! `tract`, tokenised with the Hugging Face `tokenizers` crate.
//!
//! Engine: `tract` over ONNX Runtime — see spike S-12. Pure Rust, no
//! native library, no prerelease dependency; runs the 33 MB int8-quantized
//! `bge-small-en-v1.5` model the embedding spike validated (ARI 0.822 on
//! real labelled data — S-11).
//!
//! The model + tokenizer download on demand (`model_download.rs`) into the
//! app-local models directory. This module loads + optimises them lazily
//! on first use and caches the result — the load is seconds-slow, the
//! per-text embed is fast enough for a background pass.

use std::path::Path;
use std::sync::Mutex;

use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

/// File names of the embedding model under the models directory.
pub const MODEL_FILE: &str = "bge-small-en-v1.5.onnx";
pub const TOKENIZER_FILE: &str = "bge-small-en-v1.5.tokenizer.json";

/// Longest token sequence embedded. A document's opening past this adds
/// little signal and costs inference time.
const MAX_TOKENS: usize = 256;

/// A loaded embedding model — the optimised `tract` graph plus its
/// tokenizer and the model's declared input order.
pub struct Embedder {
    model: TypedRunnableModel<TypedModel>,
    tokenizer: Tokenizer,
    /// Input node names, in the order the model expects them — used to
    /// route input_ids / attention_mask / token_type_ids correctly, since
    /// `tract`'s `run` takes positional inputs.
    input_names: Vec<String>,
}

impl Embedder {
    /// Load and optimise the ONNX model and its tokenizer. Slow (seconds);
    /// call once and cache. Per the S-12 probe, the model's dimensions are
    /// left symbolic — pinning them trips tract's shape inference on this
    /// BERT graph; concrete shapes are supplied per-call at `run` time.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let infer = tract_onnx::onnx()
            .model_for_path(model_path)
            .map_err(|e| format!("load model: {e}"))?;
        let input_names: Vec<String> = infer
            .inputs
            .iter()
            .map(|o| infer.node(o.node).name.clone())
            .collect();
        let model = infer
            .into_optimized()
            .map_err(|e| format!("optimize model: {e}"))?
            .into_runnable()
            .map_err(|e| format!("ready model: {e}"))?;

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("load tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| format!("configure tokenizer: {e}"))?;

        Ok(Self { model, tokenizer, input_names })
    }

    /// Embed one text into a mean-pooled, L2-normalised vector. Mirrors the
    /// validated Python spike: one text per forward pass (no batch padding),
    /// mean-pool over non-pad tokens, normalise.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| format!("tokenize: {e}"))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let seq = ids.len();
        if seq == 0 {
            return Err("empty tokenization".into());
        }
        let types: Vec<i64> = vec![0; seq];

        // Positional inputs, routed to the model's declared input order.
        let mut inputs: TVec<TValue> = tvec!();
        for name in &self.input_names {
            let lname = name.to_lowercase();
            let data: &[i64] = if lname.contains("mask") {
                &mask
            } else if lname.contains("type") {
                &types
            } else {
                &ids // input_ids — the default
            };
            let tensor = Tensor::from_shape(&[1, seq], data)
                .map_err(|e| format!("build input tensor: {e}"))?;
            inputs.push(tensor.into());
        }

        let out = self
            .model
            .run(inputs)
            .map_err(|e| format!("inference: {e}"))?;
        let shape = out[0].shape().to_vec(); // [1, seq, hidden]
        if shape.len() != 3 {
            return Err(format!("unexpected output shape {shape:?}"));
        }
        let hidden = shape[2];
        let data = out[0]
            .as_slice::<f32>()
            .map_err(|e| format!("read output: {e}"))?;

        // Mean-pool over non-pad tokens, then L2-normalise.
        let mut pooled = vec![0f32; hidden];
        let mut n = 0f32;
        for t in 0..seq {
            if mask[t] == 0 {
                continue;
            }
            n += 1.0;
            let base = t * hidden;
            for d in 0..hidden {
                pooled[d] += data[base + d];
            }
        }
        if n > 0.0 {
            for x in &mut pooled {
                *x /= n;
            }
        }
        let norm = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 1e-9 {
            for x in &mut pooled {
                *x /= norm;
            }
        }
        Ok(pooled)
    }
}

/// Process-wide cache of the loaded embedder — the model load is far too
/// slow to repeat per call.
static EMBEDDER: Mutex<Option<Embedder>> = Mutex::new(None);

/// Embed `texts` with the model in `models_dir`, loading and caching it on
/// first use. Returns one vector per input text. Blocking — call from a
/// worker thread.
pub fn embed_texts(models_dir: &Path, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let mut guard = EMBEDDER.lock().map_err(|_| "embedder lock poisoned")?;
    if guard.is_none() {
        let model_path = models_dir.join(MODEL_FILE);
        let tok_path = models_dir.join(TOKENIZER_FILE);
        if !model_path.exists() || !tok_path.exists() {
            return Err("embedding model not installed — download it first".into());
        }
        *guard = Some(Embedder::load(&model_path, &tok_path)?);
    }
    let embedder = guard.as_ref().expect("embedder just set");
    texts.iter().map(|t| embedder.embed(t)).collect()
}
