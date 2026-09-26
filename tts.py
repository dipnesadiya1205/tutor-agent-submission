from typing import AsyncGenerator

import httpx2
from loguru import logger
from openai import APIConnectionError, APITimeoutError
from pipecat.frames.frames import ErrorFrame, Frame
from pipecat.services.openai.tts import OpenAITTSService

# How long a single speech request may sit without a response before it is
# abandoned and retried on a fresh connection. The stock client waits ten
# minutes, which turns one stalled request into a silent presenter.
REQUEST_TIMEOUT = httpx2.Timeout(10.0, connect=5.0)


class OpenAITTSWithTimeouts(OpenAITTSService):
    """OpenAI speech with short request timeouts so a stalled request gets retried, not waited on.

    The OpenAI client already retries timeouts and connection errors on its own; all
    we have to do is give it a timeout short enough to matter. A request that still
    fails after the retries is reported as an error frame instead of an exception.
    """

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("http_client", httpx2.AsyncClient(timeout=REQUEST_TIMEOUT))
        # Leave the audio context open long enough to cover the retries.
        kwargs.setdefault("stop_frame_timeout_s", 40.0)
        super().__init__(*args, **kwargs)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        try:
            async for frame in super().run_tts(text, context_id):
                yield frame
        except (APITimeoutError, APIConnectionError) as e:
            logger.error(f"{self} speech request gave up after retries: {type(e).__name__}: {e}")
            yield ErrorFrame(error=f"Speech request timed out: {e}")
