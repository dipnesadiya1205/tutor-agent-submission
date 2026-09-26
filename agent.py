import asyncio
from typing import List
import os

from pipecat.observers.base_observer import BaseObserver, FramePushed
from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    LLMMessagesAppendFrame,
    StartFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIProcessor
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAIRealtimeSTTService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

from playback import MicGate, PlaybackMeter, ResponseProgress, SpeechTracker, snapshot
from presentation import PresentationState, Slide
from prompts import JUMP_TO_SLIDE, QNA_INTRO, RESUME_AFTER_PAUSE, RESUME_SLIDE, SYSTEM_PROMPT

load_dotenv(override=True)


SLIDE_SYSTEM_MESSAGES: List[str] = [
    # Slide 1 – welcome & overview
    (
        "SLIDE 1: WELCOME & OVERVIEW\n\n"
        "Welcome the audience and briefly introduce the topic: Natural Disasters. "
        "Explain that this presentation will walk through what natural disasters are, why they occur, "
        "and how they affect people and the environment. "
        "Mention that questions are welcome at any time and that you will continue guiding them through the slides."
    ),
    # Slide 2 – what are natural disasters
    (
        "SLIDE 2: WHAT ARE NATURAL DISASTERS\n\n"
        "Explain that natural disasters are extreme natural events that cause major damage to life, property, "
        "or the environment. Examples include earthquakes, floods, hurricanes, volcanic eruptions, and droughts. "
        "Emphasize that these events are caused by natural processes of the Earth."
    ),
    # Slide 3 – why they happen
    (
        "SLIDE 3: WHY NATURAL DISASTERS HAPPEN\n\n"
        "Describe the main reasons natural disasters occur: movement of tectonic plates, extreme weather patterns, "
        "volcanic activity, and climate-related changes. "
        "Briefly mention that some disasters are sudden while others develop slowly over time."
    ),
    # Slide 4 – major types
    (
        "SLIDE 4: MAJOR TYPES OF NATURAL DISASTERS\n\n"
        "Introduce the most common categories such as earthquakes, floods, cyclones, wildfires, landslides, "
        "and volcanic eruptions. "
        "Explain that each type has different causes and impacts depending on geography and climate."
    ),
    # Slide 5 – impacts on people
    (
        "SLIDE 5: IMPACT ON PEOPLE\n\n"
        "Explain how natural disasters affect communities: loss of life, injuries, destruction of homes, "
        "and displacement of families. "
        "Also mention disruption to healthcare, education, and daily life."
    ),
    # Slide 6 – environmental effects
    (
        "SLIDE 6: ENVIRONMENTAL EFFECTS\n\n"
        "Describe how natural disasters affect ecosystems: deforestation from wildfires, flooding of habitats, "
        "soil erosion, and pollution of water sources. "
        "Mention that while disasters cause destruction, some also reshape landscapes and ecosystems."
    ),
    # Slide 7 – preparedness and safety
    (
        "SLIDE 7: PREPAREDNESS AND SAFETY\n\n"
        "Explain how preparation can reduce damage and save lives. "
        "Discuss early warning systems, evacuation plans, emergency kits, and community awareness. "
        "Highlight that education and planning are key to disaster resilience."
    ),
    # Slide 8 – conclusion & discussion
    (
        "SLIDE 8: CONCLUSION & DISCUSSION\n\n"
        "Summarize that natural disasters are powerful natural events that can have serious impacts on society "
        "and the environment. "
        "Emphasize the importance of preparedness, scientific understanding, and community cooperation. "
        "Invite the audience to ask questions or request clarification on any slide."
    ),
]

SLIDES: List[Slide] = [Slide(*text.split("\n\n", 1)) for text in SLIDE_SYSTEM_MESSAGES]


class PresentationObserver0(BaseObserver):
    """Observer that advances slides after 5 seconds of bot silence."""

    def __init__(self, state: PresentationState):
        super().__init__()
        self.state = state
        self.task: PipelineTask | None = None
        self._is_bot_speaking = False
        self._silence_timer: asyncio.TimerHandle | None = None
        self._user_spoke_since_last_slide = False
        self.paused = False

    def set_task(self, task: PipelineTask):
        self.task = task

    def set_paused(self, paused: bool):
        self.paused = paused
        if paused:
            self._cancel_silence_timer()
        elif not self._is_bot_speaking:
            self._schedule_silence_check()

    def _cancel_silence_timer(self):
        if self._silence_timer:
            self._silence_timer.cancel()
            self._silence_timer = None

    def _schedule_silence_check(self):
        # Schedule a check 5 seconds after the bot stops speaking.
        self._cancel_silence_timer()
        loop = asyncio.get_event_loop()
        self._silence_timer = loop.call_later(
            3.0,
            lambda: asyncio.create_task(self._on_silence_timeout()),
        )

    async def _on_silence_timeout(self):
        if self._is_bot_speaking or self.paused:
            return
        if self.state.in_qna:
            # Open conversation now, nothing to auto-advance to.
            return
        if self._user_spoke_since_last_slide:
            logger.info("3 seconds silence after user spoke; staying on slide and instructing AI to continue.")
            await self.continue_current_slide()
        elif self.state.has_next:
            logger.info("3 seconds of bot silence detected; queuing next slide.")
            await self.go_to_next_slide()
        else:
            await self.start_qna()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame

        if isinstance(frame, StartFrame):
            # Pipeline just started, force start with first slide
            await self._on_silence_timeout()

        elif isinstance(frame, BotStartedSpeakingFrame):
            self._is_bot_speaking = True
            self._cancel_silence_timer()

        elif isinstance(frame, UserStartedSpeakingFrame):
            self._user_spoke_since_last_slide = True
            self._cancel_silence_timer()

        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._is_bot_speaking = False
            if not self.paused:
                self._schedule_silence_check()

        elif isinstance(frame, (EndFrame, CancelFrame)):
            # Pipeline is ending; stop any pending timers.
            self._cancel_silence_timer()

        # Observers are side-effect-only; nothing to push downstream.

    async def continue_current_slide(self):
        """Instruct the AI to stay on the current slide and continue where it left off."""
        slide = self.state.current
        if slide is None:
            return
        self._user_spoke_since_last_slide = False
        content = RESUME_SLIDE.format(title=slide.title)
        await self.task.queue_frames(
            [LLMMessagesAppendFrame(messages=[{"role": "system", "content": content}], run_llm=True)]
        )

    async def go_to_next_slide(self):
        self._user_spoke_since_last_slide = False
        slide = await self.state.advance()
        if slide is None:
            logger.warning("already on the last slide, nothing to advance to")
            return

        await self.task.queue_frames(
            [LLMMessagesAppendFrame(messages=[{"role": "system", "content": slide.prompt}], run_llm=True)]
        )

    async def jump_to_slide(self, index: int):
        self._cancel_silence_timer()
        self._user_spoke_since_last_slide = False
        slide = await self.state.go_to(index)
        if slide is None:
            return
        content = JUMP_TO_SLIDE.format(title=slide.title) + "\n\n" + slide.prompt
        await self.task.queue_frames(
            [LLMMessagesAppendFrame(messages=[{"role": "system", "content": content}], run_llm=True)]
        )

    async def start_qna(self):
        await self.state.enter_qna()
        self._user_spoke_since_last_slide = False
        await self.task.queue_frames(
            [LLMMessagesAppendFrame(messages=[{"role": "system", "content": QNA_INTRO}], run_llm=True)]
        )


async def run_bot(websocket_client):
    ws_transport = FastAPIWebsocketTransport(
        websocket=websocket_client,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=ProtobufFrameSerializer(),
        ),
    )

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    stt = OpenAIRealtimeSTTService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o-transcribe",
    )

    tts = OpenAITTSService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o-mini-tts",
        voice="alloy",
        instructions="Warm, clear teacher speaking to a classroom. Natural pace, friendly tone.",
    )

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o",
    )

    context = LLMContext(messages)

    # Stricter VAD to reduce false "user spoke" from background noise: higher confidence,
    # longer sustained speech before trigger, higher minimum volume.
    vad_params = VADParams(
        confidence=0.85,
        start_secs=0.45,
        stop_secs=0.35,
        min_volume=0.7,
    )
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(params=vad_params),
        ),
    )

    rtvi = RTVIProcessor()
    mic_gate = MicGate()
    progress = ResponseProgress()

    pipeline = Pipeline(
        [
            ws_transport.input(),
            rtvi,
            mic_gate,
            stt,
            context_aggregator.user(),
            llm,
            tts,
            SpeechTracker(progress),
            ws_transport.output(),
            PlaybackMeter(progress),
            context_aggregator.assistant(),
        ]
    )

    presentation = PresentationState(SLIDES)
    presentation_observer0 = PresentationObserver0(presentation)
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[presentation_observer0, RTVIObserver(rtvi)],
        enable_turn_tracking=False
    )
    presentation_observer0.set_task(task)

    async def broadcast_slide(state: PresentationState):
        await rtvi.send_server_message({"type": "slide", **state.snapshot()})

    presentation.on_change(broadcast_slide)

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(processor):
        await processor.set_bot_ready()
        await processor.send_server_message({"type": "deck", **presentation.deck()})

    paused_speech = None

    async def pause():
        nonlocal paused_speech
        if presentation_observer0.paused:
            return
        paused_speech = snapshot(progress)
        presentation_observer0.set_paused(True)
        mic_gate.closed = True
        await rtvi.interrupt_bot()
        await rtvi.send_server_message({"type": "playback", "state": "paused"})

    async def resume(replay: bool = True):
        nonlocal paused_speech
        if not presentation_observer0.paused:
            return
        pending, paused_speech = paused_speech, None
        mic_gate.closed = False
        frames = []
        if not replay:
            pending = None
        if pending and pending.text:
            frames.append(TTSSpeakFrame(pending.text))
        if pending and not pending.response_complete:
            frames.append(
                LLMMessagesAppendFrame(
                    messages=[{"role": "system", "content": RESUME_AFTER_PAUSE}], run_llm=True
                )
            )
        if frames:
            await task.queue_frames(frames)
        presentation_observer0.set_paused(False)
        await rtvi.send_server_message({"type": "playback", "state": "playing"})

    async def send_error(message: str):
        await rtvi.send_server_message({"type": "error", "message": message})

    async def goto(data):
        index = data.get("index") if isinstance(data, dict) else None
        if not isinstance(index, int) or not 0 <= index < presentation.total:
            logger.warning(f"bad goto payload: {data!r}")
            await send_error("That slide doesn't exist.")
            return
        if presentation_observer0.paused:
            await resume(replay=False)
        await rtvi.interrupt_bot()
        await presentation_observer0.jump_to_slide(index)

    @rtvi.event_handler("on_client_message")
    async def on_client_message(processor, message):
        if message.type == "pause":
            await pause()
        elif message.type == "resume":
            await resume()
        elif message.type == "goto":
            await goto(message.data)
        else:
            logger.debug(f"unhandled client message: {message.type}")
            await send_error(f"The server doesn't understand '{message.type}'.")

    @ws_transport.event_handler("on_client_connected")
    async def on_client_connected():
        logger.info("[transport] client connected")

    @ws_transport.event_handler("on_client_disconnected")
    async def on_client_disconnected():
        logger.info("[transport] client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
