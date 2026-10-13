import asyncio
import logging
import subprocess
import threading
import numpy as np
from pathlib import Path
import scipy.io.wavfile as wavfile

from .ffmpeg_utils import get_ffmpeg, build_udp_url

logger = logging.getLogger("system")


class CaptureManager:
    """Runs FFmpeg and writes fixed-duration WAV chunks.

    FFmpeg is launched with a blocking subprocess.Popen and read in a background
    thread rather than asyncio.create_subprocess_exec. This avoids the Windows
    "NotImplementedError" that occurs when the app runs under uvicorn's reload
    (SelectorEventLoop), which cannot spawn subprocesses.
    """

    def __init__(self, sample_rate=16000, channels=1, dtype=np.int16):
        self.sample_rate = sample_rate
        self.channels = channels
        self.dtype = dtype
        self.process = None
        self._running = False
        self._thread = None
        self.output_dir = None
        self.chunk_counter = 0
        self.chunk_duration = 3
        # Live-listen taps. Each is a bounded queue fed the SAME PCM the chunker
        # writes, so what you hear is exactly what the model is transcribing —
        # and no second ffmpeg has to compete for the UDP socket.
        self._taps = []
        self._taps_lock = threading.Lock()

    def add_tap(self, maxsize: int = 64):
        """Register a listener queue for the raw PCM stream."""
        import queue
        q = queue.Queue(maxsize=maxsize)
        with self._taps_lock:
            self._taps.append(q)
        return q

    def remove_tap(self, q):
        with self._taps_lock:
            if q in self._taps:
                self._taps.remove(q)

    def _feed_taps(self, data: bytes):
        with self._taps_lock:
            taps = list(self._taps)
        for q in taps:
            try:
                q.put_nowait(data)
            except Exception:
                # Listener is not keeping up — drop this block rather than let the
                # capture thread block and stall transcription.
                pass

    async def start(self, url: str, output_dir: Path, chunk_duration: float = 3,
                    interface: str = "", source_type: str = "udp", device: str = "",
                    start_index: int = 0):
        """Launch FFmpeg and write WAV chunks to output_dir.

        source_type: 'udp' (multicast) or 'sdi' (Blackmagic DeckLink capture card).

        ``start_index`` continues chunk numbering from a previous capture. The
        caption worker remembers every filename it has already handled, so if a
        restarted capture began again at chunk_0001 against a still-running
        worker, every chunk would be skipped as "already seen".
        """
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.chunk_duration = chunk_duration
        self.chunk_counter = int(start_index or 0)

        ffmpeg = get_ffmpeg()
        if source_type == "sdi":
            # SDI capture via DeckLink. The device name comes from /api/sdi/devices.
            dev = device or url
            logger.info("[FFmpeg] SDI capture start (%s) device=%s", ffmpeg, dev)
            input_args = ["-f", "decklink", "-i", dev]
        else:
            # For live UDP we want ffmpeg to keep waiting for the stream (no timeout);
            # still bind multicast to the chosen interface.
            input_url = build_udp_url(url, interface_ip=interface, timeout_us=0)
            logger.info("[FFmpeg] Capture start (%s) input=%s", ffmpeg, input_url)
            if interface:
                logger.info("[FFmpeg] Using network interface (localaddr) %s", interface)
            input_args = ["-i", input_url]

        cmd = [
            ffmpeg,
            *input_args,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", str(self.sample_rate),
            "-ac", str(self.channels),
            "-f", "s16le",
            "-",
        ]
        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError as e:
            logger.error("[FFmpeg] Could not launch ffmpeg (%s): %s", ffmpeg, e)
            raise

        self._running = True
        self._thread = threading.Thread(target=self._write_loop, name="capture", daemon=True)
        self._thread.start()

    async def stop(self):
        self._running = False
        if self.process:
            try:
                self.process.terminate()
            except Exception:
                pass
        # Join the reader thread off the event loop.
        if self._thread and self._thread.is_alive():
            await asyncio.to_thread(self._thread.join, 5)
        if self.process:
            try:
                self.process.wait(timeout=5)
            except Exception:
                pass
        logger.info("[FFmpeg] Capture stopped (%d chunks written)", self.chunk_counter)

    def _write_loop(self):
        """Blocking loop (runs in a thread): read raw PCM and write WAV chunks."""
        bytes_per_second = self.sample_rate * self.channels * 2
        chunk_size_bytes = int(bytes_per_second * self.chunk_duration)
        buffer = bytearray()
        stdout = self.process.stdout

        try:
            while self._running:
                data = stdout.read(4096)
                if not data:
                    break
                self._feed_taps(data)          # live listen gets the same bytes
                buffer.extend(data)
                while len(buffer) >= chunk_size_bytes:
                    chunk = buffer[:chunk_size_bytes]
                    buffer = buffer[chunk_size_bytes:]
                    self._write_chunk(chunk)

            # Flush whatever is left. This used to be gated on `self._running`,
            # which stop() clears BEFORE the thread exits — so the final partial
            # chunk (up to one full chunk_duration of speech) was silently
            # discarded at the end of every run.
            if len(buffer) > int(self.sample_rate * self.channels * 2 * 0.25):
                self._write_chunk(bytes(buffer))
                logger.info("[FFmpeg] flushed final %.2fs partial chunk",
                            len(buffer) / (self.sample_rate * self.channels * 2))
        except Exception as e:
            logger.error("[FFmpeg] Capture loop error: %s", e)

    def _write_chunk(self, chunk_bytes):
        audio = np.frombuffer(bytes(chunk_bytes), dtype=self.dtype)
        self.chunk_counter += 1
        wav_path = self.output_dir / f"chunk_{self.chunk_counter:04d}.wav"
        wavfile.write(str(wav_path), self.sample_rate, audio)
