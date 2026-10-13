import os
import sys
import json
import time
import asyncio
import logging

# On Windows, prefer the Proactor loop (supports subprocesses). Subprocess calls
# in this app are also thread-based so they work even under the SelectorEventLoop
# that uvicorn's --reload mode forces on Windows; this is a belt-and-suspenders
# for non-reload / webview launch paths.
if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

from pathlib import Path

from fastapi import FastAPI, WebSocket, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse, FileResponse, StreamingResponse
from .websocket_handler import websocket_endpoint
from .config_manager import ConfigManager, ModelFolderError
from .logger_setup import setup_logging
from .log_manager import log_manager
from .stats_collector import get_system_stats
from . import device_utils
from .ffmpeg_utils import (log_binaries, list_network_interfaces,
                           list_sdi_devices, diagnostics as ffmpeg_diagnostics)

setup_logging()
logger = logging.getLogger("system")
api_logger = logging.getLogger("api")
log_binaries()

# Full CUDA-stack diagnostic at startup (Task 1) — surfaces a CPU-only torch loudly.
try:
    _cuda_rep = device_utils.cuda_report()
    logger.info(device_utils.format_cuda_block(_cuda_rep))
    if not _cuda_rep.get("torch_cuda_available"):
        logger.warning("[CUDA] %s", _cuda_rep.get("diagnosis"))
except Exception as _e:  # pragma: no cover - defensive
    logger.warning("[CUDA] report failed: %s", _e)

app = FastAPI(title="Model AI")
config = ConfigManager()

from .static_processing import StaticProcessingService
static_service = StaticProcessingService(config)


@app.websocket("/ws")
async def websocket_route(websocket: WebSocket):
    await websocket_endpoint(websocket, config)


@app.get("/api/config")
async def get_config():
    return config._config


@app.post("/api/config")
async def update_config(data: dict):
    config.save(data)
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Engine config — backend/app/config.json, the file quick_captions.py actually
# reads. This is NOT the same file as /api/config (config/config.json), which
# only drives the controller UI. Editing the engine config here is what changes
# transcription behaviour.
# --------------------------------------------------------------------------- #
ENGINE_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"


@app.get("/api/engine/config")
async def get_engine_config():
    try:
        raw = ENGINE_CONFIG_PATH.read_text(encoding="utf-8-sig")
        return {"success": True, "path": str(ENGINE_CONFIG_PATH), "config": json.loads(raw)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read engine config: {e}")


@app.get("/api/engine/paths")
async def get_engine_paths():
    """Every paths.* entry with whether it currently exists on disk.

    A mistyped path is silently ignored by the engine (it just loads nothing), so
    surfacing existence in the UI is the only way to catch it before a run.
    """
    try:
        cfg = json.loads(ENGINE_CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    # Paths the engine WRITES are created on demand — absence is normal and must
    # not be reported as a misconfiguration, or the warning becomes noise.
    write_targets = {"output_folder", "log_folder", "overlap_store"}
    out = []
    for key, value in (cfg.get("paths") or {}).items():
        p = Path(str(value)) if value else None
        exists = bool(p and p.exists())
        out.append({
            "key": key,
            "value": value,
            "exists": exists,
            "writable_target": key in write_targets,
            # Only inputs can be "missing" in the sense that matters.
            "kind": ("dir" if p and p.is_dir() else "file" if p and p.is_file()
                     else "created on run" if key in write_targets else "missing"),
        })
    return {"success": True, "paths": out}


@app.put("/api/engine/config")
async def put_engine_config(data: dict):
    """Replace the engine config. Writes atomically and keeps one backup.

    The worker reads config.json at startup, so a save takes effect on the next
    model load — the response says so rather than pretending it is already live.
    """
    cfg = data.get("config", data)
    if not isinstance(cfg, dict) or not cfg:
        raise HTTPException(status_code=400, detail="Body must be a non-empty config object")
    for required in ("paths", "processing"):
        if required not in cfg:
            raise HTTPException(status_code=400, detail=f"Refusing to save: missing '{required}' section")
    try:
        text = json.dumps(cfg, indent=2, ensure_ascii=False)
        json.loads(text)                                   # never write unparseable JSON
        if ENGINE_CONFIG_PATH.exists():
            ENGINE_CONFIG_PATH.with_suffix(".json.bak").write_text(
                ENGINE_CONFIG_PATH.read_text(encoding="utf-8-sig"), encoding="utf-8")
        tmp = ENGINE_CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, ENGINE_CONFIG_PATH)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not save engine config: {e}")
    logger.info("[EngineConfig] saved %s", ENGINE_CONFIG_PATH)
    return {"success": True, "message": "Saved. Reload the model for changes to take effect.",
            "path": str(ENGINE_CONFIG_PATH)}


# Endpoint to serve dynamic model list from folder
@app.get("/api/models")
async def get_models():
    logger.info("[Models] Incoming request GET /api/models")
    logger.info("[Models] Loading models...")
    start = time.perf_counter()
    try:
        models = config.get_models_list()
    except ModelFolderError as e:
        logger.error("[Models] Model discovery failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:  # pragma: no cover - defensive
        logger.error("[Models] Unexpected error: %s", e)
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")

    duration_ms = (time.perf_counter() - start) * 1000
    logger.info("[Models] Scan duration: %.1f ms", duration_ms)
    logger.info("[Models] Returned model count: %d", len(models))
    return {"success": True, "models": models}


# List local network interfaces for multicast UDP reception.
@app.get("/api/interfaces")
async def get_interfaces():
    logger.info("[Interfaces] Incoming request GET /api/interfaces")
    interfaces = list_network_interfaces()
    logger.info("[Interfaces] Returned %d interface(s)", len(interfaces))
    return {"success": True, "interfaces": interfaces}


# List SDI capture devices (Blackmagic DeckLink) for the SDI source tab.
@app.get("/api/sdi/devices")
async def get_sdi_devices():
    logger.info("[SDI] Incoming request GET /api/sdi/devices")
    devices = list_sdi_devices()
    logger.info("[SDI] Returned %d device(s)", len(devices))
    return {"success": True, "devices": devices}


# FFmpeg / FFprobe diagnostics (paths, availability, versions).
@app.get("/api/ffmpeg")
async def get_ffmpeg_diagnostics():
    logger.info("[Diagnostics] Incoming request GET /api/ffmpeg")
    return {"success": True, "diagnostics": ffmpeg_diagnostics()}


# Whisper / model diagnostics (models + detected backend, no torch import).
@app.get("/api/whisper")
async def get_whisper_diagnostics():
    logger.info("[Diagnostics] Incoming request GET /api/whisper")
    try:
        models = config.get_models_list()
    except ModelFolderError as e:
        return {"success": False, "error": str(e), "models": []}
    return {
        "success": True,
        "model_folder": config._config.get("model_folder"),
        "model_count": len(models),
        "models": models,
    }


# Upload a terminology file for a feed (used by the caption engine's DirectTerminology).
@app.post("/api/terminology/{feed_id}")
async def upload_terminology(feed_id: int, file: UploadFile = File(...)):
    logger.info("[Terminology] Upload for feed %s: %s", feed_id, file.filename)
    dest_dir = Path("data") / f"feed_{feed_id:02d}" / "terminology"
    dest_dir.mkdir(parents=True, exist_ok=True)
    # Sanitise the filename to its basename only.
    safe_name = Path(file.filename or "terms.txt").name
    dest = dest_dir / safe_name
    try:
        content = await file.read()
        dest.write_bytes(content)
    except Exception as e:
        logger.error("[Terminology] Save failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Could not save file: {e}")
    logger.info("[Terminology] Saved %d bytes to %s", len(content), dest)
    return {
        "success": True,
        "feed": feed_id,
        "filename": safe_name,
        "path": str(dest).replace("\\", "/"),
        "dir": str(dest_dir).replace("\\", "/"),
    }


# --------------------------------------------------------------------------- #
# Logs API (Task 2) — feed-wise log retrieval, clear and download
# --------------------------------------------------------------------------- #
@app.get("/api/logs/scopes")
async def get_log_scopes():
    """Return the {scope: [categories]} tree for the Logs page selectors."""
    return {"success": True, "scopes": log_manager.scopes()}


@app.get("/api/logs/{scope}/{category}")
async def get_logs(scope: str, category: str, tail: int = 200, after: int = 0):
    """Return log entries for a scope/category.

    ``after`` (a sequence id) returns only newer entries — used for live polling.
    ``tail`` caps the initial load.
    """
    if scope not in log_manager.scopes():
        raise HTTPException(status_code=404, detail=f"Unknown log scope: {scope}")
    if after:
        entries = log_manager.since(scope, category, after)
    else:
        entries = log_manager.tail(scope, category, max(1, min(tail, 5000)))
    last_seq = entries[-1]["seq"] if entries else after
    return {"success": True, "scope": scope, "category": category,
            "entries": entries, "last_seq": last_seq}


@app.delete("/api/logs/{scope}/{category}")
async def clear_logs(scope: str, category: str):
    ok = log_manager.clear(scope, category)
    api_logger.info("[Logs] Cleared %s/%s -> %s", scope, category, ok)
    return {"success": ok}


@app.get("/api/logs/{scope}/{category}/download")
async def download_logs(scope: str, category: str):
    path = log_manager.file_path(scope, category)
    if not path:
        # Return an empty file rather than 404 so the UI download always works.
        return PlainTextResponse("", headers={
            "Content-Disposition": f'attachment; filename="{scope}_{category}.log"'})
    return FileResponse(str(path), media_type="text/plain",
                        filename=f"{scope}_{category}.log")


# --------------------------------------------------------------------------- #
# Post-processing correction lists (player names / terminology / hallucination)
# --------------------------------------------------------------------------- #
from . import postprocess_lists


@app.get("/api/postprocess")
async def get_postprocess_lists():
    return {"success": True, "lists": postprocess_lists.get_all()}


@app.get("/api/postprocess/{kind}")
async def get_postprocess_list(kind: str):
    try:
        return {"success": True, "kind": kind, "data": postprocess_lists.get(kind)}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown list: {kind}")


@app.put("/api/postprocess/{kind}")
async def save_postprocess_list(kind: str, data: dict):
    try:
        saved = postprocess_lists.save(kind, data)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown list: {kind}")
    api_logger.info("[PostProcess] Updated %s", kind)
    return {"success": True, "kind": kind, "data": saved,
            "note": "Applied on the next processing run (restart/reprocess)."}


# --------------------------------------------------------------------------- #
# CUDA stack diagnostic (Task 1) — why torch is/isn't on the GPU
# --------------------------------------------------------------------------- #
@app.get("/api/cuda")
async def get_cuda():
    return {"success": True, "cuda": device_utils.cuda_report()}


# --------------------------------------------------------------------------- #
# System diagnostics (Task 6)
# --------------------------------------------------------------------------- #
@app.get("/api/diagnostics")
async def get_diagnostics():
    """Aggregate system + per-feed diagnostics for the System Diagnostics panel."""
    import threading
    from .websocket_handler import feed_managers

    sys_stats = get_system_stats()
    feeds = []
    inference_device = "unknown"
    loaded_models = []
    for fid, mgr in feed_managers.items():
        try:
            d = mgr.qc_wrapper.get_diagnostics()
            feeds.append(d)
            if d.get("device") and d["device"] != "unknown":
                inference_device = d["device"]
            di = d.get("device_info") or {}
            if di.get("model"):
                loaded_models.append({"feed": fid, "model": di.get("model"),
                                      "device": di.get("device")})
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("[Diagnostics] feed %s: %s", fid, e)

    gpu_mem = device_utils.gpu_memory()
    return {
        "success": True,
        "system": sys_stats,
        "gpu": {
            "name": device_utils.gpu_name(),
            "memory": gpu_mem,
        },
        "cuda": {
            "torch": device_utils.torch_cuda_available(),
            "ctranslate2": device_utils.ctranslate2_cuda_available(),
        },
        "cuda_report": device_utils.cuda_report(),
        "inference_device": inference_device,
        "loaded_models": loaded_models,
        "active_threads": threading.active_count(),
        "active_feeds": len(feed_managers),
        "feeds": feeds,
    }


# --------------------------------------------------------------------------- #
# Static Media Processing (upload → extract → chunk once → dual-feed compare)
# --------------------------------------------------------------------------- #
@app.post("/api/upload")
async def upload_media(file: UploadFile = File(...), autostart: bool = True):
    """Upload a media file. By default processing starts immediately."""
    api_logger.info("[Upload] Incoming file: %s", file.filename)
    if not static_service.validate_ext(file.filename or ""):
        raise HTTPException(status_code=400,
                            detail=f"Unsupported file type: {file.filename}")
    try:
        rec = await static_service.save_upload(file)   # streamed to disk (no RAM blowup)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("[Upload] Save failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")
    if autostart:
        static_service.start_processing(rec["id"])
    return {"success": True, "upload": static_service.public(rec)}


@app.post("/api/process")
async def process_upload(data: dict):
    """Start (or restart) processing for an uploaded file.

    Body: {"upload_id": ..., "models": ["<model_a_id>", "<model_b_id>"]}
    ``models`` is optional — when given it overrides which two models the
    comparison lanes use (ids from /api/single/models). Omitted → static_config defaults.
    """
    upload_id = data.get("upload_id")
    if not upload_id or not static_service.get(upload_id):
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    models = data.get("models")
    if models:
        static_service.set_compare_models(upload_id, models)
    started = static_service.start_processing(upload_id)
    return {"success": started, "message": "Processing started" if started else "Already running"}


@app.post("/api/upload/{upload_id}/stop")
async def stop_upload(upload_id: str):
    if not static_service.get(upload_id):
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    ok = await static_service.stop_processing(upload_id)
    return {"success": ok, "message": "Processing stopped"}


@app.post("/api/upload/{upload_id}/restart")
async def restart_upload(upload_id: str):
    if not static_service.get(upload_id):
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    ok = await static_service.restart_processing(upload_id)
    return {"success": ok, "message": "Processing restarted"}


@app.get("/api/uploads")
async def list_uploads():
    return {"success": True, "uploads": static_service.list_uploads()}


@app.get("/api/upload/{upload_id}")
async def get_upload(upload_id: str):
    rec = static_service.get(upload_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    return {"success": True, "upload": rec}


@app.get("/api/upload/{upload_id}/status")
async def get_upload_status(upload_id: str):
    st = static_service.status(upload_id)
    if not st:
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    return {"success": True, "status": st}


@app.get("/api/upload/{upload_id}/captions")
async def get_upload_captions(upload_id: str):
    caps = static_service.captions(upload_id)
    if caps is None:
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    return {"success": True, **caps}


@app.get("/api/upload/{upload_id}/chunks")
async def get_upload_chunks(upload_id: str):
    ch = static_service.chunks(upload_id)
    if ch is None:
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    return {"success": True, **ch}


@app.get("/api/upload/{upload_id}/audio")
async def download_upload_audio(upload_id: str):
    rec = static_service._uploads.get(upload_id)
    if not rec or not rec.get("audio_path") or not Path(rec["audio_path"]).exists():
        raise HTTPException(status_code=404, detail="Extracted audio not available")
    return FileResponse(rec["audio_path"], media_type="audio/wav",
                        filename=f"{upload_id}.wav")


@app.delete("/api/upload/{upload_id}")
async def delete_upload(upload_id: str):
    ok = await static_service.delete(upload_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    return {"success": True, "message": "Upload deleted"}


# --------------------------------------------------------------------------- #
# Single Model Transcription (separate page — one model, production pipeline)
# --------------------------------------------------------------------------- #
@app.get("/api/single/models")
async def single_models():
    return {"success": True, "models": static_service.list_lanes_public()}


@app.get("/api/single/pipelines")
async def single_pipelines():
    return {"success": True, "pipelines": static_service.list_pipelines()}


@app.get("/api/single/status")
async def single_status():
    return {"success": True, "status": static_service.single_status()}


@app.get("/api/single/captions")
async def single_captions():
    return {"success": True, **static_service.single_captions()}


@app.post("/api/single/load")
async def single_load(data: dict):
    model_id = data.get("model_id")
    raw_only = bool(data.get("raw_only", False))
    # Transcription language picked in the UI. The checkpoint is multilingual,
    # so this selects the engine/config trio rather than a different model.
    language = str(data.get("language") or "").lower()
    # quick_captions (default) or the id of a script in backend/pipelines/.
    pipeline = str(data.get("pipeline") or "quick_captions")
    try:
        ok = await static_service.single_load(model_id, raw_only=raw_only, language=language,
                                              pipeline=pipeline)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=400, detail=f"Could not load model: {model_id}")
    return {"success": True, "status": static_service.single_status()}


@app.post("/api/single/unload")
async def single_unload():
    await static_service.single_unload()
    return {"success": True}


@app.post("/api/single/start")
async def single_start(data: dict):
    upload_id = data.get("upload_id")
    if not upload_id or not static_service.get(upload_id):
        raise HTTPException(status_code=404, detail="Unknown upload_id")
    ok = await static_service.single_start(upload_id)
    return {"success": ok, "message": "Processing started" if ok else "Load a model first / already running"}


@app.post("/api/single/start_live")
async def single_start_live(data: dict):
    """Run the loaded single model against a live UDP / SDI source."""
    ok, msg = await static_service.single_start_live(
        url=(data.get("url") or "").strip(),
        source_type=(data.get("source_type") or "udp").lower(),
        interface=(data.get("interface") or "").strip(),
        device=(data.get("device") or "").strip(),
    )
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"success": True, "message": msg, "status": static_service.single_status()}


@app.get("/api/single/live-audio")
async def single_live_audio():
    """Monitor feed: stream the live capture's audio as WAV.

    Taps the PCM the chunker is already reading, so you hear exactly what the
    model receives and no second ffmpeg competes for the UDP socket.
    """
    cap = static_service.live_capture()
    if cap is None:
        raise HTTPException(status_code=409, detail="No live capture is running")

    q = cap.add_tap()
    sr, ch = cap.sample_rate, cap.channels

    def wav_header(sample_rate, channels, bits=16):
        # Streaming WAV: length fields are set to "unknown/max" because the
        # stream has no end. Browsers accept this for progressive playback.
        import struct
        byte_rate = sample_rate * channels * bits // 8
        block_align = channels * bits // 8
        return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
                + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate,
                                        byte_rate, block_align, bits)
                + b"data" + struct.pack("<I", 0xFFFFFFFF))

    async def gen():
        yield wav_header(sr, ch)
        try:
            while True:
                if static_service.live_capture() is not cap:
                    break                       # capture stopped/replaced
                try:
                    block = await asyncio.to_thread(q.get, True, 5.0)
                except Exception:
                    break                       # 5s of silence => stream ended
                if block:
                    yield block
        finally:
            cap.remove_tap(q)

    return StreamingResponse(gen(), media_type="audio/wav", headers={
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
    })


@app.post("/api/single/stop")
async def single_stop():
    await static_service.single_stop()
    return {"success": True}


# --------------------------------------------------------------------------- #
# Workspace reset — Fresh Start (Task 15)
# --------------------------------------------------------------------------- #
@app.post("/api/workspace/reset")
async def workspace_reset():
    """Clear all runtime data and return to a clean Idle state.

    Does NOT restart FastAPI or unload the GPU-resident models. Broadcasts a
    ``workspace_reset`` event so every connected client resets its UI.
    """
    from .websocket_handler import feed_managers, broadcast
    from .workspace_reset import reset_workspace

    api_logger.info("[Workspace] Reset requested")
    try:
        summary = await reset_workspace(feed_managers, config)
    except Exception as e:
        logger.error("[Workspace] Reset failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Workspace reset failed: {e}")

    await broadcast({"type": "workspace_reset", "data": summary})
    return {"success": True, "message": "Workspace reset successfully.", "summary": summary}


# Serve frontend if built (optional)
# app.mount("/", StaticFiles(directory="../../frontend/dist", html=True), name="frontend")
