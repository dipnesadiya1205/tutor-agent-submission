from dataclasses import dataclass, field
from typing import List

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    OutputAudioRawFrame,
    TTSSpeakFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


def _seconds(frame: OutputAudioRawFrame) -> float:
    return len(frame.audio) / (frame.sample_rate * frame.num_channels * 2)


@dataclass
class Sentence:
    text: str
    start: float
    end: float


@dataclass
class ResponseProgress:
    sentences: List[Sentence] = field(default_factory=list)
    generated: float = 0.0
    played: float = 0.0
    complete: bool = False

    def reset(self) -> None:
        self.sentences.clear()
        self.generated = 0.0
        self.played = 0.0
        self.complete = False

    def unplayed_text(self) -> str:
        """Everything from the sentence that was mid-playback onwards."""
        remaining = [s.text for s in self.sentences if s.end > self.played + 0.05]
        return " ".join(t.strip() for t in remaining if t.strip())


class SpeechTracker(FrameProcessor):
    """Sits right after TTS and records what the service generated, sentence by sentence."""

    def __init__(self, progress: ResponseProgress, **kwargs):
        super().__init__(**kwargs)
        self._progress = progress
        self._sentence_start = 0.0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, (LLMFullResponseStartFrame, InterruptionFrame)):
            self._progress.reset()
            self._sentence_start = 0.0
        elif isinstance(frame, TTSSpeakFrame):
            # A verbatim replay, not part of a fresh response; don't track it.
            self._progress.reset()
            self._sentence_start = 0.0
        elif isinstance(frame, OutputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            self._progress.generated += _seconds(frame)
        elif isinstance(frame, TTSTextFrame) and direction == FrameDirection.DOWNSTREAM:
            self._progress.sentences.append(
                Sentence(frame.text, self._sentence_start, self._progress.generated)
            )
            self._sentence_start = self._progress.generated
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._progress.complete = True

        await self.push_frame(frame, direction)


class PlaybackMeter(FrameProcessor):
    """Sits right after the transport output and counts audio that actually went out."""

    def __init__(self, progress: ResponseProgress, **kwargs):
        super().__init__(**kwargs)
        self._progress = progress

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, OutputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            self._progress.played += _seconds(frame)

        await self.push_frame(frame, direction)


class MicGate(FrameProcessor):
    """Drops microphone audio while the session is paused so nothing gets transcribed."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.closed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if self.closed and isinstance(frame, InputAudioRawFrame):
            return

        await self.push_frame(frame, direction)


class PausedSpeech:
    """Snapshot of what still needs saying when the presenter got paused."""

    def __init__(self, text: str, response_complete: bool):
        self.text = text
        self.response_complete = response_complete

    def __repr__(self) -> str:
        return f"PausedSpeech(complete={self.response_complete}, text={self.text[:40]!r})"


def snapshot(progress: ResponseProgress) -> PausedSpeech:
    text = progress.unplayed_text()
    logger.info(
        f"pausing with {progress.played:.1f}s of {progress.generated:.1f}s played, "
        f"{len(text.split())} words left to say"
    )
    return PausedSpeech(text, progress.complete)
