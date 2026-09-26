from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, List, Optional

from loguru import logger


class Mode(str, Enum):
    PRESENTING = "presenting"
    QNA = "qna"


@dataclass
class Slide:
    title: str
    notes: str

    @property
    def prompt(self) -> str:
        return f"{self.title}\n\n{self.notes}"

    @property
    def heading(self) -> str:
        # "SLIDE 3: WHY NATURAL DISASTERS HAPPEN" -> "Why Natural Disasters Happen"
        _, _, rest = self.title.partition(":")
        words = (rest or self.title).strip().lower().split()
        return " ".join(w if w in ("and", "of", "on") else w.capitalize() for w in words)


ChangeListener = Callable[["PresentationState"], Awaitable[None]]


@dataclass
class PresentationState:
    """Single source of truth for where we are in the deck."""

    slides: List[Slide]
    index: int = -1
    mode: Mode = Mode.PRESENTING
    _listeners: List[ChangeListener] = field(default_factory=list, repr=False)

    @property
    def total(self) -> int:
        return len(self.slides)

    @property
    def started(self) -> bool:
        return self.index >= 0

    @property
    def current(self) -> Optional[Slide]:
        if 0 <= self.index < self.total:
            return self.slides[self.index]
        return None

    @property
    def is_last(self) -> bool:
        return self.index == self.total - 1

    @property
    def has_next(self) -> bool:
        return self.index < self.total - 1

    def on_change(self, listener: ChangeListener) -> None:
        self._listeners.append(listener)

    async def _notify(self) -> None:
        for listener in list(self._listeners):
            try:
                await listener(self)
            except Exception:
                logger.exception("presentation listener failed")

    async def go_to(self, index: int) -> Optional[Slide]:
        if not 0 <= index < self.total:
            logger.warning(f"ignoring out of range slide index {index}")
            return None
        self.index = index
        self.mode = Mode.PRESENTING
        logger.info(f"now on slide {index + 1}/{self.total}")
        await self._notify()
        return self.current

    async def advance(self) -> Optional[Slide]:
        if not self.has_next:
            return None
        return await self.go_to(self.index + 1)

    async def enter_qna(self) -> None:
        if self.mode == Mode.QNA:
            return
        self.mode = Mode.QNA
        logger.info("presentation finished, switching to Q&A")
        await self._notify()

    @property
    def in_qna(self) -> bool:
        return self.mode == Mode.QNA

    def snapshot(self) -> dict:
        return {
            "index": self.index,
            "total": self.total,
            "mode": self.mode.value,
            "title": self.current.heading if self.current else None,
        }

    def deck(self) -> dict:
        return {
            "slides": [{"index": i, "title": s.heading} for i, s in enumerate(self.slides)],
            **self.snapshot(),
        }
