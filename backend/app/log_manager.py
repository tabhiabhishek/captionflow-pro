"""
log_manager.py — feed-wise logging system (Task 2).

Replaces the old flat ``logs/system.log`` + ``logs/feed_01.log`` scheme with the
nested, categorised structure the Logs page needs:

    logs/
      feed01/  application.log caption.log ffmpeg.log probe.log
               model.log performance.log errors.log
      feed02/  ...
      feed03/  ...
      feed04/  ...
      system/      application.log errors.log
      api/         application.log errors.log
      websocket/   application.log errors.log

Design goals:
  * One rotating-ish FileHandler per (scope, category) — persistent on disk,
    downloadable, clearable.
  * An in-memory ring buffer per (scope, category) with a monotonic sequence id,
    so the REST API can tail cheaply and the WebSocket can stream deltas
    (poll ``since(seq)``) without cross-thread asyncio hazards.
  * Backward compatible: ``logging.getLogger("system")`` and the feed loggers used
    across the existing codebase keep working (they route into this structure).
"""

from __future__ import annotations

import logging
import os
import threading
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional

LOG_ROOT = Path(os.environ.get("VAAK_LOG_ROOT", "logs"))
NUM_FEEDS = int(os.environ.get("VAAK_NUM_FEEDS", "4"))

FEED_CATEGORIES = ["application", "caption", "ffmpeg", "probe",
                   "model", "performance", "errors"]
GLOBAL_SCOPES = {
    "system": ["application", "errors"],
    "api": ["application", "errors"],
    "websocket": ["application", "errors"],
}

_BUFFER_MAX = int(os.environ.get("VAAK_LOG_BUFFER", "2000"))

_CONSOLE_FMT = logging.Formatter("%(asctime)s | %(name)-14s | %(levelname)-7s | %(message)s",
                                 datefmt="%H:%M:%S")
_FILE_FMT = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s")


def feed_scope(feed_id: int) -> str:
    return f"feed{int(feed_id):02d}"


class _BufferHandler(logging.Handler):
    """Pushes each record into the manager's ring buffer for its key."""

    def __init__(self, manager: "LogManager", scope: str, category: str):
        super().__init__()
        self.manager = manager
        self.scope = scope
        self.category = category

    def emit(self, record: logging.LogRecord):
        try:
            msg = record.getMessage()
        except Exception:
            msg = str(record.msg)
        self.manager._push(self.scope, self.category, record.levelname, msg, record.created)


class LogManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._seq = 0
        self._buffers: Dict[str, deque] = {}
        self._loggers: Dict[str, logging.Logger] = {}
        self._files: Dict[str, Path] = {}
        self._initialised = False

    # ---- key helpers ------------------------------------------------- #
    @staticmethod
    def _key(scope: str, category: str) -> str:
        return f"{scope}/{category}"

    def scopes(self) -> Dict[str, List[str]]:
        """Return {scope: [categories]} describing the whole tree."""
        tree: Dict[str, List[str]] = {}
        for i in range(1, NUM_FEEDS + 1):
            tree[feed_scope(i)] = list(FEED_CATEGORIES)
        for scope, cats in GLOBAL_SCOPES.items():
            tree[scope] = list(cats)
        return tree

    # ---- setup ------------------------------------------------------- #
    def setup(self):
        if self._initialised:
            return
        LOG_ROOT.mkdir(parents=True, exist_ok=True)
        for scope, cats in self.scopes().items():
            (LOG_ROOT / scope).mkdir(parents=True, exist_ok=True)
            for cat in cats:
                self._ensure_logger(scope, cat)
        # Backward-compat aliases used across the existing codebase.
        self._alias_system_loggers()
        self._initialised = True

    def _ensure_logger(self, scope: str, category: str) -> logging.Logger:
        key = self._key(scope, category)
        if key in self._loggers:
            return self._loggers[key]
        path = LOG_ROOT / scope / f"{category}.log"
        path.parent.mkdir(parents=True, exist_ok=True)   # scope may be created on demand (e.g. feed09)
        self._files[key] = path
        self._buffers[key] = deque(maxlen=_BUFFER_MAX)
        logger = logging.getLogger(f"vaak.{scope}.{category}")
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        # File handler (persistent).
        if not any(getattr(h, "_vaak_key", None) == key for h in logger.handlers):
            fh = logging.FileHandler(path, encoding="utf-8")
            fh.setFormatter(_FILE_FMT)
            fh._vaak_key = key  # type: ignore[attr-defined]
            logger.addHandler(fh)
            # Buffer handler (in-memory tail + live stream).
            bh = _BufferHandler(self, scope, category)
            bh.setFormatter(_FILE_FMT)
            bh._vaak_key = key  # type: ignore[attr-defined]
            logger.addHandler(bh)
        self._loggers[key] = logger
        return logger

    def _alias_system_loggers(self):
        """Keep existing ``getLogger('system'|'config'|'feed_XX')`` calls working."""
        import sys
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(_CONSOLE_FMT)
        console.setLevel(logging.INFO)

        def wire(name: str, scope: str, category: str = "application", add_console=True):
            lg = logging.getLogger(name)
            lg.setLevel(logging.INFO)
            lg.propagate = False
            path = LOG_ROOT / scope / f"{category}.log"
            key = self._key(scope, category)
            if not any(getattr(h, "_vaak_key", None) == f"alias:{key}" for h in lg.handlers):
                fh = logging.FileHandler(path, encoding="utf-8")
                fh.setFormatter(_FILE_FMT)
                fh._vaak_key = f"alias:{key}"  # type: ignore[attr-defined]
                lg.addHandler(fh)
                bh = _BufferHandler(self, scope, category)
                bh.setFormatter(_FILE_FMT)
                bh._vaak_key = f"alias:{key}"  # type: ignore[attr-defined]
                lg.addHandler(bh)
                if add_console:
                    c = logging.StreamHandler(sys.stdout)
                    c.setFormatter(_CONSOLE_FMT)
                    c.setLevel(logging.INFO)
                    c._vaak_key = f"alias:{key}:console"  # type: ignore[attr-defined]
                    lg.addHandler(c)

        wire("system", "system", "application")
        wire("config", "system", "application")
        wire("api", "api", "application")
        wire("websocket", "websocket", "application")
        for i in range(1, NUM_FEEDS + 1):
            # Old code used getLogger("feed_01") → route to feedNN/application.
            wire(f"feed_{i:02d}", feed_scope(i), "application")

    # ---- accessors --------------------------------------------------- #
    def get(self, scope: str, category: str = "application") -> logging.Logger:
        if not self._initialised:
            self.setup()
        return self._ensure_logger(scope, category)

    def feed(self, feed_id: int, category: str = "application") -> logging.Logger:
        return self.get(feed_scope(feed_id), category)

    # ---- buffer plumbing --------------------------------------------- #
    def _push(self, scope: str, category: str, level: str, msg: str, created: float):
        key = self._key(scope, category)
        with self._lock:
            self._seq += 1
            entry = {"seq": self._seq, "scope": scope, "category": category,
                     "level": level, "ts": created, "msg": msg}
            buf = self._buffers.get(key)
            if buf is None:
                buf = self._buffers[key] = deque(maxlen=_BUFFER_MAX)
            buf.append(entry)
            # Mirror errors/warnings into the scope's errors category (feeds only).
            if level in ("ERROR", "CRITICAL", "WARNING") and category != "errors":
                err_key = self._key(scope, "errors")
                ebuf = self._buffers.get(err_key)
                if ebuf is not None:
                    self._seq += 1
                    ebuf.append({"seq": self._seq, "scope": scope, "category": "errors",
                                 "level": level, "ts": created, "msg": f"[{category}] {msg}"})

    def tail(self, scope: str, category: str, limit: int = 200) -> List[dict]:
        key = self._key(scope, category)
        with self._lock:
            buf = self._buffers.get(key)
            if not buf:
                return []
            return list(buf)[-limit:]

    def since(self, scope: str, category: str, after_seq: int) -> List[dict]:
        key = self._key(scope, category)
        with self._lock:
            buf = self._buffers.get(key)
            if not buf:
                return []
            return [e for e in buf if e["seq"] > after_seq]

    def clear(self, scope: str, category: str) -> bool:
        key = self._key(scope, category)
        with self._lock:
            buf = self._buffers.get(key)
            if buf is not None:
                buf.clear()
        path = self._files.get(key) or (LOG_ROOT / scope / f"{category}.log")
        try:
            if path.exists():
                path.write_text("", encoding="utf-8")
            return True
        except Exception:
            return False

    def file_path(self, scope: str, category: str) -> Optional[Path]:
        p = self._files.get(self._key(scope, category)) or (LOG_ROOT / scope / f"{category}.log")
        return p if p.exists() else None


# Singleton
log_manager = LogManager()
