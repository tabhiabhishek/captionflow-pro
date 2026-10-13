import logging

from fastapi import WebSocket
from .feed_manager import FeedManager
from .config_manager import ConfigManager
from .stats_collector import get_system_stats
from .log_manager import log_manager
import asyncio

logger = logging.getLogger("system")

feed_managers = {}

# Every live WebSocket connection, so server-initiated events (e.g. the Task 15
# workspace_reset broadcast) reach all clients, not just one.
active_connections = set()


async def broadcast(payload: dict):
    """Send a JSON payload to every connected client (best-effort)."""
    for ws in list(active_connections):
        try:
            await ws.send_json(payload)
        except Exception:
            active_connections.discard(ws)


async def _stream_logs(websocket, sub: dict):
    """Poll the log buffer for the subscribed scope/category and push deltas.

    ``sub`` is a mutable dict {scope, category, last_seq} updated when the client
    changes its selection, so a single task serves whatever the UI is viewing.
    """
    # Prime with a tail so the page shows history immediately.
    try:
        scope, category = sub["scope"], sub["category"]
        initial = log_manager.tail(scope, category, 300)
        if initial:
            sub["last_seq"] = initial[-1]["seq"]
        await websocket.send_json({"type": "log", "scope": scope, "category": category,
                                   "entries": initial, "replace": True})
    except Exception:
        return
    while True:
        await asyncio.sleep(0.7)
        scope, category = sub["scope"], sub["category"]
        try:
            entries = log_manager.since(scope, category, sub.get("last_seq", 0))
            if entries:
                sub["last_seq"] = entries[-1]["seq"]
                await websocket.send_json({"type": "log", "scope": scope,
                                           "category": category, "entries": entries})
        except Exception:
            break


def _apply_feed_overrides(config: ConfigManager, feed_id: int, msg: dict):
    """Merge live values sent from the UI into the in-memory feed config.

    Lets Probe/Start use the URL/model the operator typed without forcing a
    full config save. Backward compatible: fields are optional.
    """
    overrides = {}
    if msg.get("url") is not None:
        overrides["url"] = msg["url"]
    if msg.get("model") is not None:
        overrides["model"] = msg["model"]
    if msg.get("model_path") is not None:
        overrides["model_path"] = msg["model_path"]
    if msg.get("prompt") is not None:
        overrides["prompt"] = msg["prompt"]
    if msg.get("chunk_size") is not None:
        overrides["chunk_size"] = msg["chunk_size"]
    if msg.get("interface") is not None:
        overrides["interface"] = msg["interface"]
    if msg.get("source_type") is not None:
        overrides["source_type"] = msg["source_type"]
    if msg.get("device") is not None:
        overrides["device"] = msg["device"]
    # AI / caption engine settings (per feed).
    for key in ("language", "audio_pad", "overlap", "hallucination_filter",
                "calibration", "model_backend", "terminology_dir"):
        if msg.get(key) is not None:
            overrides[key] = msg[key]
    if not overrides:
        return

    feeds = config._config.setdefault("feeds", [])
    for feed in feeds:
        if feed.get("id") == feed_id:
            feed.update(overrides)
            break
    else:
        overrides["id"] = feed_id
        feeds.append(overrides)

    # If a model name was provided but no explicit path, derive it.
    feed = config.get_feed_config(feed_id)
    if feed.get("model") and not feed.get("model_path"):
        folder = config.resolve_model_folder(config._config.get("model_folder", "./models"))
        feed["model_path"] = str(folder / feed["model"]).replace("\\", "/")


async def websocket_endpoint(websocket: WebSocket, config: ConfigManager):
    await websocket.accept()
    active_connections.add(websocket)
    client = getattr(websocket, "client", None)
    logger.info("[WS] Connection opened%s", f" from {client}" if client else "")

    # Send initial config
    await websocket.send_json({"type": "config", "data": config._config})

    stats_task = asyncio.create_task(_send_system_stats(websocket))
    log_task = None
    log_sub = None

    try:
        while True:
            msg = await websocket.receive_json()
            cmd = msg.get("type")

            # ---- Log streaming commands (Task 2) -------------------------
            if cmd == "log_subscribe":
                scope = msg.get("scope", "system")
                category = msg.get("category", "application")
                if log_sub is None:
                    log_sub = {"scope": scope, "category": category, "last_seq": 0}
                    log_task = asyncio.create_task(_stream_logs(websocket, log_sub))
                else:
                    # Switch selection; reset seq so the new view primes fresh.
                    log_sub["scope"] = scope
                    log_sub["category"] = category
                    log_sub["last_seq"] = 0
                    tail = log_manager.tail(scope, category, 300)
                    if tail:
                        log_sub["last_seq"] = tail[-1]["seq"]
                    await websocket.send_json({"type": "log", "scope": scope,
                                               "category": category, "entries": tail,
                                               "replace": True})
                logger.info("[WS] Log subscribe %s/%s", scope, category)
                continue
            if cmd == "log_unsubscribe":
                if log_task:
                    log_task.cancel()
                    log_task = None
                    log_sub = None
                continue

            feed_id = msg.get("feed", 1)

            if feed_id not in feed_managers:
                feed_managers[feed_id] = FeedManager(feed_id, config, websocket)

            manager = feed_managers[feed_id]
            # Keep the manager bound to the current live socket.
            manager.ws = websocket
            manager.qc_wrapper.ws = websocket

            _apply_feed_overrides(config, feed_id, msg)

            if cmd == "start":
                logger.info("[WS] Status update: START feed %s", feed_id)
                await manager.start()
            elif cmd == "stop":
                logger.info("[WS] Status update: STOP feed %s", feed_id)
                await manager.stop()
            elif cmd == "probe":
                logger.info("[WS] Probe request for feed %s", feed_id)
                result = await manager.probe()
                await websocket.send_json(
                    {"type": "probe_result", "feed": feed_id, "data": result}
                )
                logger.info("[WS] Probe response sent for feed %s (status=%s)",
                            feed_id, result.get("status"))
            elif cmd == "update_config":
                new_config = msg.get("config")
                if new_config:
                    config.save(new_config)
                    logger.info("[WS] Config updated via WebSocket")
            else:
                logger.warning("[WS] Unknown command: %s", cmd)
    except Exception as e:
        logger.info("[WS] Connection closed: %s", e)
    finally:
        logger.info("[WS] Connection closed / cleaning up")
        active_connections.discard(websocket)
        stats_task.cancel()
        if log_task:
            log_task.cancel()
        for m in feed_managers.values():
            try:
                await m.stop()
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("[WS] Error stopping feed %s: %s", m.feed_id, e)


async def _send_system_stats(websocket):
    while True:
        await asyncio.sleep(1)
        stats = get_system_stats()
        try:
            await websocket.send_json({"type": "system_stats", "data": stats})
        except Exception:
            break
