# Model AI Model Compare — Fix & Testing Checklist

This document lists what was changed and how to verify each fix.

## Root causes found

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Model dropdowns empty | `config/config.json` had a `//` comment → **invalid JSON** → `ConfigManager()` threw at import → **whole backend crashed** so `/api/config`, `/api/models` and `/ws` all failed | Removed comment; `config_manager.load()` now tolerates bad JSON and logs it instead of crashing |
| 1 | Dropdowns empty even when backend up | Path resolution depended on CWD; API returned bare strings | Robust path resolution + `/api/models` returns `{success, models:[{name,path}]}` |
| 2 | Probe results never displayed | `FeedManager.__init__` set `self.probe = ProbeManager()`, **shadowing** the `async def probe()` method → WS `probe` command raised, swallowed by `except: pass` | Renamed attribute to `self.prober`; WS probe now works |
| 2 | Probe only in console | Frontend only `console.log`-ed the result | New **Probe Result Card** UI |
| 3 | Captions/pipeline opaque | No visibility into pipeline stages | Backend emits `pipeline_status`; new **Pipeline Status** + **Debug Panel** UI |

## Backend — how to run
```powershell
# from c:\model_ai
python backend/run.py     # or: uvicorn backend.app.main:app --port 8000
```

## Frontend — how to run
```powershell
cd frontend
npm install
npm run dev               # Vite proxies /api and /ws to :8000
```

## Automated smoke test (already verified)
```powershell
python -c "import json; json.load(open('config/config.json'))"    # config.json OK
python -m py_compile backend/app/*.py                             # modules compile
# TestClient GET /api/models -> 200 {'success': True, 'models': [...4 models...]}
```

## Manual test checklist

- [x] `config.json` is valid JSON (no comments)
- [x] `GET /api/models` returns HTTP 200 `{success, models:[{name,path}]}`
- [x] Backend logs show `[ConfigManager]` / `[Models]` blocks with resolved path + count
- [ ] **Model dropdown loads** — open Model Compare; both dropdowns list `run`, `run_ct2`, `run_prompt`, `run_prompt_ct2` (names, not paths)
- [ ] Spinner (⟳) shows while loading; **"No models found"** shown when folder empty; backend error shown if `/api/models` 500s
- [ ] Dropdown refreshes on page reload and via the ⟳ button
- [ ] **Probe returns results** — enter a UDP URL, click Probe
- [ ] **Probe shown in UI** — Probe Result Card shows Video codec/resolution/FPS/PID, Audio codec/sample rate/channels/PID, bitrate, duration, warnings
- [ ] Probe failure shows Reason + Error + Suggested Fix card
- [ ] **Start launches pipeline** — Pipeline Status shows stages going green (UDP → FFmpeg → Chunk Writer → Whisper → Caption Generator → WebSocket → Frontend)
- [ ] **Captions appear** in the Caption Display as chunks are transcribed
- [ ] Caption Debug Panel shows model, chunk #, processing time, latency, words, CPU/GPU, WS state, current caption
- [ ] **WebSocket reconnects** — stop/restart backend; header badge flips Disconnected → Connected automatically (exponential backoff, see `[WS] Reconnect attempt` in console)
- [ ] **Backend logs readable** — `[ConfigManager]`, `[Models]`, `[Probe]`, `[Pipeline]`, `[WS]` prefixes in console + `logs/system.log`
- [ ] **Errors user-friendly** — friendly messages for: no models, model folder missing, backend unavailable, WS disconnected, probe failed, ffmpeg missing, model not selected, invalid UDP URL
- [ ] **Validation** — Start disabled with reasons listed when no model / empty URL / not a `udp://` URL / backend disconnected

## FFmpeg / FFprobe resolution & multicast network interface

**Why probe timed out:** `ffprobe udp://@236.1.1.1:6004` returns no data on a
multi-homed / VPN machine because the multicast group is joined on the wrong NIC.
The fix is to bind reception to a specific interface via `?localaddr=<ip>`.

- **ffmpeg/ffprobe are now resolved centrally** in [ffmpeg_utils.py](backend/app/ffmpeg_utils.py):
  env var (`FFMPEG_PATH` / `FFMPEG_BINARY` / `VAAK_FFMPEG`, and ffprobe equivalents)
  → sibling of the other → `PATH` → bare name. Resolved paths are logged at startup:
  `[FFmpeg] ffmpeg  -> ...` / `[FFmpeg] ffprobe -> ...`.
  To force a specific build:
  ```powershell
  $env:FFMPEG_PATH  = "C:\Tools\ffmpeg\dist\ffmpeg.exe"
  $env:FFPROBE_PATH = "C:\Tools\ffmpeg\dist\ffprobe.exe"
  ```
- **Network interface selection**: `GET /api/interfaces` lists local NICs; the
  Feed panel has an interface dropdown ("Auto" + each NIC IP). The chosen IP is
  sent with Probe/Start and applied as `localaddr` on the UDP URL for both
  ffprobe (probe) and ffmpeg (capture). Probe also sets a `timeout` so it fails
  cleanly instead of hanging; capture omits the timeout so it keeps waiting.

Manual checks:
- [ ] `GET /api/interfaces` returns 200 with your NIC IP(s)
- [ ] Interface dropdown appears under the model dropdown and lists your NICs
- [ ] Selecting the correct NIC makes Probe succeed on a live multicast feed
- [ ] Backend log shows `[Probe] Using network interface (localaddr) <ip>` and the
      augmented `udp://...?localaddr=...&timeout=...` URL
- [ ] With ffmpeg removed from PATH but `FFMPEG_PATH` set, pipeline still works

## Notes / decisions

- The existing frontend uses **Tailwind CSS + Zustand**, not Material UI. To honour
  "do not rewrite the architecture / keep backward compatibility", the new cards and
  panels were built with Tailwind to match the app rather than introducing an MUI
  dependency. They are visually equivalent card components.
- All existing APIs preserved: `/api/config` (GET/POST), `/api/models` (GET), `/ws`.
  `/api/models` response is a **superset** of the old one and the frontend also
  tolerates the legacy string-array shape.
- Probe/Start/Stop WS commands now optionally carry `url`, `model`, `model_path`,
  `prompt`, `chunk_size` so the operator's typed values are used (backward compatible —
  fields are optional; falls back to `config.json`).
