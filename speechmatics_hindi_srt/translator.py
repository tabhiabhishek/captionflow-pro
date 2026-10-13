"""Translation layer.

`Translator` is the swap point: implement the interface, register it in
`get_translator`, and nothing in the SRT code changes. Translators receive and
return TEXT ONLY — timings never reach this module, which is what makes the
two SRT files structurally impossible to desynchronise.

Default backend: Helsinki-NLP/opus-mt-hi-en (MarianMT)
  ~300 MB, downloads once to the HuggingFace cache
  (%USERPROFILE%\\.cache\\huggingface on Windows, ~/.cache/huggingface on Linux)
  Runs fine on CPU (~20-40 cues/s); uses the GPU automatically if torch sees one.
  Swap it with LOCAL_TRANSLATION_MODEL=<any seq2seq MT model>.
"""

from __future__ import annotations

import logging
from typing import List

from models import Segment
from utils import chunked, retry


class TranslationError(RuntimeError):
    pass


class Translator:
    """Interface. Implementations must be pure text-in/text-out."""

    name = "base"

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        raise NotImplementedError

    def translate_batch(self, texts: List[str], source_language: str,
                        target_language: str) -> List[str]:
        """Default: one at a time. Backends override for real batching.
        MUST return exactly len(texts) items, order preserved."""
        return [self.translate(t, source_language, target_language) for t in texts]


class LocalMarianTranslator(Translator):
    """MarianMT via transformers, loaded once and reused."""

    name = "local"

    def __init__(self, model_name: str, device: str = "auto",
                 logger: logging.Logger | None = None):
        self.model_name = model_name
        self.log = logger or logging.getLogger("pipeline")
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        except Exception as e:                                  # pragma: no cover
            raise TranslationError(
                f"transformers/torch missing ({e}). pip install -r requirements.txt") from e

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.log.info("Loading translation model %s on %s (first run downloads ~300 MB)",
                      model_name, device)
        try:
            self.tok = AutoTokenizer.from_pretrained(model_name)
            self.model = AutoModelForSeq2SeqLM.from_pretrained(model_name).to(device).eval()
        except Exception as e:
            raise TranslationError(
                f"could not load {model_name!r}: {e}\n"
                "If offline, pre-download it once on a connected machine, or set "
                "TRANSLATION_BACKEND=none to produce the Hindi SRT only.") from e
        self._torch = torch

    def translate(self, text: str, source_language: str, target_language: str) -> str:
        return self.translate_batch([text], source_language, target_language)[0]

    def translate_batch(self, texts: List[str], source_language: str,
                        target_language: str) -> List[str]:
        if not texts:
            return []
        # Batched as a padded tensor, so each input still maps 1:1 to its own
        # output row — cue N in, cue N out. Never joined into one string.
        enc = self.tok(texts, return_tensors="pt", padding=True,
                       truncation=True, max_length=512).to(self.device)
        with self._torch.no_grad():
            gen = self.model.generate(**enc, num_beams=4, max_new_tokens=512)
        out = self.tok.batch_decode(gen, skip_special_tokens=True)
        if len(out) != len(texts):                              # pragma: no cover
            raise TranslationError(
                f"backend returned {len(out)} translations for {len(texts)} inputs")
        return [o.strip() for o in out]


class NullTranslator(Translator):
    """TRANSLATION_BACKEND=none — Hindi SRT only."""
    name = "none"

    def translate(self, text, source_language, target_language):
        raise TranslationError("translation backend is disabled (TRANSLATION_BACKEND=none)")


def get_translator(backend: str, *, model_name: str, device: str = "auto",
                   logger: logging.Logger | None = None) -> Translator:
    if backend == "local":
        return LocalMarianTranslator(model_name, device=device, logger=logger)
    if backend == "none":
        return NullTranslator()
    raise TranslationError(f"unknown TRANSLATION_BACKEND={backend!r}")


def translate_segments(segments: List[Segment], translator: Translator, *,
                       source_language: str, target_language: str,
                       batch_size: int, retries: int,
                       logger: logging.Logger) -> List[Segment]:
    """Translate cue text while keeping every timing byte-identical.

    Uses `Segment.with_text`, so a translated cue physically cannot carry a
    different start/end than its source cue. A batch that fails after retries
    falls back to per-cue translation, and any cue that still fails keeps its
    slot with the ORIGINAL text rather than silently vanishing — the caller
    decides what to do about it.
    """
    out: List[Segment] = []
    failures = 0
    batches = list(chunked(segments, batch_size))
    for bi, batch in enumerate(batches, 1):
        texts = [s.text for s in batch]
        try:
            translated = retry(
                lambda: translator.translate_batch(texts, source_language, target_language),
                attempts=retries, logger=logger, what=f"translation batch {bi}/{len(batches)}")
        except Exception as e:
            logger.error("Batch %d/%d failed after %d attempts (%s) — falling back to per-cue",
                         bi, len(batches), retries, e)
            translated = []
            for seg in batch:
                try:
                    translated.append(retry(
                        lambda s=seg: translator.translate(s.text, source_language, target_language),
                        attempts=retries, logger=logger, what="single-cue translation"))
                except Exception as e2:
                    logger.error("Cue at %.3fs could not be translated: %s", seg.start, e2)
                    translated.append(seg.text)     # keep the slot; keep the timing
                    failures += 1

        for seg, txt in zip(batch, translated):
            out.append(seg.with_text(txt))
        if bi % 10 == 0 or bi == len(batches):
            logger.info("Translated %d/%d cues", len(out), len(segments))

    if failures:
        logger.warning("%d cue(s) kept their original Hindi text (translation failed)", failures)
    return out
