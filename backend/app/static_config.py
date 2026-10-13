"""
static_config.py — loader for the static-compare orchestration config
(config/static_config.json, schema model_ai_v2).

This is the ORCHESTRATION config: it defines the model lanes (array → N models),
chunk generation, dispatch mode and per-model raw/processed output folders. It is
separate from the ASR engine config (backend/app/config.json) which drives the
quick_captions.py text pipeline (grammar, hallucination lists, terminology, dedup).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger("system")

# Resolve the config path robustly regardless of CWD.
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CANDIDATES = [
    os.environ.get("VAAK_STATIC_CONFIG"),
    "config/static_config.json",
    str(_PROJECT_ROOT / "config" / "static_config.json"),
]


def _resolve_path() -> Path | None:
    for c in _CANDIDATES:
        if not c:
            continue
        p = Path(c)
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        if p.exists():
            return p
    return None


def load_static_config() -> Dict[str, Any]:
    """Load static_config.json, or {} if absent/invalid (callers fall back)."""
    p = _resolve_path()
    if not p:
        logger.info("[StaticConfig] No static_config.json found — using live-feed defaults")
        return {}
    try:
        cfg = json.loads(p.read_text(encoding="utf-8-sig"))
        logger.info("[StaticConfig] Loaded %s (%d model lanes)",
                    p, len(enabled_models(cfg)))
        return cfg
    except Exception as e:
        logger.error("[StaticConfig] Failed to parse %s: %s — using defaults", p, e)
        return {}


def enabled_models(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The enabled model lanes, in order (the dispatcher iterates these)."""
    return [m for m in cfg.get("models", []) if m.get("enabled", True)]
