import asyncio
import json
import logging
import subprocess

from .ffmpeg_utils import get_ffprobe, ffprobe_available, build_udp_url, list_network_interfaces

logger = logging.getLogger("system")


def _suggest_fix(error: str) -> str:
    """Best-effort human-friendly hint for a failed probe."""
    e = (error or "").lower()
    if "ffprobe" in e and ("not found" in e or "no such file" in e or "cannot find" in e):
        return "ffprobe/ffmpeg is not installed or not on PATH. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH."
    if "i/o error" in e or "timed out" in e or "timeout" in e or "immediate exit" in e:
        return ("No stream data received on any local network interface. Verify the multicast address/port, "
                "that the feed is currently broadcasting, and that this machine is on the stream's network/VLAN. "
                "If you know the NIC, pick it explicitly in the Network Interface dropdown.")
    if "connection refused" in e or "network is unreachable" in e:
        return "Network unreachable. Verify the IP/port and that you are on the correct network/VLAN."
    if "invalid" in e and "url" in e:
        return "The URL looks malformed. Expected something like udp://@236.1.1.1:6004."
    if not e:
        return "Verify the UDP URL is correct and the stream is currently broadcasting."
    return "Check the UDP URL, network reachability and that FFmpeg is installed."


def _is_udp(url: str) -> bool:
    return bool(url) and url.lower().startswith("udp://")


class ProbeManager:
    async def probe(self, url: str, interface: str = "") -> dict:
        if not url:
            logger.warning("[Probe] Empty URL supplied")
            return {
                "status": "failed",
                "reason": "No input URL",
                "error": "No UDP URL was provided.",
                "suggested_fix": "Enter a UDP URL (e.g. udp://@236.1.1.1:6004) before probing.",
                "errors": ["No UDP URL provided"],
                "warnings": [],
            }

        ffprobe = get_ffprobe()
        if not ffprobe_available():
            err = f"ffprobe not found (tried: {ffprobe})"
            logger.error("[Probe] %s", err)
            return {
                "status": "failed",
                "reason": "ffprobe missing",
                "error": err,
                "suggested_fix": "Install FFmpeg or set the FFPROBE_PATH / FFMPEG_PATH environment variable to its location.",
                "errors": [err],
                "warnings": [],
            }

        # Build the list of interfaces to try.
        #   - explicit interface  -> only that one
        #   - auto (udp multicast) -> every real NIC, then the default route
        #   - non-udp             -> single attempt, no interface
        if interface:
            candidates = [interface]
        elif _is_udp(url):
            nics = [i["address"] for i in list_network_interfaces()
                    if i["address"] and not i["address"].startswith("127.")]
            candidates = nics + [""]  # try each NIC, then default route last
        else:
            candidates = [""]

        # Shorter per-attempt timeout when scanning several NICs; generous when
        # the user pinned a specific interface.
        per_attempt_us = 8_000_000 if len(candidates) == 1 else 4_000_000

        logger.info("[Probe] Running ffprobe (%s)", ffprobe)
        logger.info("[Probe] Interfaces to try: %s",
                    [c or "auto" for c in candidates])

        last_failure = None
        for iface in candidates:
            result = await self._run_once(ffprobe, url, iface, per_attempt_us)
            if result.get("status") == "success":
                result["interface_used"] = iface
                logger.info("[Probe] SUCCESS on interface %s", iface or "auto")
                return result
            last_failure = result
            # Only keep scanning other NICs for udp reception failures.
            err = (result.get("error") or "").lower()
            if not _is_udp(url) or not ("i/o error" in err or "timeout" in err or "timed out" in err or err == ""):
                break

        logger.error("[Probe] All interface attempts failed for %s", url)
        return last_failure or {
            "status": "failed",
            "reason": "Probe failed",
            "error": "Unknown error",
            "suggested_fix": _suggest_fix(""),
            "errors": ["Unknown error"],
            "warnings": [],
        }

    async def _run_once(self, ffprobe: str, url: str, interface: str, timeout_us: int) -> dict:
        probe_url = build_udp_url(url, interface_ip=interface, timeout_us=timeout_us)
        logger.info("[Probe] Input %s (iface=%s)", probe_url, interface or "auto")

        cmd = [
            ffprobe,
            "-v", "error",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            probe_url,
        ]
        # Run ffprobe in a worker THREAD (blocking subprocess). On Windows under
        # uvicorn's reload (SelectorEventLoop) the async create_subprocess_exec
        # raises NotImplementedError; a thread + subprocess.run works everywhere.
        run_timeout = timeout_us / 1_000_000 + 8
        try:
            result = await asyncio.to_thread(
                subprocess.run, cmd,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=run_timeout,
            )
        except subprocess.TimeoutExpired:
            err = f"ffprobe timed out after {run_timeout:.0f}s (no stream data received)"
            logger.error("[Probe] %s (iface=%s)", err, interface or "auto")
            return {"status": "failed", "reason": "Probe timed out", "error": err,
                    "suggested_fix": _suggest_fix(err), "errors": [err], "warnings": []}
        except FileNotFoundError as e:
            err = f"ffprobe not found: {e}"
            logger.error("[Probe] %s", err)
            return {"status": "failed", "reason": "ffprobe missing", "error": err,
                    "suggested_fix": _suggest_fix(err), "errors": [err], "warnings": []}
        except Exception as e:
            err = str(e) or repr(e)
            logger.error("[Probe] Unexpected error (iface=%s): %s", interface or "auto", err)
            return {"status": "failed", "reason": "Unexpected error", "error": err,
                    "suggested_fix": _suggest_fix(err), "errors": [err], "warnings": []}

        if result.returncode != 0:
            err = result.stderr.decode(errors="replace").strip() or "ffprobe returned a non-zero exit code"
            logger.error("[Probe] ffprobe failed (rc=%s, iface=%s): %s",
                         result.returncode, interface or "auto", err)
            return {"status": "failed", "reason": "ffprobe error", "error": err,
                    "suggested_fix": _suggest_fix(err), "errors": [err], "warnings": []}

        data = json.loads(result.stdout)
        fmt = data.get("format", {})
        streams = data.get("streams", [])
        audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
        video_streams = [s for s in streams if s.get("codec_type") == "video"]

        warnings = []
        if not video_streams:
            warnings.append("No video stream detected")
        if not audio_streams:
            warnings.append("No audio stream detected (captions require audio)")

        a = audio_streams[0] if audio_streams else None
        v = video_streams[0] if video_streams else None

        info = {
            "status": "success",
            "program": fmt.get("program_name", "Unknown"),
            "duration": fmt.get("duration"),
            "bitrate": fmt.get("bit_rate"),
            "audio": {
                "pid": a.get("id") if a else None,
                "codec": a.get("codec_name") if a else None,
                "sample_rate": a.get("sample_rate") if a else None,
                "channels": a.get("channels") if a else None,
                "language": a.get("tags", {}).get("language", "unknown") if a else None,
            } if a else None,
            "video": {
                "pid": v.get("id") if v else None,
                "codec": v.get("codec_name") if v else None,
                "resolution": f"{v.get('width')}x{v.get('height')}" if v else None,
                "frame_rate": v.get("r_frame_rate") if v else None,
            } if v else None,
            "errors": [],
            "warnings": warnings,
        }
        logger.info("[Probe] Completed (iface=%s)", interface or "auto")
        if a:
            logger.info("[Probe] Audio PID %s  Codec %s", info["audio"]["pid"], info["audio"]["codec"])
        if v:
            logger.info("[Probe] Video PID %s  Codec %s", info["video"]["pid"], info["video"]["codec"])
        return info
