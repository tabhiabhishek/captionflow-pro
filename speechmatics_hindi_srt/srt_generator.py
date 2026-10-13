"""Segments -> SRT. Pure functions, no I/O beyond the final write, so this is
independently testable."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, List

from models import Segment

SUPPORTED_AUDIO = {".wav", ".mp3", ".m4a", ".mp4", ".flac"}


def format_timestamp(seconds: float) -> str:
    """Seconds -> 'HH:MM:SS,mmm'.

    Negative input clamps to zero; rounding is done in integer milliseconds so
    59.9996 becomes 00:01:00,000 rather than 00:00:60,000.
    """
    if seconds is None or seconds != seconds:        # None or NaN
        seconds = 0.0
    ms_total = int(round(max(0.0, float(seconds)) * 1000))
    h, ms_total = divmod(ms_total, 3_600_000)
    m, ms_total = divmod(ms_total, 60_000)
    s, ms = divmod(ms_total, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def sanitize_text(text: str) -> str:
    """Collapse whitespace and strip blank lines. Unicode is left untouched —
    Devanagari must survive byte-for-byte."""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln).strip()


def normalize_segments(segments: Iterable[Segment], *, min_duration: float = 0.24) -> List[Segment]:
    """Order, de-overlap and drop empties — everything needed for valid SRT.

    Overlaps are resolved by trimming the EARLIER cue's end, never by moving a
    start: a start time is where a word actually begins, and shifting it would
    desynchronise the subtitle from the audio.
    """
    clean: List[Segment] = []
    for s in segments:
        txt = sanitize_text(s.text)
        if not txt:
            continue
        start = max(0.0, float(s.start))
        end = float(s.end)
        if end <= start:
            end = start + min_duration
        clean.append(Segment(start=start, end=end, text=txt))

    clean.sort(key=lambda x: (x.start, x.end))

    out: List[Segment] = []
    for seg in clean:
        if out and seg.start < out[-1].end:
            prev = out[-1]
            trimmed = min(prev.end, seg.start)
            if trimmed - prev.start >= min_duration:
                out[-1] = Segment(prev.start, trimmed, prev.text)
            else:
                # Too short to trim without making the previous cue unreadable;
                # nudge this cue's start instead (last resort, sub-frame).
                seg = Segment(prev.end, max(prev.end + min_duration, seg.end), seg.text)
        out.append(seg)
    return out


def build_srt(segments: Iterable[Segment]) -> str:
    """Render SRT text. Numbering is always 1..N with no gaps."""
    blocks = []
    for i, seg in enumerate(normalize_segments(segments), start=1):
        blocks.append(
            f"{i}\n{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}\n{seg.text}\n"
        )
    return "\n".join(blocks)


def write_srt(segments: Iterable[Segment], path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # utf-8-sig: players (VLC, Premiere) are far more reliable at detecting
    # UTF-8 Devanagari when the BOM is present.
    path.write_text(build_srt(segments), encoding="utf-8-sig")
    return path


def parse_srt(text: str) -> List[Segment]:
    """Read an SRT back into segments — used by the tests to prove that the
    Hindi and English files carry identical timings."""
    pat = re.compile(
        r"(\d+)\s*\n(\d\d):(\d\d):(\d\d),(\d{3})\s*-->\s*(\d\d):(\d\d):(\d\d),(\d{3})\s*\n(.*?)(?=\n\s*\n|\Z)",
        re.S,
    )
    out = []
    for m in pat.finditer(text.lstrip("﻿")):
        g = m.groups()
        start = int(g[1]) * 3600 + int(g[2]) * 60 + int(g[3]) + int(g[4]) / 1000
        end = int(g[5]) * 3600 + int(g[6]) * 60 + int(g[7]) + int(g[8]) / 1000
        out.append(Segment(start, end, g[9].strip()))
    return out
