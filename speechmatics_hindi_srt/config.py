"""Configuration, loaded from environment / .env. No secrets in code."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).parent.resolve()

# override=False: a real environment variable (CI, systemd, container) always
# beats a stale .env left on a developer box.
load_dotenv(ROOT / ".env", override=False)


class ConfigError(RuntimeError):
    pass


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Config:
    # ASR backend: "speechmatics" (cloud) or "local" (your fine-tuned Whisper
    # + WhisperX word alignment). Translation is unaffected either way.
    asr_backend: str = os.getenv("ASR_BACKEND", "speechmatics")
    local_model_path: str = os.getenv("LOCAL_ASR_MODEL", r"C:/model_ai/Model/28_07_2026_model")
    local_beam: int = int(os.getenv("LOCAL_ASR_BEAM", "1"))
    local_align: bool = _bool("LOCAL_ASR_ALIGN", True)
    api_key: str = field(default_factory=lambda: os.getenv("SPEECHMATICS_API_KEY", "").strip())
    source_language: str = os.getenv("SPEECHMATICS_LANGUAGE", "hi")
    target_language: str = os.getenv("TARGET_LANGUAGE", "en")
    translation_backend: str = os.getenv("TRANSLATION_BACKEND", "local")
    output_dir: Path = field(default_factory=lambda: Path(os.getenv("OUTPUT_DIR", "output")))
    log_dir: Path = field(default_factory=lambda: Path(os.getenv("LOG_DIR", "logs")))

    # Speechmatics
    operating_point: str = os.getenv("SPEECHMATICS_OPERATING_POINT", "enhanced")
    poll_interval: float = float(os.getenv("SPEECHMATICS_POLL_INTERVAL", "5"))
    job_timeout: float = float(os.getenv("SPEECHMATICS_TIMEOUT", "3600"))

    # Subtitle shaping. Speechmatics returns word-level timings; these decide
    # where one cue ends and the next begins. Cue times are always real word
    # times — these only choose the split points.
    max_cue_seconds: float = float(os.getenv("MAX_CUE_SECONDS", "6.0"))
    max_cue_chars: int = int(os.getenv("MAX_CUE_CHARS", "84"))
    cue_split_gap: float = float(os.getenv("CUE_SPLIT_GAP", "0.6"))

    # Translation
    local_model: str = os.getenv("LOCAL_TRANSLATION_MODEL", "Helsinki-NLP/opus-mt-hi-en")
    translation_batch_size: int = int(os.getenv("TRANSLATION_BATCH_SIZE", "16"))
    translation_retries: int = int(os.getenv("TRANSLATION_RETRIES", "3"))
    translation_device: str = os.getenv("TRANSLATION_DEVICE", "auto")  # auto|cpu|cuda

    normalize_audio: bool = _bool("NORMALIZE_AUDIO", False)

    def validate(self) -> None:
        if self.asr_backend not in ("speechmatics", "local"):
            raise ConfigError(f"ASR_BACKEND={self.asr_backend!r} — use 'speechmatics' or 'local'")
        # A local run needs no cloud key at all.
        if self.asr_backend == "local":
            if not Path(self.local_model_path).exists():
                raise ConfigError(f"LOCAL_ASR_MODEL not found: {self.local_model_path}")
        elif not self.api_key:
            raise ConfigError(
                "SPEECHMATICS_API_KEY is not set.\n"
                "  1. cp .env.example .env\n"
                "  2. put your key in .env  ->  SPEECHMATICS_API_KEY=your_key_here\n"
                "  Get a key at https://portal.speechmatics.com/ (Settings -> API Keys).\n"
                "  A real environment variable of the same name also works and wins."
            )
        if self.translation_backend not in ("local", "none"):
            raise ConfigError(
                f"TRANSLATION_BACKEND={self.translation_backend!r} is not implemented. "
                "Use 'local', or 'none' to skip the English SRT."
            )

    def redacted_key(self) -> str:
        k = self.api_key
        return f"{k[:4]}…{k[-4:]} ({len(k)} chars)" if len(k) > 10 else "set"


def load_config() -> Config:
    return Config()
