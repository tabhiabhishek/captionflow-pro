"""Local ASR backend: your fine-tuned Whisper for the words, WhisperX for the
timing.

Peer of `speechmatics_client.py` — both emit `List[Segment]` and nothing
downstream knows which produced them. Selected with ASR_BACKEND=local.

Why the split:
  * The fine-tuned checkpoint transcribes Hindi acceptably but its timestamp
    tokens are degraded, so asking it for timings yields 60s+ subtitle blocks.
  * WhisperX forced-alignment ignores the model's timestamps entirely and
    aligns the TEXT against the AUDIO with a wav2vec2 CTC model, producing
    real word-level times.

So: model decides the words, WhisperX decides when they were said.

Translation is deliberately NOT done here. `task=translate` on this checkpoint
is broken (it returns Hindi ~78% of the time), so English is produced by the
text translator in `translator.py`, which is a separate module.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, List

from models import Segment, Word

DEVANAGARI = (0x0900, 0x097F)


class LocalASRError(RuntimeError):
    pass


def _device(pref: str = "auto") -> str:
    try:
        import torch
        if pref == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        return pref
    except Exception:
        return "cpu"


def find_model_dir(root: str | Path):
    """Same resolution rule as quick_captions.py — accept a folder holding the
    weights, or any parent of one."""
    root = Path(root)
    if not root.exists():
        return None
    if any(root.glob("*.safetensors")) or (root / "pytorch_model.bin").exists():
        return root
    for hit in sorted(root.rglob("*.safetensors")):
        return hit.parent
    return None


def detect_speech(wav: Path, total: float, *, logger, noise_db: int = -35,
                  min_sil: float = 0.35, pad: float = 0.15,
                  max_len: float = 14.0, min_len: float = 0.4):
    """Speech regions via ffmpeg silencedetect, inverted.

    Used only to decide what audio the model sees per decode — the resulting
    timings are thrown away and replaced by WhisperX word alignment.
    """
    import os
    import subprocess
    ff = os.getenv("FFMPEG_BINARY") or r"C:\Tools\ffmpeg\dist\ffmpeg.exe"
    if not Path(ff).exists():
        ff = "ffmpeg"
    r = subprocess.run(
        [ff, "-hide_banner", "-nostats", "-i", str(wav),
         "-af", f"silencedetect=n={noise_db}dB:d={min_sil}", "-f", "null", os.devnull],
        capture_output=True, text=True)
    starts, ends = [], []
    for line in (r.stderr or "").splitlines():
        for key, bucket in (("silence_start:", starts), ("silence_end:", ends)):
            if key in line:
                try:
                    bucket.append(float(line.split(key)[1].strip().split()[0]))
                except Exception:
                    pass
    regions, cursor = [], 0.0
    for i, s in enumerate(starts):
        if s > cursor:
            regions.append((cursor, s))
        cursor = ends[i] if i < len(ends) else s
    if cursor < total:
        regions.append((cursor, total))
    out = []
    for s, e in regions:
        s, e = max(0.0, s - pad), min(total, e + pad)
        if e - s < min_len:
            continue
        while e - s > max_len:
            out.append((s, s + max_len))
            s += max_len
        out.append((s, e))
    if not out:
        logger.warning("VAD found no speech — falling back to one whole-file region")
        out = [(0.0, total)]
    return out


def _strip_wrong_script(text: str, keep_devanagari: bool = True) -> str:
    """Drop words in the wrong script.

    The checkpoint leaks English clauses into Hindi output; a file labelled
    Hindi must not carry them. Digits/punctuation are script-neutral and kept.
    """
    out = []
    for w in (text or "").split():
        dev = sum(1 for c in w if DEVANAGARI[0] <= ord(c) <= DEVANAGARI[1])
        lat = sum(1 for c in w if c.isascii() and c.isalpha())
        if dev == 0 and lat == 0:
            out.append(w)
        elif keep_devanagari and dev >= lat:
            out.append(w)
        elif not keep_devanagari and lat >= dev:
            out.append(w)
    return " ".join(out).strip()


def transcribe(audio_path: Path, *, model_path: str, language: str,
               device: str = "auto", beam_size: int = 1,
               vad_chunk_s: float = 30.0, logger: logging.Logger,
               align: bool = True, decode_kwargs: dict | None = None) -> List[Segment]:
    """Run the local model, then align with WhisperX. Returns Hindi segments."""
    import numpy as np
    import torch
    import whisperx
    from transformers import pipeline as hf_pipeline

    dev = _device(device)
    mdir = find_model_dir(model_path)
    if mdir is None:
        raise LocalASRError(f"no model weights under {model_path}")

    logger.info("Loading local ASR model %s on %s", Path(mdir).name, dev)
    asr = hf_pipeline("automatic-speech-recognition", model=str(mdir),
                      device=0 if dev == "cuda" else -1,
                      torch_dtype=torch.float16 if dev == "cuda" else torch.float32)

    audio = whisperx.load_audio(str(audio_path))       # 16 kHz mono float32
    dur = len(audio) / 16000.0
    logger.info("Audio: %.1f min", dur / 60)

    # --- 1. words -------------------------------------------------------
    # Decode PER SPEECH REGION, not on a 30s sliding window. This checkpoint
    # emits far more text when handed a short utterance than when handed 30s
    # at once (measured: 12k chars vs 4.5k over the same 33min), and its own
    # timestamps are ignored either way because WhisperX re-times below.
    gk = {"language": language, "task": "transcribe", "num_beams": beam_size}
    gk.update(decode_kwargs or {})

    spans = detect_speech(audio_path, dur, logger=logger)
    logger.info("Transcribing %d speech regions (beam=%d)…", len(spans), beam_size)
    rough: List[dict] = []
    for i, (s, e) in enumerate(spans):
        clip = audio[int(s * 16000):int(e * 16000)]
        if clip.size < int(0.2 * 16000):
            continue
        out = asr({"raw": clip, "sampling_rate": 16000}, generate_kwargs=gk)
        txt = _strip_wrong_script((out.get("text") or "").strip())
        if txt:
            rough.append({"start": float(s), "end": float(e), "text": txt})
        if (i + 1) % 60 == 0:
            logger.info("   %d/%d regions", i + 1, len(spans))
    if not rough:
        raise LocalASRError("model produced no Hindi text")
    logger.info("Model produced %d rough segments (%d chars)",
                len(rough), sum(len(r["text"]) for r in rough))

    if not align:
        return [Segment(r["start"], r["end"], r["text"]) for r in rough]

    # --- 2. real timings ------------------------------------------------
    logger.info("Loading WhisperX align model for '%s' on %s", language, dev)
    try:
        amodel, meta = whisperx.load_align_model(language_code=language, device=dev)
    except Exception as e:
        raise LocalASRError(
            f"no WhisperX alignment model for language {language!r}: {e}\n"
            "Set ALIGN=0 to fall back to the model's own (unreliable) timings.") from e

    logger.info("Aligning %d segments against the audio…", len(rough))
    aligned = whisperx.align(rough, amodel, meta, audio, dev,
                             return_char_alignments=False)

    words: List[Word] = []
    for seg in aligned.get("segments", []):
        for w in seg.get("words", []) or []:
            t, s, e = w.get("word"), w.get("start"), w.get("end")
            if t and s is not None and e is not None:
                words.append(Word(float(s), float(e), t.strip()))
    if not words:
        logger.warning("Alignment returned no word timings — keeping rough segments")
        return [Segment(r["start"], r["end"], r["text"]) for r in rough]

    logger.info("Aligned %d words", len(words))
    return words


def words_to_segments(words: List[Word], *, max_seconds: float, max_chars: int,
                      split_gap: float) -> List[Segment]:
    """Identical cue-building rule to the Speechmatics path, so both backends
    produce comparably shaped subtitles. Cue times are always real word times."""
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
