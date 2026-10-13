# Bug Fixes & UI Enhancements — Implementation Report

All six tasks were implemented with **no breaking changes** to existing APIs, config
files, or component contracts. Backend compiles and imports cleanly; the frontend
builds (`vite build`, 66 modules, 0 errors). Findings below were verified on the
target-class machine (NVIDIA **RTX A2000 12GB**) where these changes were developed.

---

## 1. Root-cause analysis of high CPU usage

### What was actually happening
The old device selection was a single check with a **silent** CPU fallback:

```python
device = 0 if torch.cuda.is_available() else -1      # quick_captions.py (old)
```

Two independent failure modes produce "GPU configured but CPU ~100%":

1. **`torch.cuda.is_available()` can report `False` even when CUDA works.**
   Verified live: in one process `torch.cuda=False` while `ctranslate2` reported
   CUDA **available**. The old single-check would silently run the CTranslate2 model
   on CPU with `compute_type=int8`, and **faster-whisper defaults to using *every*
   CPU core** → ~100% CPU, GPU idle. With two feeds (two subprocesses) it doubles.

2. **OpenMP / MKL / torch worker threads spin-wait at 100% between inferences.**
   Even when the model *is* on the GPU, the default OpenMP wait policy makes idle
   worker threads busy-spin. This pipeline issues many short 3 s inferences, so the
   pool spins almost continuously → all cores pinned near 100% while the GPU does
   the real math. This is the most likely cause on a box where CUDA *is* working.

3. **Per-chunk CPU preprocessing** (`enhance_audio` 4th-order Butterworth
   `filtfilt`, resampling, overlap `np.save/np.load`) runs on CPU for every chunk of
   every feed — a secondary, steady CPU load.

### Fixes (all in `backend/app/device_utils.py`, wired into the engine)
- **Dual CUDA detection** — checks **both** `torch.cuda` and
  `ctranslate2.get_cuda_device_count()`; if *either* sees CUDA, GPU is used. This
  directly fixes failure mode #1.
- **Explicit, enforceable device** — `VAAK_DEVICE=cuda|cpu|auto` (default auto) and
  `VAAK_ALLOW_CPU_FALLBACK=0/1`. With fallback disabled, a GPU box that can't reach
  CUDA now **fails loudly** instead of silently melting the CPU.
- **Kill the spin (failure mode #2)** — the worker subprocess is launched with
  `OMP_WAIT_POLICY=PASSIVE`, `KMP_BLOCKTIME=0`, and capped
  `OMP_NUM_THREADS/MKL_NUM_THREADS` **set before the child imports torch** (OpenMP
  reads these only at init). On CPU runs, faster-whisper is also constructed with
  `cpu_threads=<cap>` and `num_workers=1`.
- **Model reuse** — models were already loaded once per worker and kept resident
  (`keep_model_loaded`); no reload per chunk. Left intact.

### Startup device log (Task 1 format)
The engine now emits, per feed:
```
[AI]
CUDA Available : YES
GPU
NVIDIA RTX A2000 12GB
Loading Model
run
Device
cuda:0
GPU Memory
11.99 GB
CPU Fallback
Disabled
```
If CUDA is unavailable a clear warning is logged and (when fallback is disabled)
the model refuses to load on CPU.

## 2. GPU verification & optimization
- `GET /api/diagnostics` reports live `cuda.torch`, `cuda.ctranslate2`, resolved
  `inference_device`, GPU name and GPU memory (used/total).
- Each worker emits a machine-readable `[[DEVICE_INFO]]` line consumed by the
  wrapper and pushed to the UI (`device_info` WS message) — the Caption Monitor
  shows a **GPU / CPU / CPU (fallback)** badge per feed.
- Tensors stay on-device: HF pipeline places inputs on the model device; FP16 on
  CUDA, and no manual CPU⇄GPU copies were introduced.

## 3. Profiling report (which component consumes CPU)
`run_pipeline` now times every stage — `audio_read, vad, enhance, prepare, whisper,
alignment, text_pipeline` — into a rolling profiler that logs a **hotspots-first**
report every `VAAK_PROFILE_EVERY` (default 20) chunks and emits `[[PROFILE]]` JSON.
The System Diagnostics panel renders it as a per-stage share bar chart, so you can
see at a glance whether CPU is going to FFmpeg/resampling/Whisper/text formatting.

---

## 2 (Task). Feed-wise logging system

`backend/app/log_manager.py` (new) replaces the old flat `logs/system.log` +
`logs/feed_01.log` scheme with the requested tree:

```
logs/
  feed01/ … feed04/   application.log caption.log ffmpeg.log probe.log
                      model.log performance.log errors.log
  system/   application.log errors.log
  api/      application.log errors.log
  websocket/application.log errors.log
```

- One persistent `FileHandler` **plus** an in-memory ring buffer per
  (scope, category), each entry carrying a monotonic `seq` id.
- Warnings/errors are mirrored into that scope's `errors.log`.
- **Backward compatible:** existing `logging.getLogger("system")`,
  `getLogger("feed_01")`, etc. are transparently rewired into the new tree, so no
  other module had to change its logging calls. `logger_setup.setup_logging()` and
  `get_feed_logger()` keep their old signatures.
- Real sources are routed to categories: worker output → `application`; captions →
  `caption`; model/device → `model`; profiling → `performance`; ffmpeg capture →
  `ffmpeg`; probe results → `probe`.

### Logs REST API + live streaming
- `GET /api/logs/scopes` — the selector tree.
- `GET /api/logs/{scope}/{category}?tail=N&after=SEQ` — tail or delta read.
- `DELETE /api/logs/{scope}/{category}` — clear (buffer + file).
- `GET /api/logs/{scope}/{category}/download` — download the file.
- **WebSocket** `log_subscribe` / `log_unsubscribe` commands stream new entries
  (delta poll of the ring buffer, ~0.7 s) as `{type:"log", …}`.

## 4 (Task). Fully functional Logs page
`frontend/src/components/Logs.jsx` (was a "Coming soon" stub) now has: feed/scope
selector, log-type selector, level filter, search, live WebSocket updates,
auto-scroll with manual-scroll pause, **Pause/Resume** (buffers while paused and
shows a pending count), **Download**, **Clear**, millisecond timestamps, and
per-severity color coding.

---

## 3 (Task). Complete dark theme

Delivered as a **Tailwind** enterprise dark theme (per your decision — no MUI, so no
new dependency and full backward compatibility).

- **Root cause fixed:** `tailwind.config.js` had no `darkMode` key, so Tailwind
  defaulted to `'media'` — every `dark:` class silently followed the OS and the
  app's own `theme:"dark"` did nothing. Set `darkMode: 'class'`.
- Theme is applied to `<html class="dark">` before first paint (`main.jsx`),
  persisted to `localStorage`, honoured from backend `config.theme`, and toggllable
  via a header **☀/🌙** button (new `theme` state in the store).
- Converted every remaining light surface: filled all bare `border` utilities with
  `border-gray-200 dark:border-gray-700` (cards) / `border-gray-300 dark:border-gray-600`
  (buttons) across FeedCard, FeedDiagnostics, Settings, SystemDiagnostics,
  TerminologyUpload, Dashboard; themed the previously theme-less **Login** and
  **Logs** pages; raised low-contrast caption text. No `bg-white` remains without a
  `dark:` sibling.

---

## 4 (Task). Caption Monitor improvements
`frontend/src/components/CaptionMonitor.jsx` rewritten:
- **Incremental rendering** — each row is a `React.memo` component keyed by a stable
  unique caption **id** (assigned server-side in the wrapper). Appending new
  captions no longer re-renders existing rows or replaces history.
- **Dedup** — the store drops captions whose id was already seen (O(1) set).
- **Chronological order** preserved; history bounded to 5000 in memory.
- **Auto-scroll** to newest, which **pauses when the operator scrolls up** and shows
  a **↓ Jump to Latest** button that resumes it.
- **New captions briefly highlighted** (fades after 1.5 s).
- **Virtualization-lite** — only the trailing 400 rows are mounted in the DOM (full
  history still exported), so thousands of captions don't degrade the DOM.
- Per-feed **search**, **min-words filter**, and **SRT / TXT / JSON** downloads.

## 5 (Task). Performance optimization
- **Inference/CPU:** the thread-cap + PASSIVE OpenMP fix above is the biggest CPU
  win; GPU enforcement removes accidental CPU inference.
- **React:** memoized rows, windowed lists, `useMemo` filtering, narrow Zustand
  selectors, and `addCaption` that returns no-op when nothing new arrived (prevents
  re-render churn).
- **WebSocket:** streamed log lines use a pub/sub kept **out** of the store (so they
  don't trigger app-wide re-renders); log updates are deltas (`since(seq)`), not full
  resends.
- **State/memory:** captions capped (5000), log ring buffers bounded (2000),
  caption dedup set pruned when trimmed.
- **Polling:** diagnostics polled at 2 s; system stats at 1 s (unchanged).

## 6 (Task). Diagnostics
`GET /api/diagnostics` + `frontend/src/components/DiagnosticsPanel.jsx` (on the
Dashboard) show: CPU %, GPU %, GPU memory, CUDA status (torch + ctranslate2),
inference device, loaded models, active threads, active feeds, WebSocket connection,
and per-feed **queue length, current chunk, avg processing time, avg caption delay**,
plus the per-stage CPU hotspot bars.

---

## Files changed / added

**Backend**
- `device_utils.py` *(new)* — device detection/enforcement, thread caps, startup block.
- `log_manager.py` *(new)* — feed-wise logging tree, ring buffers, tail/since/clear.
- `quick_captions.py` — device enforcement, startup log, per-stage profiler, markers.
- `quick_captions_wrapper.py` — OMP/thread env before spawn, marker parsing, per-feed
  diagnostics, feed-scoped category logging, caption ids.
- `logger_setup.py` — thin shim over `log_manager` (API preserved).
- `feed_manager.py` — ffmpeg/probe category logging.
- `websocket_handler.py` — log subscribe/stream commands.
- `main.py` — logs API + `/api/diagnostics`.

**Frontend**
- `tailwind.config.js`, `main.jsx`, `App.jsx` — dark theme + toggle.
- `store/index.js` — theme, caption dedup/ids/cap, device/profile/diagnostics.
- `hooks/useWebSocket.js` — device/profile/log message handling + log pub/sub.
- `components/CaptionMonitor.jsx` — full rewrite (Task 4).
- `components/Logs.jsx` — full Logs page (Task 2).
- `components/DiagnosticsPanel.jsx` *(new)* — System Diagnostics (Task 6).
- `components/{Dashboard,Login,FeedCard,FeedDiagnostics,Settings,SystemDiagnostics,TerminologyUpload}.jsx`
  — dark-theme gap fixes.

---

## 15 (Task). Fresh Start / Reset Workspace

`backend/app/workspace_reset.py` *(new)* + `POST /api/workspace/reset`.

- Clears all **runtime** data: live captions, caption history, per-feed
  counters/stats/latency/queue, processed-chunk sets, and temp files (audio
  chunks `*.wav`, overlap `*.npy`, JSON/SRT/TXT outputs) from every feed's
  input/output folders — plus a sweep of `data/feed_*` for orphaned temp.
- **Models stay resident on the GPU**: the worker subprocess is *not* killed.
  The reset stops FFmpeg **capture** (so the feed goes Idle and no new chunks
  flow) and marks the feed not-running, but leaves the QuickCaptions worker alive
  with its model loaded — the next test starts with minimal latency. No FastAPI
  restart.
- **Does not delete** uploaded media, saved feed config, prompts, terminology,
  system settings, logs or model files (verified: a terminology file in a feed
  folder survives the reset while chunks/outputs are removed).
- Returns `{"success": true, "message": "Workspace reset successfully."}` and
  **broadcasts `workspace_reset`** to every connected client via a new
  connection registry in `websocket_handler.py`.
- **Frontend:** a **🔄 Fresh Start** button in the Dashboard header opens the
  exact confirmation dialog (Cancel / Fresh Start). On confirm it POSTs the reset;
  the broadcast (and a local `resetWorkspace()` fallback) clears every caption
  window, stats, charts, counters, probe/pipeline state and returns all feeds to
  **Idle** with no browser refresh. Feed config, theme and models are preserved.

Files touched: `workspace_reset.py` *(new)*, `main.py`, `websocket_handler.py`
(connection registry + `broadcast`), `store/index.js` (`resetWorkspace`),
`hooks/useWebSocket.js` (`workspace_reset` handler), `components/Dashboard.jsx`
(button + dialog).

## New environment knobs (all optional, safe defaults)
| Var | Default | Effect |
|---|---|---|
| `VAAK_DEVICE` | `auto` | `cuda` / `cpu` / `auto` inference device |
| `VAAK_ALLOW_CPU_FALLBACK` | `1` | `0` = refuse CPU when CUDA requested |
| `VAAK_CPU_THREADS` | `4` | CPU thread cap (and faster-whisper `cpu_threads`) |
| `VAAK_PROFILE_EVERY` | `20` | chunks between profiling reports |
| `VAAK_NUM_FEEDS` | `4` | number of feed log scopes to create |
| `VAAK_LOG_ROOT` | `logs` | log directory root |
