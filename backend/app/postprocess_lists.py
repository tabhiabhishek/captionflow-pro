"""
postprocess_lists.py — user-editable correction lists applied in the POST-PROCESSING
pipeline of quick_captions.py:

  config/postprocess/
    players.json        {"names": ["Kohli", "Bumrah", ...]}          → proper-noun capitalisation
    terminology.json    {"fixes": {"boomra": "Bumrah", ...}}         → wrong→correct replacement
    hallucination.json  {"exact": [...], "starts_with": [...]}       → whole-line hallucination drop

These are read by the engine at startup (DirectTerminology + TextProcessor) and edited
from the Settings UI via /api/postprocess. Shared by Live and Static post-processing.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

logger = logging.getLogger("system")

_ROOT = Path(__file__).resolve().parents[2]
POSTPROCESS_DIR = Path(os.environ.get("VAAK_POSTPROCESS_DIR") or (_ROOT / "config" / "postprocess"))

FILES = {
    "players": "players.json",
    "terminology": "terminology.json",
    "hallucination": "hallucination.json",
}


def _seed_defaults() -> Dict[str, Any]:
    """Seed from the engine config so the lists start populated, not empty."""
    players, halluc_exact, halluc_starts = [], [], []
    try:
        cfg = json.loads((Path(__file__).parent / "config.json").read_text(encoding="utf-8-sig"))
        players = cfg.get("player_names", {}).get("cricket", []) or []
        g = cfg.get("grammar", {})
        halluc_exact = g.get("hallucination_exact", []) or []
        halluc_starts = g.get("hallucination_starts", []) or []
    except Exception:
        pass
    return {
        "players": {"names": players},
        "terminology": {"fixes": {}},
        "hallucination": {"exact": halluc_exact, "starts_with": halluc_starts},
    }


def _path(kind: str) -> Path:
    return POSTPROCESS_DIR / FILES[kind]


def ensure() -> None:
    """Create the folder + seed any missing files."""
    POSTPROCESS_DIR.mkdir(parents=True, exist_ok=True)
    defaults = _seed_defaults()
    for kind, fname in FILES.items():
        p = POSTPROCESS_DIR / fname
        if not p.exists():
            p.write_text(json.dumps(defaults[kind], indent=2, ensure_ascii=False), encoding="utf-8")


def get(kind: str) -> Dict[str, Any]:
    if kind not in FILES:
        raise KeyError(kind)
    ensure()
    try:
        return json.loads(_path(kind).read_text(encoding="utf-8-sig"))
    except Exception as e:
        logger.warning("[PostProcess] read %s failed: %s", kind, e)
        return _seed_defaults()[kind]


def get_all() -> Dict[str, Any]:
    return {kind: get(kind) for kind in FILES}


def save(kind: str, data: Dict[str, Any]) -> Dict[str, Any]:
    if kind not in FILES:
        raise KeyError(kind)
    # Light validation / normalisation per kind.
    if kind == "players":
        names = [str(x).strip() for x in (data.get("names") or []) if str(x).strip()]
        data = {"names": sorted(set(names), key=names.index)}
    elif kind == "terminology":
        fixes = {str(k).strip(): str(v).strip()
                 for k, v in (data.get("fixes") or {}).items() if str(k).strip()}
        data = {"fixes": fixes}
    elif kind == "hallucination":
        data = {
            "exact": [str(x).strip() for x in (data.get("exact") or []) if str(x).strip()],
            "starts_with": [str(x).strip() for x in (data.get("starts_with") or []) if str(x).strip()],
        }
    ensure()
    _path(kind).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("[PostProcess] saved %s (%s)", kind, _path(kind))
    return data
