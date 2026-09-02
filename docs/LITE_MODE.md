# Lite mode — a native egui frontend

TaskManager+ ships a React 19 UI inside a Tauri WebView2 window. That buys
a lot: 8,666 lines of CSS, real typography, cheap iteration, and pages like
Storage and Insights that would be miserable to build any other way.

It also costs about **440 MB of RAM across six Chromium processes** and
**~322 ms of process bring-up** before a single line of app code runs.

Lite mode is a second, native frontend built on [egui](https://github.com/emilk/egui)
that reuses the entire Rust backend and skips the webview. It is deliberately
*not* a replacement — it covers the pages where a task manager earns its
keep, and hands off to the webview for everything else.

## The measurements this is based on

Profiled on a **cold restart**, sitting on the Processes page, having touched
nothing:

| Process | Type | Private MB |
|---|---|---|
| `taskmanagerplus.exe` | Rust core | **814** |
| `msedgewebview2` | renderer | 137 |
| `msedgewebview2` | gpu-process | 130 |
| `msedgewebview2` | browser | 44 |
| `msedgewebview2` | utility ×2 | 25 |
| `msedgewebview2` | crashpad | 3 |
| **Total** | **7 processes** | **~1152** |

Cold startup, from process start timestamps: browser +179 ms, GPU process
+480 ms, **renderer +612 ms** — and only then does the renderer begin parsing
a single unsplit 787 KB JS + 148 KB CSS bundle. (A warm start, with the
WebView2 runtime already resident from another app, reaches the renderer in
~322 ms.)

**The honest read: the webview is under a third of the footprint.** The Rust
process is ~71% — and no frontend change touches a byte of it.

Worse for the lite-mode case, almost all of that Rust memory is not
structural. Measured across the first seconds of a launch:

| Time | Rust private | Working set |
|---|---|---|
| launch | **7.2 MB** | 47 MB |
| +7 s | **820 MB** | 1257 MB |

The backend's real baseline is **7 MB**. The rest is both AI models being
prewarmed eagerly at startup for features the user may never invoke. Making
that lazy is a change of roughly a dozen lines in `settings.ts`.

**This is why the memory work is sequenced ahead of lite mode.** If a
dozen-line fix recovers ~800 MB and lite mode recovers ~270 MB for 3–5k lines
of Rust, the ordering is not a close call — and the honest conclusion may be
that lite mode isn't worth building at all.

## Why egui, and not the others

| | egui | Iced | Slint | WinUI 3 |
|---|---|---|---|---|
| RAM vs webview | ~40–90 MB | ~60–120 MB | ~50–100 MB | ~30–60 MB |
| Startup | ~80–150 ms | ~100–200 ms | ~100–180 ms | ~50–120 ms |
| Data-dense tables | `egui_extras::TableBuilder`, virtualized | build it yourself | decent | native ListView |
| Realtime graphs | `egui_plot`, immediate mode | `canvas` | good | manual |
| Blocker | code-drawn widgets, no CSS | API churn | **licensing** | effort |

**Slint** is the best-looking of the three and was the closest call. Its
royalty-free desktop license requires displaying an `AboutSlint` widget in a
menu reachable from the top level of the app. For a distributed product
that's a real constraint, and the alternative is GPLv3.

**Iced** has a nicer retained-mode model, but no virtualized table — the
single most important widget here — and more API churn between releases.

**egui** wins on fit rather than beauty. Its immediate-mode model maps almost
exactly onto what this app already does: redraw a table and some graphs once
a second from a fresh telemetry snapshot. `TableBuilder::rows` virtualizes to
visible rows only, which is what `@tanstack/react-virtual` does for
`ProcessTable` today. And the existing graphs are already `<canvas>` 2D
drawing (`RealtimeGraph.tsx`, `SparklineCanvas.tsx`, `CpuPanel.tsx`,
`SystemOverview.tsx`) — immediate-mode drawing logic ports conceptually
instead of being thrown away.

### The one thing that must be right

egui's default eframe loop can run **continuously at display refresh rate**.
A task manager that burns a CPU core redrawing itself at 60 Hz would be
self-defeating — it would show up in its own process list.

Lite mode must run in **reactive mode**, driving repaints from the telemetry
tick with `Context::request_repaint_after(Duration)` at the configured
`refreshRate` (default 1000 ms). This is settled in Phase 0, before any real
UI is built, and it is the gate on the whole project. If reactive repaint
can't be made to behave, stop.

## The big structural win

The React UI talks to the backend through ~100 `#[tauri::command]` handlers,
every call serializing arguments and results across the webview IPC boundary.

**In lite mode those become direct Rust function calls.** No serialization,
no `invoke` round-trip, no JSON. The backend is reused entirely as-is; only
the presentation layer differs.

## Phases

### Phase 0 — Tray widget (proving ground)

Today the tray widget builds a second webview window pointed at
`WebviewUrl::App("index.html")` — **the same full 787 KB bundle** — to render
a 320×400 popup that shows only `<TrayWidget />`. Each Tauri window gets its
own renderer process, so opening the tray costs another ~100–180 MB.

Replacing it with a native egui popup is the smallest possible surface that
still eliminates an entire renderer process. It validates, in order:

1. Reactive repaint driven by the telemetry tick (the gate above).
2. The direct-call data path, with no `invoke`.
3. Tray anchoring and multi-monitor clamping — `widget_position` in `tray.rs`
   is pure geometry and is reused unchanged.
4. Theming and the visual floor: does a native popup look acceptable next to
   the React UI, or obviously worse?

**Do this first regardless of whether later phases happen.** It is
self-contained, it removes a whole process, and it answers the toolkit
question for a fraction of the cost of answering it on a real page.

### Phase A — Core basics (the actual lite mode)

Processes, CPU, Memory, Disk, Network, GPU, NPU, plus **Settings** and
**Battery**.

This is tractable because the core pages barely touch the expensive logic.
They need nine small modules — `endTaskSafety`, `ipc`,
`memoryCompositionColors`, `processExplain`, `processSuspicion`,
`ringBuffer`, `seriesPalette`, `settings`, `types` (~2.2k lines) — and skip
the ~7.2k lines of `smartOrganizer` / `insights` / `insightsEngine` /
`appUsage` / `usagePattern` / `semanticClusters` entirely.

Estimated **3–5k lines of Rust**.

Two things to get right:

- **Settings must share the same on-disk representation** as `settings.ts`,
  so the two UIs stay consistent when a user switches between them.
- `processExplain` imports from `insights.ts`, but only uses
  `isHelperProcess` and `isSystemProcessName`. Port those two helpers — not
  the 1,859-line module behind them.

### Phase B — Optional

Insights, Devices, Startup.

Devices and Startup are comparatively cheap; they mostly render data the
backend already returns. **Insights is the expensive one** — it means porting
`insightsEngine` + `insights` + `appUsage` + `usagePattern` (4,443 lines of
TypeScript) to Rust, *including* their `localStorage`-backed usage-history
databases and the migration path for existing users' history.

### Phase C — Extremely optional, likely never

Storage and the full AI surface. Roughly 13k lines of TypeScript to port
(`smartOrganizer` alone is 2,201), plus the model-management UI.

Documented for completeness. **Assume this is not implemented.** The webview
stays the path for these pages, and that is a perfectly good outcome — these
are exactly the pages where a browser engine earns its footprint.

## Delivery

Two entry points, one backend:

- **`taskmanagerplus-lite.exe`** — a separate binary for users who want the
  small, fast thing and nothing else.
- **A setting in the main app, default off.** When enabled, the main window
  launches native, and the webview is spawned on demand only for pages lite
  mode doesn't cover.

```
src-tauri/                    (unchanged — shared by every frontend)
  src/lib.rs                  Tauri app, ~100 IPC commands
  src/bin/tmp_mcp.rs          existing MCP sidecar
  src/bin/tmp_widget.rs       Phase 0 — tray popup, tmp_widget.exe
  src/bin/taskmanagerplus-lite.rs   Phase A — eframe entry,
                              taskmanagerplus-lite.exe
  src/lite/                   Phase A — egui UI modules, pulled in by the bin
    theme.rs  fmt.rs  state.rs  app.rs
    processes.rs  perf.rs  battery.rs  settings.rs
```

**`src/bin/` must contain only entry-point `.rs` files — no subdirectories.**
Tauri's bundler enumerates binaries with `read_dir("src/bin")` and takes
`file_stem()` of every entry, directories included, without filtering to `.rs`.
A `src/bin/lite/` module folder therefore invented a phantom binary `lite` and
broke bundling with `when getting size of ...\lite.exe` — twice, during the
v2.7.0 release. The UI modules live in `src/lite/` for exactly this reason, and
the bin reaches them via `#[path = "../lite/..."]`. `ci.yml` has a guard step
that enforces the invariant; `tauri build --no-bundle` cannot catch it.

Command functions are currently `#[tauri::command]`. To call them from a
binary with no Tauri `AppHandle`, each needs splitting into a plain `fn` core
plus a thin command wrapper. Most already have roughly this shape — verify
before assuming. The ones that genuinely need an `AppHandle` (path
resolution, event emission, tray) need a small abstraction over those
capabilities.

## What you give up

These are the cost of the trade, not problems to be solved later:

- **All 8,666 lines of CSS.** No `backdrop-filter`, no CSS transitions, no
  gradients beyond what's drawn by hand. The 334 flex/grid rules and 100
  transitions do not port — layout gets rebuilt in code.
- **Weaker text rendering and font shaping** than Chromium's.
- **Every custom widget is code, not markup.** Visual iteration is
  meaningfully slower, and design changes that are a CSS tweak today become
  a rebuild.
- **The onboarding tour, command palette, and file inspector** would each
  need full reimplementation. They stay webview-only until Phase B/C.

The trade is deliberate: a rougher, plainer UI that starts in ~150 ms and
holds under 100 MB.

## When lite mode is worth it

- You keep TaskManager+ resident all day and care what it costs to have open.
- You want it to appear instantly from the tray, not after a second.
- You mostly use the process list and the resource graphs, and rarely touch
  Storage, Insights, or the AI features.

## When it isn't

- **Storage and Insights are your main pages.** Lite mode never covers them;
  you'd be running both UIs and paying for both.
- **You care about how it looks.** The React UI is substantially more
  polished and will stay that way.
- **You expected the webview to be the whole problem.** It's a bit over half.
  If the Rust-side retention work lands first, a lot of the motivation for
  lite mode goes with it — which is exactly why that work is sequenced ahead
  of this.

## Go / no-go

Decide after the memory and startup work lands, not before — and go in
expecting the answer to be "no."

The measurements moved sharply against lite mode. The webview is ~338 MB of a
~1152 MB footprint, and the largest single item in the app is a dozen-line
frontend bug that prewarms two AI models at launch. Fixing that is worth
~800 MB. Lite mode's entire remaining upside is the renderer plus the GPU
process (~270 MB) and ~300 ms of startup, against 3–5k lines of Rust for
Phase A and a permanent second UI to maintain.

Put plainly: **if the memory work lands, the case for Phases A–C is weak.**
That is a good outcome — it means the problem was fixable without a rewrite.

**Phase 0 remains worth doing either way.** The tray widget spawns an entire
second renderer process to draw a 320×400 popup, and that is true regardless
of anything else here. It is self-contained, it removes a whole process, and
it is the cheapest honest test of the toolkit if the question ever reopens.
