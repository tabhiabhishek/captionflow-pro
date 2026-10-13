import time
import psutil

class StatsCollector:
    def __init__(self, feed_id):
        self.feed_id = feed_id
        self.total_segments = 0
        self.total_words = 0
        self.last_latency = 0
        self.confidence_sum = 0
        self.confidence_count = 0
        self.start_time = time.time()

    def update(self, segments):
        for seg in segments:
            self.total_segments += 1
            words = len(seg.text.split())
            self.total_words += words
            self.confidence_sum += seg.confidence
            self.confidence_count += 1
            self.last_latency = time.time() - seg.end

    def get_stats(self):
        avg_conf = self.confidence_sum / self.confidence_count if self.confidence_count else 0
        elapsed = time.time() - self.start_time
        wpm = self.total_words / (elapsed / 60) if elapsed > 0 else 0
        return {
            "latency": round(self.last_latency, 3),
            "confidence": round(avg_conf, 3),
            "words": self.total_words,
            "wpm": round(wpm, 1),
            "chunks": self.total_segments,
            "inference_time": 0
        }

def get_system_stats():
    cpu = psutil.cpu_percent()
    mem = psutil.virtual_memory()
    gpu = 0
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        gpu = pynvml.nvmlDeviceGetUtilizationRates(handle).gpu
    except:
        pass
    return {"cpu": cpu, "memory": mem.percent, "gpu": gpu}