"""Shared data types.

`Segment` is the single currency of the pipeline: Speechmatics produces them,
the SRT writer consumes them, and the translator swaps only their `text`.
Because timings live here and the translator never touches them, the Hindi and
English SRTs cannot drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import List


@dataclass(frozen=True)
class Segment:
    start: float          # seconds from the start of the ORIGINAL audio
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def with_text(self, text: str) -> "Segment":
        """Same timing, new words — the only way the translator may build a
        segment, so a translated cue can never carry a different timestamp."""
        return replace(self, text=text)


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    content: str


def total_duration(segments: List[Segment]) -> float:
    return max((s.end for s in segments), default=0.0)
