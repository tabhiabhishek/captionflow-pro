"""
logger_setup.py — thin compatibility shim over the feed-wise LogManager.

The real logging tree now lives in ``log_manager.py`` (Task 2). This module keeps
the historical public API (`setup_logging`, `get_feed_logger`) so the rest of the
codebase and any external callers keep working unchanged.
"""

import logging

from .log_manager import log_manager

LOG_DIR = "logs"  # retained for backward compatibility


def setup_logging():
    """Configure the full feed-wise logging tree. Safe to call repeatedly."""
    log_manager.setup()


def get_feed_logger(feed_id):
    """Return the per-feed application logger (backward compatible)."""
    return log_manager.feed(feed_id, "application")


def get_feed_category_logger(feed_id, category: str):
    """Return a per-feed logger for a specific category (caption/ffmpeg/…)."""
    return log_manager.feed(feed_id, category)


def get_scope_logger(scope: str, category: str = "application") -> logging.Logger:
    return log_manager.get(scope, category)
