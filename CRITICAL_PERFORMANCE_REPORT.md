# Critical Performance — Root Cause & Optimization Report

## TL;DR — the root cause
**The installed PyTorch is a CPU-only build.** Measured on this machine:

```
torch version      : 2.8.0+cpu
torch.version.cuda : None
torch.cuda.is_available() : False
device count       : 0   ("Torch not compiled with CUDA enabled")
NVIDIA driver      : 581.42   (GPU present: RTX A2000 12GB)
CTranslate2 CUDA   : available
```

Consequences that produce the exact symptoms reported:
- `cuda.torch = false`, `cuda.ctranslate2 = true` — **explained**: CTranslate2 ships its
  own CUDA runtime; PyTorch (CPU wheel) cannot see the GPU at all.
- Any **Transformers/HF-backend** model (`.safetensors` — the `run` / `run_prompt`
  models your feeds use) runs the HF pipeline on the **CPU** → ~140 s per 3 s chunk.
- Because inference (140 s) ≫ chunk interval (3 s), the input queue grows without
  bound (90+) and the caption delay compounds indefinitely (there was no queue cap).

This was **not** masked. The fix is at two levels: environment (install CUDA torch) and
code (correct per-backend device selection, queue management, warmup, diagnostics).

---

## Task 1 — CUDA detection (implemented)
`device_utils.cuda_report()` now gathers the whole stack and **explains why** torch is
false instead of just printing it: torch version + `+cpu` detection, `torch.version.cuda`,
`torch.cuda.is_available()`, cuDNN, device count, GPU name, compute capability, NVIDIA
driver (via `nvidia-smi`), and CTranslate2 CUDA. It emits a concrete **diagnosis** and
**recommended fix**.

- Logged at startup (API process **and** each worker) as a formatted block.
- New endpoint `GET /api/cuda`; also embedded in `GET /api/diagnostics`.
- Surfaced in the Dashboard **System Diagnostics → CUDA Stack** panel, with the fix shown
  in an amber banner when torch is CPU-only.

**The fix it recommends (run in the app's venv):**
```
pip uninstall -y torch torchaudio
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```
*(match cuXXX to the driver — 581.42 supports CUDA 12.x, so cu121/cu124 are fine).*
**Immediate alternative, no reinstall:** point both feeds at the CtRanslate2 models
(`run_ct2`, `run_prompt_ct2`) — those already run on the GPU via CTranslate2, giving
sub-second inference today.

## Task 2 — Force GPU inference (implemented)
- **Per-backend device selection fixed (real bug).** The Transformers pipeline now uses
  **torch's own** CUDA (`device = 0 if torch.cuda.is_available() else -1`), and CTranslate2
  uses **its own** CUDA — previously both took the *combined* plan, so a Transformers model
  could be handed `cuda:0` on a CPU-only torch (crash) or silently misreport GPU. If a
  Transformers model is forced onto CPU, a **CRITICAL** warning names the cause and remedy.
- Models are **loaded once** per worker and kept resident (`keep_model_loaded`), never
  reloaded per chunk; audio stays as one numpy array (no extra CPU↔GPU copies added).
- Each feed is a separate worker process → independent CUDA context per feed.

## Task 3 — Pipeline profiling (implemented)
The worker times every stage — `audio_read, vad, enhance, prepare, whisper, alignment,
text_pipeline` — in a rolling profiler that logs a hotspots-first report every
`VAAK_PROFILE_EVERY` (20) chunks and emits `[[PROFILE]]` JSON. The Dashboard renders it as
per-stage share bars. This is what pinpointed inference (Whisper) as the dominant cost when
running on CPU.

## Task 4 — Queue management (implemented)
Root cause of the 90+ queue: sequential worker + inference slower than real-time + **no
cap**. Fix: for **live** feeds the wrapper prunes the input queue to the newest
`VAAK_MAX_QUEUE` (default **2**) chunks, dropping stale ones and counting `chunks_dropped`.
This bounds caption delay to ~1 chunk regardless of a slow start. Static uploads keep
`drop_stale = False` (the whole file must be transcribed for a fair comparison).

## Task 5 — Pipeline optimization (implemented / prior)
- **Warmup**: the cold-start cost (CUDA init, model→VRAM, first-inference graph build) is
  paid once at worker startup on 1 s of silence (`VAAK_WARMUP=1`), so the first live chunk
  isn't a multi-second stall that instantly builds a backlog.
- Thread caps + `OMP_WAIT_POLICY=PASSIVE` (prior task) stop CPU spin.
- Chunk wav + JSON deleted right after render (prior task) — no disk growth.
- Non-blocking: subprocess I/O on threads; WS sends async; log streaming off the store.

## Task 6 / 9 — Caption Monitor (implemented / prior)
Captions render incrementally (memoized rows keyed by id), newest highlighted, auto-scroll
with pause + Jump-to-Latest, DOM windowed to the last 400 rows, no full re-render. Live and
upload sources labelled per feed. UI update work is O(1) per new caption.

## Task 7 — Real-time queue monitoring (implemented)
Dashboard per-feed table: Device, Chunks, **Queue** (red if >2), **Dropped**, Current
chunk, Avg processing ms, Avg delay — plus GPU util/memory, CUDA status, threads.

## Task 8 — Backend services
Reuses the existing GPU model manager (per-worker resident model), device manager
(`device_utils`), profiler (stage profiler), shared audio queue (input dir), and queue
manager (prune). No new unnecessary CPU processing was added.

---

## Task 10 — Validation checklist
Run after installing a CUDA torch (or switching to the `*_ct2` models):
- [ ] `GET /api/cuda` → `torch_cuda_available: true` (after CUDA torch install).
- [ ] Startup log shows `PyTorch CUDA: Enabled`, `Inference on GPU: YES`.
- [ ] Feed 01 & Feed 02 device badge = **GPU**.
- [ ] Model loaded once (one `[Warmup]` line per worker; no reload logs).
- [ ] Queue stays ≤ 2 (Diagnostics table); Dropped may rise briefly under load.
- [ ] Inference ≤ 600 ms/chunk (`[PROFILE]` whisper avg; feed Avg proc ms).
- [ ] Caption delay < 1 s; captions appear chunk-by-chunk immediately.
- [ ] CPU low/stable, GPU high/stable during captioning.

### Verified now (in this repo, CPU-only torch present)
- [x] Root cause identified and reported (CPU-only torch), with automatic detection.
- [x] `GET /api/cuda` / `/api/diagnostics` return the full report + diagnosis + fix.
- [x] Per-backend device selection corrected; Transformers-on-CPU warns loudly.
- [x] Queue prune, warmup, dropped-counter, stage profiler in place; backend compiles.
- [x] Frontend builds; CUDA Stack panel + Dropped/Queue columns render.

## New environment knobs
| Var | Default | Effect |
|---|---|---|
| `VAAK_MAX_QUEUE` | `2` | live queue cap before dropping stale chunks |
| `VAAK_WARMUP` | `1` | run a warmup inference at worker start |
| `VAAK_PROFILE_EVERY` | `20` | chunks between `[[PROFILE]]` reports |

## The one action that fixes the 140 s → <600 ms
Install a CUDA build of PyTorch in the app's virtualenv (command above), **or** switch both
feeds to the CtRanslate2 models. Everything else here makes that correct, observable, and
resilient — but the CPU-only torch wheel is the physical bottleneck and must be replaced.
