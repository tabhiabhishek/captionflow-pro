"""Centralised discovery of ffmpeg / ffprobe binaries and UDP helpers.

The ffmpeg/ffprobe binaries are resolved in this order:
  1. Explicit environment variables (FFMPEG_BINARY / FFMPEG_PATH / VAAK_FFMPEG,
     and the ffprobe equivalents).
  2. A binary sitting next to the other (e.g. if only FFMPEG_PATH is set, look
     for ffprobe in the same folder).
  3. shutil.which() on PATH.
  4. The bare name ("ffmpeg" / "ffprobe") as a last resort.

This makes the pipeline work even when the backend is launched from an
environment whose PATH does not include ffmpeg (services, packaged webview app,
double-clicked launchers, ...).
"""

import logging
import os
import shutil
import socket
import subprocess
from pathlib import Path

logger = logging.getLogger("system")

_FFMPEG_ENV = ["FFMPEG_BINARY", "FFMPEG_PATH", "VAAK_FFMPEG"]
_FFPROBE_ENV = ["FFPROBE_BINARY", "FFPROBE_PATH", "VAAK_FFPROBE"]


def _from_env(names):
    for n in names:
        val = os.environ.get(n)
        if val:
            p = Path(val)
            # Allow pointing at either the exe or the containing folder.
            if p.is_dir():
                for cand in (p / "ffmpeg.exe", p / "ffmpeg", p / "ffprobe.exe", p / "ffprobe"):
                    if cand.exists():
                        return str(cand)
            elif p.exists():
                return str(p)
            else:
                # A bare command name in the env var – trust it.
                return val
    return None


def _sibling(other_path, wanted_stem):
    """Given a resolved ffmpeg path, find ffprobe in the same folder (or vice versa)."""
    if not other_path:
        return None
    folder = Path(other_path).parent
    for ext in (".exe", ""):
        cand = folder / f"{wanted_stem}{ext}"
        if cand.exists():
            return str(cand)
    return None


def get_ffmpeg() -> str:
    return (
        _from_env(_FFMPEG_ENV)
        or _sibling(_from_env(_FFPROBE_ENV), "ffmpeg")
        or shutil.which("ffmpeg")
        or "ffmpeg"
    )


def get_ffprobe() -> str:
    return (
        _from_env(_FFPROBE_ENV)
        or _sibling(_from_env(_FFMPEG_ENV), "ffprobe")
        or shutil.which("ffprobe")
        or "ffprobe"
    )


def ffmpeg_available() -> bool:
    b = get_ffmpeg()
    return os.path.isabs(b) and Path(b).exists() or shutil.which(b) is not None


def ffprobe_available() -> bool:
    b = get_ffprobe()
    return os.path.isabs(b) and Path(b).exists() or shutil.which(b) is not None


def log_binaries():
    logger.info("[FFmpeg] ffmpeg  -> %s (available=%s)", get_ffmpeg(), ffmpeg_available())
    logger.info("[FFmpeg] ffprobe -> %s (available=%s)", get_ffprobe(), ffprobe_available())


def _version(binary: str) -> str:
    try:
        out = subprocess.run([binary, "-version"], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, timeout=5)
        first = out.stdout.decode(errors="replace").splitlines()
        return first[0] if first else "unknown"
    except Exception as e:
        return f"error: {e}"


def diagnostics() -> dict:
    """Full ffmpeg/ffprobe diagnostics for the Settings page."""
    ffmpeg, ffprobe = get_ffmpeg(), get_ffprobe()
    return {
        "ffmpeg": {
            "path": ffmpeg,
            "available": ffmpeg_available(),
            "version": _version(ffmpeg) if ffmpeg_available() else None,
            "source_env": next((n for n in _FFMPEG_ENV if os.environ.get(n)), None),
        },
        "ffprobe": {
            "path": ffprobe,
            "available": ffprobe_available(),
            "version": _version(ffprobe) if ffprobe_available() else None,
            "source_env": next((n for n in _FFPROBE_ENV if os.environ.get(n)), None),
        },
        "env": {n: os.environ.get(n) for n in (_FFMPEG_ENV + _FFPROBE_ENV) if os.environ.get(n)},
    }


# --------------------------------------------------------------------------- #
# Network interfaces (for multicast UDP)
# --------------------------------------------------------------------------- #
def list_network_interfaces():
    """Return selectable local interfaces for multicast reception.

    Each entry: {"name": <adapter name>, "address": <IPv4>}. Always includes a
    default "Auto (all interfaces)" option with an empty address so the caller
    can let the OS choose.
    """
    interfaces = [{"name": "Auto (default route)", "address": ""}]
    seen = set()
    try:
        import psutil
        import socket as _socket

        for name, addrs in psutil.net_if_addrs().items():
            stats = psutil.net_if_stats().get(name)
            if stats is not None and not stats.isup:
                continue
            for a in addrs:
                if a.family == _socket.AF_INET and a.address and not a.address.startswith("169.254"):
                    key = a.address
                    if key in seen:
                        continue
                    seen.add(key)
                    interfaces.append({"name": f"{name} ({a.address})", "address": a.address})
    except Exception as e:  # pragma: no cover - psutil should be present
        logger.warning("[FFmpeg] Could not enumerate interfaces via psutil: %s", e)
        # Fallback: primary outbound IP.
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and ip not in seen:
                interfaces.append({"name": f"Primary ({ip})", "address": ip})
        except Exception:
            pass
    return interfaces


def list_sdi_devices():
    """Return available SDI capture devices (Blackmagic DeckLink via ffmpeg).

    Each entry: {"name": <device name>}. Returns [] when no DeckLink driver /
    device is present (ffmpeg prints the device list to stderr).
    """
    devices = []
    ffmpeg = get_ffmpeg()
    try:
        # decklink prints "[decklink @ ..] 'Device Name'" lines to stderr, then
        # exits non-zero because "dummy" isn't a real device — that's expected.
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-f", "decklink", "-list_devices", "1", "-i", "dummy"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        text = (proc.stderr or b"").decode(errors="replace")
        import re
        for line in text.splitlines():
            m = re.search(r"'([^']+)'", line)
            if m and "decklink" in line.lower():
                name = m.group(1).strip()
                if name and name not in [d["name"] for d in devices]:
                    devices.append({"name": name})
    except FileNotFoundError:
        logger.warning("[FFmpeg] ffmpeg not found while listing SDI devices")
    except Exception as e:
        # DeckLink support not compiled in, or no driver — not an error.
        logger.info("[FFmpeg] No SDI/DeckLink devices available: %s", e)
    return devices


# --------------------------------------------------------------------------- #
# UDP URL building
# --------------------------------------------------------------------------- #
def build_udp_url(url: str, interface_ip: str = "", timeout_us: int = 5_000_000,
                  fifo_size: int = 5_000_000) -> str:
    """Augment a udp:// URL with multicast/receive options.

    - ``localaddr``: binds multicast reception to a specific NIC (the fix for
      "probe times out with no data" on multi-homed / VPN machines).
    - ``timeout``: makes ffmpeg/ffprobe give up cleanly instead of hanging.
    - ``fifo_size`` / ``overrun_nonfatal``: tolerate bursty multicast.

    Non-udp URLs (files, rtsp, http) are returned unchanged.
    """
    if not url or not url.lower().startswith("udp://"):
        return url

    base, _, existing_query = url.partition("?")
    params = {}
    if existing_query:
        for pair in existing_query.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                params[k] = v
            elif pair:
                params[pair] = ""

    if interface_ip and "localaddr" not in params:
        params["localaddr"] = interface_ip
    if timeout_us and "timeout" not in params:
        params["timeout"] = str(timeout_us)
    if fifo_size and "fifo_size" not in params:
        params["fifo_size"] = str(fifo_size)
    if "overrun_nonfatal" not in params:
        params["overrun_nonfatal"] = "1"

    query = "&".join(f"{k}={v}" if v != "" else k for k, v in params.items())
    return f"{base}?{query}" if query else base
