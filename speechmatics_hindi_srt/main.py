#!/usr/bin/env python3
"""Hindi audio -> hindi.srt + english.srt (Speechmatics ASR + local MT).

    python main.py --input input/hindi_audio.wav
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import audio_processor
import speechmatics_client as sm
from config import ConfigError, load_config
from models import Segment
from srt_generator import write_srt
from translator import TranslationError, get_translator, translate_segments
from utils import human_time, setup_logging

EXIT_OK, EXIT_CONFIG, EXIT_AUDIO, EXIT_ASR, EXIT_TRANSLATE = 0, 2, 3, 4, 5


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="main.py",
        description="Transcribe Hindi audio with Speechmatics and emit "
                    "time-aligned Hindi and English SRT files.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--input", required=True, help="audio/video file (.wav .mp3 .m4a .mp4 .flac)")
    p.add_argument("--output", default=None, help="output directory")
    p.add_argument("--source-language", default=None, help="ASR language code")
    p.add_argument("--target-language", default=None, help="translation target")
    p.add_argument("--track", type=int, default=None,
                   help="audio track index for multi-track masters (default: loudest)")
    p.add_argument("--normalize", action="store_true",
                   help="force re-encode to 16 kHz mono PCM before upload")
    p.add_argument("--asr", choices=["speechmatics","local"], default=None,
                   help="ASR backend (default: ASR_BACKEND env)")
    p.add_argument("--no-translate", action="store_true", help="produce hindi.srt only")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


async def run(args) -> int:
    cfg = load_config()
    if args.output:
        cfg.output_dir = Path(args.output)
    if args.source_language:
        cfg.source_language = args.source_language
    if args.target_language:
        cfg.target_language = args.target_language
    if args.asr:
        cfg.asr_backend = args.asr
    if args.no_translate:
        cfg.translation_backend = "none"

    log = setup_logging(cfg.log_dir, args.verbose)
    log.info("Loading configuration")

    try:
        cfg.validate()
    except ConfigError as e:
        log.error("%s", e)
        return EXIT_CONFIG
    log.debug("API key: %s", cfg.redacted_key())

    src = Path(args.input)
    tmp = None
    try:
        upload_path, tmp = audio_processor.prepare(
            src, log, normalize=args.normalize or cfg.normalize_audio, track=args.track)
    except audio_processor.AudioError as e:
        log.error("Audio error: %s", e)
        return EXIT_AUDIO

    try:
        if cfg.asr_backend == "local":
            # Local: your fine-tuned Whisper for the words, WhisperX for the
            # timing. Same Segment output as the cloud path.
            try:
                import asr_local
                got = asr_local.transcribe(
                    upload_path, model_path=cfg.local_model_path,
                    language=cfg.source_language, device=cfg.translation_device,
                    beam_size=cfg.local_beam, logger=log, align=cfg.local_align)
            except Exception as e:
                log.error("Local ASR failed: %s", e)
                return EXIT_ASR
            if got and isinstance(got[0], Segment):
                segments, words = got, []              # alignment unavailable
            else:
                words = got
                segments = asr_local.words_to_segments(
                    words, max_seconds=cfg.max_cue_seconds,
                    max_chars=cfg.max_cue_chars, split_gap=cfg.cue_split_gap)
        else:
            try:
                transcript = await sm.transcribe_file(
                    upload_path, api_key=cfg.api_key, language=cfg.source_language,
                    operating_point=cfg.operating_point, poll_interval=cfg.poll_interval,
                    timeout=cfg.job_timeout, logger=log)
            except Exception as e:
                log.error("Speechmatics failed: %s", e)
                return EXIT_ASR
            words = sm.extract_words(transcript)
            if not words:
                log.error("Speechmatics returned no words — is the audio silent, or the "
                          "language code wrong (source_language=%s)?", cfg.source_language)
                return EXIT_ASR
            segments = sm.words_to_segments(
                words, max_seconds=cfg.max_cue_seconds, max_chars=cfg.max_cue_chars,
                split_gap=cfg.cue_split_gap)
    finally:
        audio_processor.cleanup(tmp)

    if not segments:
        log.error("ASR produced no segments")
        return EXIT_ASR

    log.info("Hindi segments received: %d (%d words, %s of speech) via %s",
             len(segments), len(words), human_time(max(s.end for s in segments)),
             cfg.asr_backend)

    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    log.info("Generating Hindi SRT")
    hi_path = write_srt(segments, cfg.output_dir / "hindi.srt")
    log.info("Wrote %s (%d cues)", hi_path, len(segments))

    if cfg.translation_backend == "none":
        log.info("Translation disabled — Hindi SRT only.")
        return EXIT_OK

    log.info("Starting %s -> %s translation (backend=%s)",
             cfg.source_language, cfg.target_language, cfg.translation_backend)
    try:
        translator = get_translator(cfg.translation_backend, model_name=cfg.local_model,
                                    device=cfg.translation_device, logger=log)
        en_segments = translate_segments(
            segments, translator, source_language=cfg.source_language,
            target_language=cfg.target_language, batch_size=cfg.translation_batch_size,
            retries=cfg.translation_retries, logger=log)
    except (TranslationError, Exception) as e:
        # The Hindi SRT is already on disk and stays there — a translation
        # failure must never cost the transcript that was paid for.
        log.error("Translation failed: %s", e)
        log.error("English SRT NOT generated. Hindi SRT is intact at %s", hi_path)
        return EXIT_TRANSLATE

    log.info("Translation completed")
    log.info("Generating English SRT")
    en_path = write_srt(en_segments, cfg.output_dir / "english.srt")
    log.info("Wrote %s (%d cues)", en_path, len(en_segments))

    # Prove the promise rather than assert it.
    hi_t = [(round(s.start, 3), round(s.end, 3)) for s in segments]
    en_t = [(round(s.start, 3), round(s.end, 3)) for s in en_segments]
    if hi_t == en_t:
        log.info("[sync] OK — %d cues, identical timing in both files", len(hi_t))
    else:
        log.error("[sync] MISMATCH — %d vs %d cues", len(hi_t), len(en_t))
        return EXIT_TRANSLATE

    log.info("Pipeline completed successfully")
    return EXIT_OK


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
