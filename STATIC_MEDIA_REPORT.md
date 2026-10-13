# Rebranding & Static Media Processing — Implementation Report

No existing architecture was rewritten; the live UDP workflow is untouched and fully
backward compatible. Backend compiles + imports; frontend builds (67 modules, 0 errors).
Verified on this machine (real FFmpeg + RTX A2000).

---

## Task 1 — Rebranding (VaaK AI → Model AI)
All **visible** references now read "Model AI":
- Browser title (`index.html`), window title (`desktop/main.py`) and FastAPI title were
  already "Model AI".
- Sidebar logo in `App.jsx` changed `VaaK AI` → `Model AI` (was the only visible instance).
- Doc heading in `TESTING_CHECKLIST.md` updated.

**Intentionally NOT changed** (would break backward compatibility, and are not visible
branding): `VAAK_*` environment variable names, `C:/vaakai/...` model/config filesystem
paths, and internal `_vaak_*` logging keys. Pages listed in the spec that don't exist in
this app (About, Splash, Footer, Loading Screen) have no VaaK references to change.

## Tasks 3/4/9/11/14 — Static Media Processing service
New `backend/app/static_processing.py` (`StaticProcessingService`):
- **Folder structure** (`uploads/original, audio, chunks/<id>/{shared,feed01,feed02}, results, logs`).
- **Extract + chunk ONCE** (Task 14): a single FFmpeg pass extracts 16 kHz mono PCM and a
  second pass segments it into fixed-length `chunk_%04d.wav` using the feed's existing
  `chunk_size`. Verified: a 10 s clip → 4×3 s chunks + extracted audio.
- **Distribute, don't re-generate**: the shared chunk set is *copied* into each feed's
  input dir — the expensive decode/segment happens once; both models get identical input.
- **Reuses the live pipeline** (Task 9): each feed is processed by the same
  `QuickCaptionsWrapper` → `quick_captions.py --worker` that live UDP uses (it already
  watches an input dir of wav chunks). No caption/model/prompt/terminology logic is
  duplicated. The wrapper gained optional `input_dir`/`output_dir` args (backward compatible).

## Task 5 — Dual-feed processing
The upload is processed by **both** configured feeds concurrently, each with its own model,
reading the identical shared chunks. Progress is tracked per feed.

## Task 6 — Caption comparison
Side-by-side columns per feed showing model, device, per-feed chunk progress, avg
processing time, and the caption stream — with **Copy** and **Download TXT / JSON / SRT**
per feed independently.

## Task 7 — Processing progress
Upload progress (real byte progress via XHR), then phases: extracting → chunked →
processing → completed, with an overall bar plus an independent per-feed
`processed/total` bar. Broadcast live over WebSocket.

## Task 8 — File management
Each upload card shows filename, size, duration, video codec/resolution/fps, audio
codec/sample-rate/channels, bitrate, creation time. Actions: **Delete**, **Reprocess**,
**Download Audio** (extracted WAV); chunk listing via `/api/upload/{id}/chunks`.

## Task 10 — New REST APIs
`POST /api/upload` · `POST /api/process` · `GET /api/uploads` · `GET /api/upload/{id}` ·
`GET /api/upload/{id}/status` · `GET /api/upload/{id}/captions` ·
`GET /api/upload/{id}/chunks` · `GET /api/upload/{id}/audio` · `DELETE /api/upload/{id}`.
(All registered and lifecycle-tested via TestClient.)

## Task 12 — WebSocket events
Broadcast to **all** clients (using the connection registry added in Task 15):
`upload_status` (progress/phase), `upload_caption` (per feed), `upload_complete`,
`upload_error`, `upload_deleted`.

## Task 13 — UI
`frontend/src/components/StaticMediaProcessing.jsx`, integrated into the Dashboard, using
the existing Tailwind dark theme: **drag & drop** + browse, upload **progress bar** with
**Cancel**, processing status, **Reprocess**, per-upload comparison.

## Task 2 — Dashboard feed cards
`FeedCard` now shows a live status grid — Model, GPU/Device, CPU %, FFmpeg status, Caption
Delay, Processing time, Terminology file, Prompt summary, line count, and the **Current
Caption** — plus a single per-feed **▶ Start Feed / ■ Stop Feed** toggle. (The existing
Dashboard master Start/Stop-All button is retained for backward compatibility.)

---

## Performance (Task 14 emphasis)
The uploaded media is decoded/segmented exactly once; the resulting chunks are copied
(cheap) to both feed pipelines. Both models therefore receive byte-identical audio, which
minimises CPU and guarantees a fair comparison — the same principle the report for the
prior tasks applied to live capture.

## Files
**Backend:** `static_processing.py` *(new)*, `main.py` (upload APIs),
`quick_captions_wrapper.py` (optional dir override), `websocket_handler.py`
(connection registry/broadcast — from Task 15).
**Frontend:** `components/StaticMediaProcessing.jsx` *(new)*, `components/Dashboard.jsx`,
`components/FeedCard.jsx`, `store/index.js`, `hooks/useWebSocket.js`, `App.jsx` (rebrand).

## Backward compatibility
Live UDP feeds, all prior endpoints, config files, and the caption/logging/diagnostics
features from earlier tasks are unchanged. The static path is fully additive.

---

## Testing checklist

### Verified automatically
- [x] Backend compiles; app imports; all `/api/upload*` + `/api/process` routes registered.
- [x] `POST /api/upload` rejects unsupported types (400) and accepts audio/video (200).
- [x] Upload lifecycle: upload → list → status → captions → chunks → delete all return 200.
- [x] FFmpeg extract+segment produces N chunks + extracted audio in one pass (10 s → 4 chunks).
- [x] Frontend builds (67 modules, 0 errors).

### Manual (needs a running backend + models)
- [ ] Sidebar/header shows **Model AI**; browser tab title is **Model AI**.
- [ ] Dashboard shows the **Static Media Processing** section with a drag & drop zone.
- [ ] Drag or browse a video (MP4/MKV/MXF/TS) or audio (WAV/MP3/AAC/FLAC/M4A/OGG) file; upload bar advances; **Cancel** aborts.
- [ ] After upload, phases progress: extracting → chunked → processing → completed.
- [ ] File metadata shows duration, size, video/audio codecs, resolution, fps, sample rate, channels, bitrate.
- [ ] Both feed columns fill with captions from their respective models; per-feed progress bars advance independently.
- [ ] Copy + Download TXT/JSON/SRT work per feed; Download Audio returns the extracted WAV.
- [ ] Reprocess re-runs; Delete removes the upload and its files (`uploads/chunks/<id>`, results, original, audio).
- [ ] `uploads/` folder tree is created (original/audio/chunks/results/logs).
- [ ] Chunks are generated once (check `uploads/chunks/<id>/shared`), then copied to `feed01/input` and `feed02/input`.
- [ ] Feed cards show live Model/GPU/CPU/FFmpeg/Delay/Processing/Current Caption and a working per-feed Start/Stop button.
- [ ] Live UDP feeds still work exactly as before (backward compatibility).
