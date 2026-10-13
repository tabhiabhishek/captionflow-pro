"""
workspace_reset.py — Fresh Start / Workspace Reset service (Task 15).

Clears all *runtime* data so a new test can start from a clean Idle state WITHOUT
restarting FastAPI and WITHOUT unloading the AI models from GPU memory.

Key design choice for the "models stay resident on the GPU" requirement:
  Models live inside the per-feed QuickCaptions **worker subprocess**, which is
  spawned on Start. Killing it would unload the model. So a reset:
    * stops the FFmpeg **capture** (no new chunks flow → the feed goes Idle),
    * marks the feed not-running (its keep-alive loop exits),
    * KEEPS the worker subprocess alive (model remains resident on the GPU),
    * clears queues, temp files, counters and diagnostics.
  The next Start reuses the resident model with minimal latency.

Nothing here deletes uploaded media, saved config, prompts, terminology, logs or
model files — only transient runtime artefacts.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("system")

# Transient artefacts to remove from each feed's input/output folders.
_TEMP_PATTERNS = ["*.wav", "*.json", "*.srt", "*.txt", "*.npy"]
_TEMP_EXTRA = [".stop", "overlap_tail.npy"]


def _clear_dir(d: Path) -> int:
    removed = 0
    if not d or not d.exists():
        return 0
    for pat in _TEMP_PATTERNS:
        for f in d.glob(pat):
            try:
                f.unlink()
                removed += 1
            except Exception:
                pass  # locked/in-use file — skip, best effort
    for name in _TEMP_EXTRA:
        p = d / name
        try:
            if p.exists():
                p.unlink()
                removed += 1
        except Exception:
            pass
    return removed


def _reset_wrapper(w) -> None:
    """Zero a QuickCaptionsWrapper's runtime counters/queues (model untouched)."""
    try:
        w._processed.clear()
        w.chunks_done = 0
        w.current_chunk = None
        w._proc_ms_sum = 0.0
        w._proc_ms_n = 0
        w._delay_sum = 0.0
        w._delay_n = 0
        w.last_caption_at = None
        w.last_profile = None
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("[WorkspaceReset] wrapper reset: %s", e)


async def reset_workspace(feed_managers: dict, config, data_root: str = "data") -> dict:
    """Perform the workspace reset. Returns a summary dict."""
    from .feed_manager import PIPELINE_STAGES

    summary = {"feeds_reset": [], "files_removed": 0, "models_kept_resident": True}

    # 1) Reset every active feed manager (keep its worker/model alive).
    for fid, mgr in list(feed_managers.items()):
        try:
            # Stop capture so no new chunks are produced → feed becomes Idle.
            await mgr.capture.stop()
            mgr.capture.chunk_counter = 0
        except Exception as e:
            logger.warning("[WorkspaceReset] feed %s capture stop: %s", fid, e)

        # Exit the keep-alive pipeline loop without killing the worker.
        mgr.is_running = False

        # Clear the worker's queue/counters (model remains loaded on GPU).
        w = mgr.qc_wrapper
        _reset_wrapper(w)
        summary["files_removed"] += _clear_dir(getattr(w, "input_dir", None))
        summary["files_removed"] += _clear_dir(getattr(w, "output_dir", None))

        # Reset pipeline stage indicators to Idle and notify this feed's socket.
        mgr._stage_state = {s: "waiting" for s in PIPELINE_STAGES}
        try:
            await mgr._set_stage("frontend", "waiting")
        except Exception:
            pass
        summary["feeds_reset"].append(fid)

    # 2) Sweep any feed data folders that have no live manager (leftover temp).
    root = Path(data_root)
    if root.exists():
        for feed_dir in root.glob("feed_*"):
            summary["files_removed"] += _clear_dir(feed_dir / "input")
            summary["files_removed"] += _clear_dir(feed_dir / "output")

    logger.info("[WorkspaceReset] Reset complete: feeds=%s files_removed=%s (models kept resident)",
                summary["feeds_reset"], summary["files_removed"])
    return summary
