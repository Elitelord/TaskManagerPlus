# DirectML embedding acceleration

The embedding model (`bge-small-en-v1.5`) powers TaskManager+'s
semantic file features:

* "Find files about X" intent search
* Folder content clustering during Storage scans
* The `find_files_by_intent` MCP tool
* Smart Organizer's "similar files" grouping

It runs on CPU by default via [tract](https://github.com/sonos/tract),
which is reliable and zero-dependency but capped by single-thread
inference performance per text. **Z4** adds an opt-in path that runs
the same model through ONNX Runtime on the GPU via the DirectML
execution provider — 5–10× faster on a modern GPU, which matters when
you're embedding tens of thousands of files in a Storage scan.

The CPU path is unchanged. DirectML is a runtime swap, opt-in, and
controlled separately from the generative LM's GPU acceleration.

## When this helps

* **Big scans.** Embedding 50k files on CPU takes minutes;
  DirectML brings it to tens of seconds on a modern GPU.
* **Tight refresh loops.** When you're iterating on intent searches
  and the cache is cold for new files, DirectML keeps the latency
  low enough that the UX stays interactive.

## When it doesn't

* **Already-cached embeddings.** The persistent embedding cache means
  the per-file cost is paid once. If your file set is stable, the
  speedup mostly shows up on the first scan.
* **Old or integrated GPUs.** DirectML needs DirectX 12; pre-2015
  hardware won't load the bundle. Old integrated chips might load but
  underperform the CPU path. Watch the "Running on" label in
  Settings to confirm.

## Setup

1. Open **Settings → AI Search Acceleration (GPU)**.
2. Click **"Download bundle"**. ~35 MB total; same download-on-demand
   pattern as the generative GPU bundle. Files land under
   `<app local data>/onnx_dml/`:
   * `onnxruntime.dll` (~16 MB) — ORT 1.22 runtime built with the
     DirectML EP. Sourced from Microsoft's official
     `Microsoft.ML.OnnxRuntime.DirectML` NuGet package.
   * `DirectML.dll` (~18 MB) — the DirectML redistributable from
     Microsoft's `Microsoft.AI.DirectML` NuGet. Bundled rather than
     relying on the Windows-shipped copy because older Windows 10
     builds carry DirectML versions ORT 1.22 won't load against.
3. Flip the radio to **"Use DirectML when bundle is installed"**.
4. **Restart the app.** The active embedder backend is sticky per
   process for the same reason the CPU path's model load is sticky
   — flipping the preference mid-session would only take effect on
   restart anyway. The Settings card surfaces a "restart for the
   change to take effect" hint when this is needed.

## Architecture

```
┌───────────────────────────────────────┐
│ commands/ai.rs                        │
│   ai_embed_files / ai_search_text /   │
│   find_files_by_intent (MCP)          │
└────────────────┬──────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────┐
│ ai/embeddings.rs                      │
│   pick_embedder() ◄── EMBEDDER_PREF   │
└─────────┬─────────────────┬──────────┘
          │                 │
   Cpu    │                 │ DirectMl
          ▼                 ▼
┌──────────────────┐  ┌──────────────────┐
│ tract (in-proc)  │  │ ort + DML EP     │
│ Embedder         │  │ DmlEmbedder      │
│ (existing path)  │  │ (Z4)             │
└──────────────────┘  └──────────────────┘
```

The dispatcher caches its decision at first call. If DML init fails
(missing DLLs, unsupported GPU, driver hiccup), the dispatcher
permanently routes to CPU for the rest of the process and logs a
warning. The "Running on: CPU" label in Settings will reflect this so
you're not lied to.

## Privacy

Same as the CPU path: zero network calls during inference. The model
file is local. The runtime DLLs are local. DirectML is a Windows
system API; nothing leaves the device.

The only network call ever associated with this feature is the
one-time bundle download from this repo's GitHub release assets —
identical contract to the existing model downloads, and the BLAKE3
integrity check fails closed if a download is corrupt or tampered.

## Troubleshooting

* **"Download bundle" fails with a hash mismatch** — the GitHub
  release file got re-uploaded with different bytes, or your network
  modified the response. Delete the partial files in
  `<app local data>/onnx_dml/` and retry.
* **Toggle is on, badge still says "CPU"** — DML init failed and the
  dispatcher fell back. Check the app log for
  `embeddings: DML init FAILED, falling back to CPU: <reason>`. Common
  causes: bundle not fully downloaded, GPU driver too old, machine
  doesn't expose a DirectX 12 device.
* **First embed after enabling is slower than CPU** — model load +
  DML graph compile happens on first call. Subsequent calls are the
  ones you care about; the per-process load amortises across the
  whole session.
* **GPU shows higher idle power after enabling** — the ORT process
  keeps a session warm so the second call doesn't pay the load cost
  again. Trade-off baked in.

## What we don't ship yet

* **Per-app GPU selection** when multiple discrete GPUs are present.
  ORT's DML EP supports `device_id`; we currently use device 0
  (whatever Windows picks). Reasonable default; add a setting if
  multi-GPU users surface it.
* **Streaming or batched-tensor inference** — current path is one
  text per `Session::run` call serialised behind a Mutex. A single
  forward over a padded batch would be faster on GPU, but it'd
  require diverging the CPU path's API. Out of scope.
* **CPU↔DML hot-swap mid-session.** Same rationale as the genlm
  sticky-backend story — process restart matches user mental model.
