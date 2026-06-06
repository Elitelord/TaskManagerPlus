//! Z3 — BYO Ollama generative backend.
//!
//! Lets users plug their own Ollama instance into TaskManager+ instead of
//! the bundled Qwen2.5-0.5B model. Off the table: shipping multiple
//! models ourselves (storage cost), wiring up an OpenAI-compatible client
//! against arbitrary services (privacy). On the table: a localhost-only
//! HTTP path that talks to whatever the user already has running.
//!
//! Privacy contract:
//!   * This is the only module in the AI subsystem that makes network
//!     calls. It runs ONLY when the user has explicitly selected the
//!     Ollama backend in Settings AND set a base URL.
//!   * The default base URL is `http://localhost:11434` (the Ollama
//!     install default — loopback, stays on the device).
//!   * The user can point at a non-loopback host on their LAN. We
//!     surface the actual URL in the UI so it's never a surprise.
//!
//! Wire format: Ollama's `/api/chat` with `stream: false`. Single
//! request/response per `generate` call — no streaming, no SSE parsing.
//! Tradeoff: the user waits the full generation duration before seeing
//! anything. We accept that because the alternative (streaming partial
//! tokens up through the dispatcher) would force the CPU and Vulkan
//! paths to also stream, which is out of scope.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::genlm::Turn;

/// Default Ollama base URL — what `ollama serve` listens on out of the
/// box. Users can override in Settings.
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// Default model the UI suggests if the user hasn't picked one yet.
/// Picked because it's small (~2 GB), reasonably capable for
/// instruction-following, and what Ollama itself recommends for new
/// users. The user is expected to override this once they've decided
/// what they want.
pub const DEFAULT_MODEL: &str = "llama3.2";

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
    /// Ollama-specific knobs we forward; `max_tokens` maps to `num_predict`.
    options: ChatOptions,
}

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct ChatOptions {
    num_predict: i32,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OllamaModelInfo {
    pub name: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<OllamaModelInfo>,
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

/// Probe the Ollama server and return the list of locally-installed
/// models. Used both for `ensure_loaded` (verify the configured model
/// exists) and for the Settings "Test connection" button.
pub fn list_installed_models(base_url: &str) -> Result<Vec<OllamaModelInfo>, String> {
    let client = http_client(Duration::from_secs(10))?;
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("Ollama not reachable at {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Ollama returned HTTP {} when listing models",
            resp.status()
        ));
    }
    // reqwest's `.json()` requires the `json` cargo feature; we keep the
    // dep slim and parse manually.
    let bytes = resp
        .bytes()
        .map_err(|e| format!("read /api/tags body: {e}"))?;
    let parsed: TagsResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse /api/tags response: {e}"))?;
    Ok(parsed.models)
}

/// Verify the configured Ollama server is reachable and the model name
/// matches one of the installed models. Mirrors the contract of the CPU
/// and Vulkan backends: returns `Ok` if a subsequent `generate` call has
/// the inputs it needs; returns `Err` with an actionable message otherwise.
pub fn ensure_loaded(base_url: &str, model: &str) -> Result<(), String> {
    if base_url.is_empty() {
        return Err("Ollama backend selected but no base URL is set in Settings.".into());
    }
    if model.is_empty() {
        return Err("Ollama backend selected but no model name is set in Settings.".into());
    }
    let installed = list_installed_models(base_url)?;
    // Ollama tags include the version suffix (`:latest`, `:7b-q4_0`),
    // so a user typing "llama3.2" should match "llama3.2:latest" —
    // strip the suffix on both sides before comparing.
    let want = model.split(':').next().unwrap_or(model);
    let found = installed
        .iter()
        .any(|m| m.name.split(':').next().unwrap_or(&m.name) == want);
    if !found {
        let available: Vec<String> = installed.into_iter().map(|m| m.name).collect();
        return Err(format!(
            "Model '{model}' not installed on Ollama. Installed models: {}. \
             Run `ollama pull {model}` and try again.",
            if available.is_empty() {
                "none".to_string()
            } else {
                available.join(", ")
            },
        ));
    }
    Ok(())
}

/// Run a chat completion against Ollama. Blocking — runs on the existing
/// `spawn_blocking` path the rest of genlm uses. Generation timeout is
/// generous (5 min) because the user picks the model; slower models or
/// larger contexts can legitimately take a while.
pub fn generate(
    base_url: &str,
    model: &str,
    turns: &[Turn],
    max_tokens: i32,
) -> Result<String, String> {
    let client = http_client(Duration::from_secs(300))?;
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let messages: Vec<ChatMessage> = turns
        .iter()
        .map(|t| ChatMessage {
            role: t.role.as_str(),
            content: t.content.as_str(),
        })
        .collect();
    let body = ChatRequest {
        model,
        messages,
        stream: false,
        options: ChatOptions {
            num_predict: max_tokens,
        },
    };
    let body_bytes =
        serde_json::to_vec(&body).map_err(|e| format!("serialize /api/chat body: {e}"))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body_bytes)
        .send()
        .map_err(|e| format!("Ollama chat request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("Ollama returned HTTP {status}: {text}"));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| format!("read /api/chat body: {e}"))?;
    let parsed: ChatResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse /api/chat response: {e}"))?;
    Ok(parsed.message.content.trim().to_string())
}
