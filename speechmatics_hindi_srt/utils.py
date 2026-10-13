"""Logging + small shared helpers."""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path
from typing import Callable, Iterable, List, TypeVar

T = TypeVar("T")


def setup_logging(log_dir: Path, verbose: bool = False) -> logging.Logger:
    log_dir.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("pipeline")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    logger.propagate = False

    fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S")

    fh = logging.FileHandler(log_dir / "pipeline.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    # Devanagari in a cp1252 console raises UnicodeEncodeError and would kill
    # the run at the first Hindi log line, so force UTF-8 on stdout.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(logging.DEBUG if verbose else logging.INFO)
    sh.setFormatter(fmt)
    logger.addHandler(sh)
    return logger


def retry(fn: Callable[[], T], *, attempts: int, base_delay: float = 1.5,
          logger: logging.Logger | None = None, what: str = "operation") -> T:
    """Call fn with exponential backoff. Re-raises the last error."""
    last: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:                      # noqa: BLE001 - reported below
            last = e
            if i == attempts:
                break
            delay = base_delay ** i
            if logger:
                logger.warning("%s failed (attempt %d/%d): %s — retrying in %.1fs",
                               what, i, attempts, e, delay)
            time.sleep(delay)
    assert last is not None
    raise last


def chunked(items: List[T], size: int) -> Iterable[List[T]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def human_time(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"
