"""Speechmatics Batch API client.

=== THIS FILE IS THE ONLY PLACE THAT DEPENDS ON THE SPEECHMATICS SDK ===
SDK: `speechmatics-batch` (import root `speechmatics.batch`), verified against
version 0.5.0 by introspection, not from a doc example. The API used here:

    AsyncClient(api_key=...)                     -> async context manager
    TranscriptionConfig(language=..., operating_point=..., enable_entities=...)
    await client.transcribe(path, transcription_config=..., polling_interval=,
                            timeout=)            -> Transcript (JSON format)
    Transcript.results                           -> word/punctuation items

If Speechmatics changes the SDK, only this module needs updating; the rest of
the pipeline speaks in `Segment` objects.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, List

from models import Segment, Word

try:
    from speechmatics.batch import (AsyncClient, Model, OperatingPoint,
                                    TranscriptionConfig)
    SDK_AVAILABLE = True
    SDK_IMPORT_ERROR = ""
except Exception as _e:                                   # pragma: no cover
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR = str(_e)


class SpeechmaticsError(RuntimeError):
    pass


def _as_dict(obj: Any) -> dict:
    if isinstance(obj, dict):
        return obj
    for attr in ("to_dict", "model_dump", "dict"):
        f = getattr(obj, attr, None)
        if callable(f):
            try:
                return f()
            except Exception:
                pass
    return getattr(obj, "__dict__", {}) or {}


def extract_words(transcript: Any) -> List[Word]:
    """Pull word-level timings out of a JSON-v2 transcript.

    Speechmatics returns one item per token with `start_time`, `end_time` and
    `alternatives[0].content`. Punctuation arrives as its own zero-length item
    and is glued onto the previous word rather than becoming a subtitle of its
    own. No timestamp is ever computed here — they come from the API as-is.
    """
    results = getattr(transcript, "results", None)
    if results is None:
        results = _as_dict(transcript).get("results") or []

    words: List[Word] = []
    for item in results:
        d = _as_dict(item)
        alts = d.get("alternatives") or []
        content = ""
        if alts:
            content = (_as_dict(alts[0]).get("content") or "").strip()
        if not content:
            continue
        start = d.get("start_time")
        end = d.get("end_time")
        if start is None or end is None:
            continue
        is_punct = (d.get("type") == "punctuation")
        attaches = d.get("attaches_to") == "previous"
        if (is_punct or attaches) and words:
            prev = words[-1]
            words[-1] = Word(prev.start, max(prev.end, float(end)), prev.content + content)
            continue
        words.append(Word(float(start), float(end), content))
    return words


def words_to_segments(words: List[Word], *, max_seconds: float, max_chars: int,
                      split_gap: float) -> List[Segment]:
    """Group words into subtitle cues.

    A cue ends on sentence punctuation, on a pause longer than `split_gap`, or
    when it would get too long/wide to read. Cue start = first word's start,
    cue end = last word's end — always real API timings, never interpolated.
    """
    segments: List[Segment] = []
    buf: List[Word] = []

    def flush():
        if buf:
            segments.append(Segment(buf[0].start, buf[-1].end,
                                    " ".join(w.content for w in buf)))
            buf.clear()

    for w in words:
        if buf:
            gap = w.start - buf[-1].end
            width = sum(len(x.content) + 1 for x in buf) + len(w.content)
            span = w.end - buf[0].start
            if gap >= split_gap or width > max_chars or span > max_seconds:
                flush()
        buf.append(w)
        if w.content.endswith(("।", ".", "?", "!")):
            flush()
    flush()
    return segments


async def transcribe_file(audio_path: Path, *, api_key: str, language: str,
                          operating_point: str, poll_interval: float,
                          timeout: float, logger: logging.Logger) -> Any:
    """Submit the file and wait. Returns the raw Transcript."""
    if not SDK_AVAILABLE:
        raise SpeechmaticsError(
            f"speechmatics-batch is not installed ({SDK_IMPORT_ERROR}). "
            "Run: pip install -r requirements.txt")

    # SDK 0.5.0 deprecates `operating_point` in favour of `model`; both accept
    # the same values ("standard" / "enhanced"). Prefer `model`, and fall back
    # only if this SDK build predates it.
    kwargs = {"language": language}
    try:
        kwargs["model"] = Model(operating_point)
    except Exception:
        try:
            kwargs["operating_point"] = OperatingPoint(operating_point)
        except Exception:
            logger.warning("Unknown model/operating_point %r — using the API default",
                           operating_point)
    tc = TranscriptionConfig(**kwargs)

    logger.info("Uploading audio to Speechmatics (language=%s, operating_point=%s)",
                language, operating_point)
    async with AsyncClient(api_key=api_key) as client:
        logger.info("Speechmatics transcription started")
        transcript = await client.transcribe(
            str(audio_path),
            transcription_config=tc,
            polling_interval=poll_interval,
            timeout=timeout,
        )
    logger.info("Speechmatics transcription completed")
    return transcript
