import asyncio
import logging

from .probe_manager import ProbeManager
from .capture_manager import CaptureManager
from .quick_captions_wrapper import QuickCaptionsWrapper
from .logger_setup import get_feed_logger, get_feed_category_logger

logger = logging.getLogger("system")

# Ordered pipeline stages surfaced to the frontend diagnostics view.
PIPELINE_STAGES = [
    "udp_input",
    "ffmpeg",
    "chunk_writer",
    "whisper",
    "caption_generator",
    "websocket",
    "frontend",
]


class FeedManager:
    def __init__(self, feed_id: int, config, websocket):
        self.feed_id = feed_id
        self.config = config
        self.ws = websocket
        # NOTE: attribute is named `prober` so it does not shadow the async
        # `probe()` method below (previously both were called `probe`, which
        # silently broke the WebSocket "probe" command).
        self.prober = ProbeManager()
        self.capture = CaptureManager()
        self.qc_wrapper = QuickCaptionsWrapper(feed_id, websocket)
        self.logger = get_feed_logger(feed_id)
        self.log_ffmpeg = get_feed_category_logger(feed_id, "ffmpeg")
        self.log_probe = get_feed_category_logger(feed_id, "probe")
        self.is_running = False
        self._task = None
        self._stage_state = {s: "waiting" for s in PIPELINE_STAGES}

    # ------------------------------------------------------------------ #
    # Pipeline status helpers
    # ------------------------------------------------------------------ #
    async def _set_stage(self, stage: str, state: str):
        """Update one pipeline stage and broadcast the full status map."""
        if stage in self._stage_state:
            self._stage_state[stage] = state
        try:
            await self.ws.send_json({
                "type": "pipeline_status",
                "feed": self.feed_id,
                "data": dict(self._stage_state),
            })
        except Exception as e:  # WebSocket may be closing
            logger.warning("[Pipeline] feed %s could not send status: %s", self.feed_id, e)

    async def _reset_stages(self, state: str = "waiting"):
        self._stage_state = {s: state for s in PIPELINE_STAGES}
        await self._set_stage("frontend", state)

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def start(self):
        if self.is_running:
            return
        self.is_running = True
        await self._reset_stages("waiting")
        self._task = asyncio.create_task(self._pipeline())
        self.logger.info(f"Feed {self.feed_id} started")
        logger.info("[Pipeline] Starting feed %s", self.feed_id)

    async def stop(self):
        self.is_running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self.capture.stop()
        await self.qc_wrapper.stop()
        await self._reset_stages("stopped")
        self.logger.info(f"Feed {self.feed_id} stopped")
        logger.info("[Pipeline] Stopped feed %s", self.feed_id)

    async def _pipeline(self):
        feed_cfg = self.config.get_feed_config(self.feed_id)
        url = feed_cfg.get("url")
        model_path = feed_cfg.get("model_path")
        chunk_size = feed_cfg.get("chunk_size", 3)
        interface = feed_cfg.get("interface", "")
        source_type = (feed_cfg.get("source_type") or "udp").lower()
        device = feed_cfg.get("device", "")

        logger.info("[Pipeline] feed %s  source=%s  url=%s  device=%s  model=%s  chunk=%ss  iface=%s",
                    self.feed_id, source_type, url, device, model_path, chunk_size, interface or "auto")

        try:
            # 1. Input + probe (probe is UDP-only; SDI has no multicast to probe).
            await self._set_stage("udp_input", "running")
            if source_type == "sdi":
                self.log_probe.info("SDI source selected (device=%s) — skipping UDP probe", device)
            else:
                probe_result = await self.prober.probe(url, interface=interface)
                await self.ws.send_json(
                    {"type": "probe_result", "feed": self.feed_id, "data": probe_result}
                )
                self.logger.info(f"Probe: {probe_result}")
                self.log_probe.info("Probe %s for %s: %s", probe_result.get("status"), url, probe_result)
                if probe_result.get("status") == "success":
                    resolved_iface = probe_result.get("interface_used", interface) or interface
                    if resolved_iface != interface:
                        logger.info("[Pipeline] feed %s using auto-detected interface %s",
                                    self.feed_id, resolved_iface or "auto")
                    interface = resolved_iface
                else:
                    await self._set_stage("udp_input", "error")

            # 2. Whisper worker (QuickCaptions subprocess)
            await self._set_stage("whisper", "running")
            await self._set_stage("caption_generator", "running")
            logger.info("[Pipeline] Starting Whisper / Caption Sender for feed %s", self.feed_id)
            settings = {
                "prompt": feed_cfg.get("prompt", ""),
                "language": feed_cfg.get("language", ""),
                "audio_pad": feed_cfg.get("audio_pad"),
                "overlap": feed_cfg.get("overlap"),
                "hallucination_filter": feed_cfg.get("hallucination_filter"),
                "calibration": feed_cfg.get("calibration"),
                "model_backend": feed_cfg.get("model_backend"),
                # No terminology_dir: the wrapper no longer turns folder settings
                # into env vars, because the engine preferred them over its own
                # config. paths.terminology_folder in the engine's config wins.
            }
            await self.qc_wrapper.start(model_path, chunk_duration=chunk_size, settings=settings)

            # 3. FFmpeg capture + chunk writer
            await self._set_stage("ffmpeg", "running")
            await self._set_stage("chunk_writer", "running")
            logger.info("[Pipeline] Starting FFmpeg / Chunk Writer for feed %s", self.feed_id)
            self.log_ffmpeg.info("FFmpeg capture starting: url=%s chunk=%ss iface=%s",
                                 url, chunk_size, interface or "auto")
            input_dir = self.qc_wrapper.input_dir
            await self.capture.start(url, input_dir, chunk_duration=chunk_size,
                                     interface=interface, source_type=source_type, device=device)

            # 4. WebSocket delivery is live once the workers are up
            await self._set_stage("websocket", "running")
            await self._set_stage("frontend", "running")

            # 5. Keep alive until stopped
            while self.is_running:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("[Pipeline] feed %s error: %s", self.feed_id, e)
            self.logger.error(f"Pipeline error: {e}")
            # Mark whichever stages are still running as errored.
            for s, st in self._stage_state.items():
                if st == "running":
                    self._stage_state[s] = "error"
            await self._set_stage("frontend", "error")

    async def probe(self):
        """Run ffprobe for this feed's configured URL (WebSocket 'probe' cmd)."""
        feed_cfg = self.config.get_feed_config(self.feed_id)
        url = feed_cfg.get("url")
        interface = feed_cfg.get("interface", "")
        logger.info("[Probe] feed %s requested probe for %s (iface=%s)",
                    self.feed_id, url, interface or "auto")
        self.log_probe.info("Manual probe requested for %s (iface=%s)", url, interface or "auto")
        result = await self.prober.probe(url, interface=interface)
        self.log_probe.info("Manual probe %s: %s", result.get("status"), result)
        return result
