# Bring-your-own Ollama

TaskManager+ ships a small bundled generative model (Qwen2.5-0.5B) for
features like Smart Rename, file/folder summaries, and "what's in this
folder?" That model runs entirely on the local machine — CPU by default,
GPU via the Vulkan bundle when installed.

**Z3** adds a third backend: point TaskManager+ at a local
[Ollama](https://ollama.com) server and use any model you've pulled
through Ollama. Useful when you want something larger or more capable
than 0.5 B parameters without us having to ship multiple bundled
models.

The bundled model and the Vulkan accelerator are unchanged — Ollama is
an alternative, not a replacement. Pick the one you want from Settings.

## Setup

1. **Install Ollama.** From [ollama.com/download](https://ollama.com/download).
   The Windows installer puts an `ollama` CLI on PATH and starts a
   background server on `http://localhost:11434`.
2. **Pull a model.** Anything Ollama supports works. Some reasonable
   starting points:
   ```
   ollama pull llama3.2          # ~2 GB, good general-purpose default
   ollama pull qwen2.5:3b        # ~2 GB, strong instruction-following
   ollama pull phi3:mini         # ~2.3 GB, decent for short prompts
   ```
   Pick something that fits your RAM headroom — generation on a model
   that swaps to disk is painful.
3. **Point TaskManager+ at it.** Open **Settings → AI Writing
   Acceleration**, pick the **"Use a local Ollama instance"** radio.
   Two new fields appear:
   * **Base URL** — defaults to `http://localhost:11434` (the Ollama
     install default). Change it only if you've moved the server to a
     different port or host.
   * **Model name** — whatever you pulled in step 2 (`llama3.2`,
     `qwen2.5:3b`, …). Without a `:tag` suffix we treat it as the
     base name and match the installed `:latest`.
4. **Hit "Test connection".** This calls Ollama's `/api/tags` and
   shows the installed models. Use the list to confirm the name you
   typed matches what Ollama has — typos are the #1 cause of "model
   not installed" errors at generation time.
5. **Restart TaskManager+.** The active backend is cached per process
   for the same reason the CPU and Vulkan paths are — flipping
   without a restart leaves the previous one loaded. After the
   restart, any feature that uses the writing model routes through
   Ollama.

## Privacy contract

The bundled CPU and Vulkan backends make zero network calls. Ever.
**The Ollama backend is the only path in the AI subsystem that opens a
socket**, and it only runs when:

* the user has selected "Ollama" in Settings, AND
* the user has set a base URL.

Default URL is loopback (`http://localhost:11434`) — the request stays
on the device. If you point the URL at a LAN host or a remote server,
your prompts and the extracted file content fed into them go to that
host. The Settings card spells this out next to the URL field; we
don't hide the boundary.

## Trade-offs vs the bundled model

| | Bundled Qwen2.5-0.5B | Ollama (your model) |
| --- | --- | --- |
| **Install size** | ~400 MB (CPU) + ~63 MB Vulkan bundle (optional) | None on our side — Ollama + the model live elsewhere |
| **Setup** | Tier toggle in Settings | Install Ollama + `ollama pull` + paste URL + model name |
| **First-token latency** | Fast (model preloaded, in-process) | HTTP round-trip + Ollama's own load time |
| **Quality ceiling** | Limited by 0.5 B parameters | As good as the model you pulled |
| **Privacy** | Never leaves the device | Leaves the device iff you point at a non-loopback URL |
| **Network calls** | None | One `/api/chat` POST per generation |
| **Failure mode if Ollama is down** | n/a — model is in-process | The next generation returns an actionable error from the dispatcher |

The dispatcher does **not** silently fall back from Ollama to CPU when
Ollama is unreachable — you explicitly picked Ollama, and a silent
fallback would hide that your selected backend is broken. The error
surfaces in whatever UI triggered the generation.

## Troubleshooting

* **"Ollama not reachable at http://localhost:11434"** — Ollama
  isn't running. Open a terminal and run `ollama serve`, or restart
  Ollama if it crashed.
* **"Model '<name>' not installed on Ollama"** — the name doesn't
  match anything in `ollama list`. The error message includes the
  installed list — copy a name from there into the Settings field.
* **Generations time out at 5 minutes** — that's our hard upper bound
  in the HTTP client. You're either generating very long output or
  running on a model that exceeds your RAM and is swapping to disk.
  Pick a smaller model or trim the prompt.
* **"Running on: not yet loaded" stays forever after the first
  Smart Rename** — the runtime status updates on the next
  poll-and-refresh; the inference itself ran successfully through
  Ollama, the UI just hasn't repolled.

## What we don't expose (and why)

* **OpenAI-compatible endpoints**, **Together**, **Groq**, etc. —
  Ollama gives us a single localhost-by-default story we can describe
  in one sentence. The moment we add "or paste any OpenAI-compatible
  URL," the privacy contract becomes "trust whatever the user typed."
  Out of scope for v2.2; reconsider after Ollama support is real-world
  validated.
* **Streaming tokens** — Ollama supports `stream: true`, but the
  bundled CPU and Vulkan paths don't stream, so the dispatcher's
  generate-once contract is `Result<String, _>`. Adding streaming
  would need a refactor across all three backends. Deferred.
* **Bundled multi-model picker** — we'd have to ship and host every
  variant. Ollama already does that better.
