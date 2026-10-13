"""Unit tests. Run: pytest -q     (no API key or network required)"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import Segment                                    # noqa: E402
from speechmatics_client import extract_words, words_to_segments  # noqa: E402
from srt_generator import (build_srt, format_timestamp, normalize_segments,  # noqa: E402
                           parse_srt, sanitize_text)
from translator import Translator, translate_segments          # noqa: E402
import logging                                                 # noqa: E402

LOG = logging.getLogger("test")


# ---------- timestamp conversion ----------
@pytest.mark.parametrize("sec,want", [
    (0.0, "00:00:00,000"),
    (1.234, "00:00:01,234"),
    (61.567, "00:01:01,567"),
    (3661.999, "01:01:01,999"),
    (59.9996, "00:01:00,000"),      # rounds up across the minute, not to ",60"
    (-5.0, "00:00:00,000"),         # clamped
])
def test_format_timestamp(sec, want):
    assert format_timestamp(sec) == want


# ---------- Hindi unicode ----------
def test_hindi_unicode_roundtrip(tmp_path):
    text = "नमस्ते दुनिया"
    srt = build_srt([Segment(0.8, 3.2, text)])
    assert text in srt
    p = tmp_path / "h.srt"
    p.write_text(srt, encoding="utf-8-sig")
    assert parse_srt(p.read_text(encoding="utf-8-sig"))[0].text == text


def test_devanagari_not_mangled_by_sanitize():
    s = "भारत  ने   शानदार प्रदर्शन किया।"
    assert sanitize_text(s) == "भारत ने शानदार प्रदर्शन किया।"


# ---------- empty / long / ordering ----------
def test_empty_segments_dropped():
    segs = [Segment(0, 1, ""), Segment(1, 2, "   "), Segment(2, 3, "ठीक है")]
    assert len(normalize_segments(segs)) == 1


def test_empty_transcript_yields_empty_srt():
    assert build_srt([]) == ""


def test_long_segment_preserved_verbatim():
    long_hi = "यह एक बहुत लंबा हिंदी वाक्य है। " * 12
    out = normalize_segments([Segment(0, 30, long_hi)])
    assert out[0].text.startswith("यह एक बहुत लंबा")
    assert out[0].end == 30


def test_zero_length_segment_gets_minimum_duration():
    assert normalize_segments([Segment(5.0, 5.0, "हाँ")])[0].end > 5.0


def test_overlap_resolved_without_moving_starts():
    segs = [Segment(0.0, 5.0, "एक"), Segment(3.0, 6.0, "दो")]
    out = normalize_segments(segs)
    assert out[0].end <= out[1].start          # no overlap
    assert out[1].start == 3.0                 # start never moved


def test_numbering_is_sequential_and_unique():
    segs = [Segment(i, i + 0.5, f"पंक्ति {i}") for i in range(5)]
    nums = [int(b.splitlines()[0]) for b in build_srt(segs).strip().split("\n\n")]
    assert nums == [1, 2, 3, 4, 5]


def test_segments_sorted_by_start():
    out = normalize_segments([Segment(5, 6, "बाद"), Segment(1, 2, "पहले")])
    assert [s.text for s in out] == ["पहले", "बाद"]


# ---------- word grouping uses only real API times ----------
def _w(s, e, c):
    from models import Word
    return Word(s, e, c)


def test_words_to_segments_uses_real_times():
    words = [_w(0.80, 1.10, "आज"), _w(1.10, 1.60, "भारत"), _w(1.60, 3.20, "है।"),
             _w(4.00, 4.50, "दोनों"), _w(4.50, 6.50, "टीमें")]
    segs = words_to_segments(words, max_seconds=6, max_chars=84, split_gap=0.6)
    assert segs[0].start == 0.80 and segs[0].end == 3.20
    assert segs[1].start == 4.00 and segs[1].end == 6.50


def test_extract_words_attaches_punctuation():
    transcript = {"results": [
        {"start_time": 0.5, "end_time": 0.9, "type": "word",
         "alternatives": [{"content": "नमस्ते"}]},
        {"start_time": 0.9, "end_time": 0.9, "type": "punctuation",
         "attaches_to": "previous", "alternatives": [{"content": "।"}]},
    ]}
    words = extract_words(transcript)
    assert len(words) == 1 and words[0].content == "नमस्ते।"


# ---------- translation preserves timing ----------
class _FakeTranslator(Translator):
    name = "fake"

    def translate(self, text, source_language, target_language):
        return f"EN[{text}]"

    def translate_batch(self, texts, source_language, target_language):
        return [f"EN[{t}]" for t in texts]


class _FlakyTranslator(_FakeTranslator):
    def __init__(self):
        self.calls = 0

    def translate_batch(self, texts, source_language, target_language):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("simulated API failure")
        return [f"EN[{t}]" for t in texts]


HINDI = [
    Segment(0.80, 3.20, "आज भारत और इंग्लैंड के बीच मुकाबला है।"),
    Segment(3.20, 6.50, "दोनों टीमें शानदार प्रदर्शन करना चाहेंगी।"),
    Segment(7.00, 9.25, "भारत ने शानदार प्रदर्शन किया।"),
]


def test_translation_preserves_every_timestamp():
    en = translate_segments(HINDI, _FakeTranslator(), source_language="hi",
                            target_language="en", batch_size=2, retries=1, logger=LOG)
    assert len(en) == len(HINDI)
    assert [(s.start, s.end) for s in en] == [(s.start, s.end) for s in HINDI]
    assert all(s.text.startswith("EN[") for s in en)


def test_hindi_and_english_srt_have_identical_timing(tmp_path):
    en = translate_segments(HINDI, _FakeTranslator(), source_language="hi",
                            target_language="en", batch_size=16, retries=1, logger=LOG)
    hi_srt, en_srt = build_srt(HINDI), build_srt(en)
    hi_t = [(s.start, s.end) for s in parse_srt(hi_srt)]
    en_t = [(s.start, s.end) for s in parse_srt(en_srt)]
    assert hi_t == en_t                      # the core guarantee
    assert len(hi_t) == 3


def test_translation_retries_then_succeeds():
    flaky = _FlakyTranslator()
    en = translate_segments(HINDI, flaky, source_language="hi", target_language="en",
                            batch_size=16, retries=3, logger=LOG)
    assert flaky.calls >= 2
    assert [(s.start, s.end) for s in en] == [(s.start, s.end) for s in HINDI]


def test_failed_cue_keeps_slot_and_timing():
    class _Dead(Translator):
        def translate(self, *a, **k):
            raise RuntimeError("nope")

        def translate_batch(self, *a, **k):
            raise RuntimeError("nope")

    en = translate_segments(HINDI, _Dead(), source_language="hi", target_language="en",
                            batch_size=2, retries=1, logger=LOG)
    assert len(en) == len(HINDI)
    assert [(s.start, s.end) for s in en] == [(s.start, s.end) for s in HINDI]
    assert en[0].text == HINDI[0].text       # falls back to Hindi, never drops the cue
