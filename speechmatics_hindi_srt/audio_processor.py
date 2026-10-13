"""Audio validation and optional normalisation.

Speechmatics accepts wav/mp3/m4a/mp4/flac directly, so the default is to upload
the file untouched — re-encoding costs time and throws away quality. ffmpeg is
used only when asked (NORMALIZE_AUDIO=1 / --normalize) or when a container
carries several audio tracks and one must be chosen.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

SUPPORTED = {".wav", ".mp3", ".m4a", ".mp4", ".flac"}
TARGET_RATE = 16000


class AudioError(RuntimeError):
    pass


def _bin(name: str) -> str:
    for env in (f"{name.upper()}_BINARY", f"{name.upper()}_PATH"):
        v = os.getenv(env)
        if v and Path(v).exists():
            return v
    found = shutil.which(name)
    if found:
        return found
    fallback = Path(rf"C:\Tools\ffmpeg\dist\{name}.exe")
    return str(fallback) if fallback.exists() else name


def probe(path: Path) -> dict:
    out = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise AudioError(f"ffprobe failed on {path.name}: {(out.stderr or '').strip()[:300]}")
    return json.loads(out.stdout or "{}")


def audio_streams(info: dict) -> List[dict]:
    return [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]


def validate(path: Path, logger: logging.Logger) -> Tuple[dict, List[dict]]:
    if not path.exists():
        raise AudioError(f"input file not found: {path}")
    if path.suffix.lower() not in SUPPORTED:
        raise AudioError(
            f"unsupported extension {path.suffix!r}. Supported: {', '.join(sorted(SUPPORTED))}")
    info = probe(path)
    streams = audio_streams(info)
    if not streams:
        raise AudioError(f"{path.name} contains no audio stream")
    dur = float(info.get("format", {}).get("duration") or 0.0)
    logger.info("Input file: %s (%.1f min, %d audio track(s))", path.name, dur / 60, len(streams))
    return info, streams


def mean_volume(path: Path, track: int, seconds: int = 45, offset: int = 60) -> float:
    """Mean dBFS of one track — used to find the programme mix in a master
    that carries many mono stems, most of them silent."""
    r = subprocess.run(
        [_bin("ffmpeg"), "-hide_banner", "-nostats", "-ss", str(offset), "-t", str(seconds),
         "-i", str(path), "-map", f"0:a:{track}", "-af", "volumedetect",
         "-f", "null", os.devnull],
        capture_output=True, text=True)
    for line in (r.stderr or "").splitlines():
        if "mean_volume:" in line:
            try:
                return float(line.split("mean_volume:")[1].strip().split()[0])
            except Exception:
                pass
    return -999.0


def pick_loudest_track(path: Path, count: int, logger: logging.Logger) -> Optional[int]:
    if count <= 1:
        return None
    levels = [(i, mean_volume(path, i)) for i in range(count)]
    levels.sort(key=lambda t: t[1], reverse=True)
    best, best_db = levels[0]
    logger.info("Multi-track file: choosing a:%d (%.1f dB). Others: %s", best, best_db,
                ", ".join(f"a:{i}={d:.0f}" for i, d in levels[1:6]))
    if best_db <= -80:
        raise AudioError("every audio track is silent — check the file or pass --track")
    return best


def to_wav16k(src: Path, track: Optional[int], logger: logging.Logger) -> Path:
    """Decode to 16 kHz mono PCM in a temp file the caller must delete."""
    tmp = Path(tempfile.mkdtemp(prefix="sm_audio_")) / f"{src.stem}_16k.wav"
    cmd = [_bin("ffmpeg"), "-y", "-loglevel", "error", "-i", str(src), "-vn"]
    if track is not None:
        cmd += ["-map", f"0:a:{track}"]
    cmd += ["-ac", "1", "-ar", str(TARGET_RATE), "-c:a", "pcm_s16le", str(tmp)]
    logger.info("Normalising audio -> %d Hz mono PCM%s",
                TARGET_RATE, f" (track a:{track})" if track is not None else "")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not tmp.exists():
        raise AudioError(f"ffmpeg failed: {(r.stderr or '').strip()[:300]}")
    return tmp


def prepare(path: Path, logger: logging.Logger, *, normalize: bool = False,
            track: Optional[int] = None) -> Tuple[Path, Optional[Path]]:
    """Returns (path_to_upload, temp_to_cleanup_or_None)."""
    info, streams = validate(path, logger)

    if track is None and len(streams) > 1:
        track = pick_loudest_track(path, len(streams), logger)

    if not normalize and track is None:
        logger.info("Uploading original file unchanged (Speechmatics accepts %s)", path.suffix)
        return path, None

    tmp = to_wav16k(path, track, logger)
    return tmp, tmp


def cleanup(tmp: Optional[Path]) -> None:
    if not tmp:
        return
    try:
        tmp.unlink(missing_ok=True)
        tmp.parent.rmdir()
    except Exception:
        pass
