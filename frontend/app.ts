/**
 * Copyright (c) 2024–2025, Daily
 *
 * SPDX-License-Identifier: BSD 2-Clause License
 */

/**
 * Pipecat Client Implementation
 *
 * This client connects to an RTVI-compatible bot server using WebSocket.
 *
 * Requirements:
 * - A running RTVI bot server (defaults to http://localhost:7860)
 */

import {
    PipecatClient,
    type PipecatClientOptions,
    RTVIEvent,
} from '@pipecat-ai/client-js';
import { WebSocketTransport } from '@pipecat-ai/websocket-transport';
import { Transcript } from './transcript';
import { showToast } from './toast';

type SlideInfo = { index: number; title: string };

type SlideState = {
    index: number;
    total: number;
    mode: 'presenting' | 'qna';
    title: string | null;
};

type ServerMessage =
    | ({ type: 'slide' } & SlideState)
    | ({ type: 'deck'; slides: SlideInfo[] } & SlideState)
    | { type: 'playback'; state: 'paused' | 'playing' }
    | { type: 'error'; message: string };

type Activity = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused';

const ACTIVITY_LABELS: Record<Activity, string> = {
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    paused: 'Paused',
};

class WebsocketClientApp {
    private pcClient: PipecatClient | null = null;
    private connectBtn: HTMLButtonElement | null = null;
    private disconnectBtn: HTMLButtonElement | null = null;
    private pauseBtn: HTMLButtonElement | null = null;
    private prevBtn: HTMLButtonElement | null = null;
    private nextBtn: HTMLButtonElement | null = null;
    private paused = false;
    private slide: SlideState | null = null;
    private leavingOnPurpose = false;
    private lastErrorAt = 0;
    private jumpPending = false;
    private activity: Activity = 'idle';
    private activityEl: HTMLElement | null = null;
    private activityLabel: HTMLElement | null = null;
    private slidePanel: HTMLElement | null = null;
    private transcript: Transcript | null = null;
    private deckList: HTMLElement | null = null;
    private visited = new Set<number>();
    private statusSpan: HTMLElement | null = null;
    private debugLog: HTMLElement | null = null;
    private slideTitle: HTMLElement | null = null;
    private slideCounter: HTMLElement | null = null;
    private modeBadge: HTMLElement | null = null;
    private botAudio: HTMLAudioElement;
    private slides: SlideInfo[] = [];

    constructor() {
        console.log('WebsocketClientApp');
        this.botAudio = document.createElement('audio');
        this.botAudio.autoplay = true;
        //this.botAudio.playsInline = true;
        document.body.appendChild(this.botAudio);

        this.setupDOMElements();
        this.setupEventListeners();
        this.setupTheme();
    }

    private setupTheme(): void {
        const btn = document.getElementById('theme-btn');
        if (!btn) return;

        const apply = (dark: boolean) => {
            document.documentElement.dataset.theme = dark ? 'dark' : 'light';
            btn.textContent = dark ? '☀' : '☾';
            btn.setAttribute('aria-pressed', String(dark));
        };

        apply(document.documentElement.dataset.theme === 'dark');

        btn.addEventListener('click', () => {
            const dark = document.documentElement.dataset.theme !== 'dark';
            apply(dark);
            try {
                localStorage.setItem('theme', dark ? 'dark' : 'light');
            } catch {
                // Private mode or storage disabled; the choice just won't persist.
            }
        });
    }

    /**
     * Set up references to DOM elements and create necessary media elements
     */
    private setupDOMElements(): void {
        this.connectBtn = document.getElementById(
            'connect-btn'
        ) as HTMLButtonElement;
        this.disconnectBtn = document.getElementById(
            'disconnect-btn'
        ) as HTMLButtonElement;
        this.pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
        this.prevBtn = document.getElementById('prev-btn') as HTMLButtonElement;
        this.nextBtn = document.getElementById('next-btn') as HTMLButtonElement;
        this.statusSpan = document.getElementById('connection-status');
        this.debugLog = document.getElementById('debug-log');
        this.slideTitle = document.getElementById('slide-title');
        this.slideCounter = document.getElementById('slide-counter');
        this.modeBadge = document.getElementById('mode-badge');
        this.activityEl = document.getElementById('activity');
        this.activityLabel = document.getElementById('activity-label');
        this.slidePanel = document.getElementById('slide-panel');
        const transcriptEl = document.getElementById('transcript');
        if (transcriptEl) this.transcript = new Transcript(transcriptEl);
        this.deckList = document.getElementById('deck-list');
    }

    private renderDeck(): void {
        if (!this.deckList) return;
        this.deckList.innerHTML = '';
        for (const slide of this.slides) {
            const item = document.createElement('li');
            item.className = 'deck-item';
            item.dataset.index = String(slide.index);

            const button = document.createElement('button');
            button.type = 'button';
            button.innerHTML = `<span class="deck-num">${slide.index + 1}</span><span class="deck-title"></span>`;
            (button.querySelector('.deck-title') as HTMLElement).textContent = slide.title;
            button.addEventListener('click', () => this.goToSlide(slide.index));

            item.appendChild(button);
            this.deckList.appendChild(item);
        }
        this.updateDeck();
    }

    private updateDeck(): void {
        if (!this.deckList) return;
        const current = this.slide?.index ?? -1;
        const busy = !this.pcClient || this.jumpPending;
        this.deckList.querySelectorAll<HTMLElement>('.deck-item').forEach((item) => {
            const index = Number(item.dataset.index);
            item.classList.toggle('current', index === current);
            item.classList.toggle('visited', this.visited.has(index) && index !== current);
            const button = item.querySelector('button');
            if (button) button.disabled = busy || index === current;
        });
        this.deckList.querySelector('.deck-item.current')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    private setActivity(activity: Activity): void {
        // While paused nothing else should override the badge.
        if (this.paused && activity !== 'paused') return;
        this.activity = activity;
        if (this.activityEl) this.activityEl.dataset.state = activity;
        if (this.activityLabel) this.activityLabel.textContent = ACTIVITY_LABELS[activity];
    }

    private setLoading(loading: boolean): void {
        this.slidePanel?.classList.toggle('loading', loading);
    }

    private replayAnimation(el: HTMLElement, className: string): void {
        el.classList.remove(className);
        // Force a reflow so the browser restarts the animation.
        void el.offsetWidth;
        el.classList.add(className);
    }

    private handleServerMessage(msg: ServerMessage): void {
        switch (msg.type) {
            case 'deck':
                this.slides = msg.slides;
                this.renderDeck();
                this.renderSlide(msg);
                break;
            case 'slide':
                this.renderSlide(msg);
                break;
            case 'playback':
                this.log(`Playback: ${msg.state}`);
                this.setPaused(msg.state === 'paused');
                break;
            case 'error':
                this.log(`Server error: ${msg.message}`);
                showToast(msg.message, 'error');
                // Whatever was in flight didn't happen; unlock the controls.
                this.jumpPending = false;
                this.slidePanel?.classList.remove('transitioning');
                if (this.pauseBtn && this.pcClient) this.pauseBtn.disabled = false;
                this.updateNavButtons();
                this.updateDeck();
                break;
        }
    }

    private renderSlide(state: SlideState): void {
        this.slide = state;
        this.jumpPending = false;
        if (state.index >= 0) this.visited.add(state.index);
        this.slidePanel?.classList.remove('transitioning');
        this.setLoading(false);
        this.updateNavButtons();
        this.updateDeck();
        if (!this.slideTitle || !this.slideCounter || !this.modeBadge) return;

        const title = state.index < 0 ? 'Natural Disasters' : state.title ?? '';
        const counter = state.index < 0 ? 'Starting soon' : `Slide ${state.index + 1} of ${state.total}`;

        this.slideCounter.textContent = counter;
        if (this.slideTitle.textContent !== title) {
            this.slideTitle.textContent = title;
            this.replayAnimation(this.slideTitle, 'slide-enter');
        }

        const qna = state.mode === 'qna';
        this.modeBadge.textContent = qna ? 'Q&A' : 'Presenting';
        this.modeBadge.classList.toggle('qna', qna);
    }

    /**
     * Set up event listeners for connect/disconnect buttons
     */
    private setupEventListeners(): void {
        this.connectBtn?.addEventListener('click', () => this.connect());
        this.disconnectBtn?.addEventListener('click', () => this.disconnect());
        this.pauseBtn?.addEventListener('click', () => this.togglePause());
        this.prevBtn?.addEventListener('click', () => this.goToSlide((this.slide?.index ?? 0) - 1));
        this.nextBtn?.addEventListener('click', () => this.goToSlide((this.slide?.index ?? -1) + 1));
    }

    private goToSlide(index: number): void {
        if (!this.pcClient || !this.slide) return;
        if (index < 0 || index >= this.slide.total) return;
        this.log(`Jumping to slide ${index + 1}`);
        this.jumpPending = true;
        this.updateNavButtons();
        this.updateDeck();
        this.slidePanel?.classList.add('transitioning');
        this.pcClient.sendClientMessage('goto', { index });
    }

    private updateNavButtons(): void {
        const ready = !!this.pcClient && !!this.slide && !this.jumpPending;
        if (this.prevBtn) this.prevBtn.disabled = !ready || (this.slide?.index ?? 0) <= 0;
        if (this.nextBtn) {
            const idx = this.slide?.index ?? -1;
            this.nextBtn.disabled = !ready || idx >= (this.slide?.total ?? 0) - 1;
        }
    }

    private togglePause(): void {
        if (!this.pcClient || !this.pauseBtn) return;
        // Lock the button until the backend confirms the new state.
        this.pauseBtn.disabled = true;
        this.pcClient.sendClientMessage(this.paused ? 'resume' : 'pause');
    }

    private setPaused(paused: boolean): void {
        this.paused = paused;
        if (this.pauseBtn) {
            this.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
            this.pauseBtn.classList.toggle('paused', paused);
            this.pauseBtn.disabled = false;
        }
        this.slidePanel?.classList.toggle('paused', paused);
        if (paused) {
            this.setActivity('paused');
        } else if (this.activity === 'paused') {
            this.activity = 'idle';
            this.setActivity('idle');
        }
    }

    /**
     * Add a timestamped message to the debug log
     */
    private log(message: string): void {
        if (!this.debugLog) return;
        const log = this.debugLog;
        // Only follow new entries if the reader hasn't scrolled up to look at something.
        const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;

        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.textContent = `${new Date().toISOString()} - ${message}`;
        if (message.startsWith('User: ')) {
            entry.classList.add('log-user');
        } else if (message.startsWith('Bot: ')) {
            entry.classList.add('log-bot');
        }
        log.appendChild(entry);
        if (pinned) {
            log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
        }
        console.log(message);
    }

    /**
     * Update the connection status display
     */
    private updateStatus(status: string): void {
        if (this.statusSpan) {
            this.statusSpan.textContent = status;
        }
        this.log(`Status: ${status}`);
    }

    /**
     * Check for available media tracks and set them up if present
     * This is called when the bot is ready or when the transport state changes to ready
     */
    setupMediaTracks() {
        if (!this.pcClient) return;
        const tracks = this.pcClient.tracks();
        if (tracks.bot?.audio) {
            this.setupAudioTrack(tracks.bot.audio);
        }
    }

    /**
     * Set up listeners for track events (start/stop)
     * This handles new tracks being added during the session
     */
    setupTrackListeners() {
        if (!this.pcClient) return;

        // Listen for new tracks starting
        this.pcClient.on(RTVIEvent.TrackStarted, (track, participant) => {
            // Only handle non-local (bot) tracks
            if (!participant?.local && track.kind === 'audio') {
                this.setupAudioTrack(track);
            }
        });

        // Listen for tracks stopping
        this.pcClient.on(RTVIEvent.TrackStopped, (track, participant) => {
            this.log(
                `Track stopped: ${track.kind} from ${participant?.name || 'unknown'}`
            );
        });
    }

    /**
     * Set up an audio track for playback
     * Handles both initial setup and track updates
     */
    private setupAudioTrack(track: MediaStreamTrack): void {
        this.log('Setting up audio track');
        if (
            this.botAudio.srcObject &&
            'getAudioTracks' in this.botAudio.srcObject
        ) {
            const oldTrack = this.botAudio.srcObject.getAudioTracks()[0];
            if (oldTrack?.id === track.id) return;
        }
        this.botAudio.srcObject = new MediaStream([track]);
    }

    /**
     * Initialize and connect to the bot
     * This sets up the Pipecat client, initializes devices, and establishes the connection
     */
    public async connect(): Promise<void> {
        try {
            const startTime = Date.now();
            if (this.connectBtn) {
                this.connectBtn.disabled = true;
                this.connectBtn.textContent = 'Connecting…';
            }
            this.setLoading(true);
            this.transcript?.clear();

            //const transport = new DailyTransport();
            const PipecatConfig: PipecatClientOptions = {
                transport: new WebSocketTransport(),
                enableMic: true,
                enableCam: false,
                callbacks: {
                    onConnected: () => {
                        this.updateStatus('Connected');
                        if (this.connectBtn) {
                            this.connectBtn.disabled = true;
                            this.connectBtn.textContent = 'Connected';
                        }
                        if (this.disconnectBtn) this.disconnectBtn.disabled = false;
                    },
                    onDisconnected: () => {
                        const wasReady = !!this.slide;
                        const recentError = Date.now() - this.lastErrorAt < 3000;
                        if (!this.leavingOnPurpose && !recentError) {
                            showToast(
                                wasReady
                                    ? 'The connection to the backend dropped. Click Connect to start again.'
                                    : 'The backend closed the connection before the lesson could start. Check the server logs.',
                                'error',
                                'Connection lost'
                            );
                        }
                        this.leavingOnPurpose = false;
                        this.updateStatus('Disconnected');
                        if (this.connectBtn) {
                            this.connectBtn.disabled = false;
                            this.connectBtn.textContent = 'Connect';
                        }
                        if (this.disconnectBtn) this.disconnectBtn.disabled = true;
                        this.setPaused(false);
                        if (this.pauseBtn) this.pauseBtn.disabled = true;
                        this.slide = null;
                        this.jumpPending = false;
                        this.visited.clear();
                        this.setLoading(false);
                        this.setActivity('idle');
                        this.updateNavButtons();
                        this.updateDeck();
                        this.log('Client disconnected');
                    },
                    onBotLlmStarted: () => {
                        this.setActivity('thinking');
                        this.transcript?.endBotTurn();
                        this.transcript?.setTyping(true);
                    },
                    onBotStartedSpeaking: () => this.setActivity('speaking'),
                    onBotStoppedSpeaking: () => {
                        this.setActivity('idle');
                        this.transcript?.setTyping(false);
                    },
                    onUserStartedSpeaking: () => this.setActivity('listening'),
                    onUserStoppedSpeaking: () => {
                        if (this.activity === 'listening') this.setActivity('thinking');
                    },
                    onBotReady: (data) => {
                        this.log(`Bot ready: ${JSON.stringify(data)}`);
                        this.setupMediaTracks();
                        if (this.pauseBtn) this.pauseBtn.disabled = false;
                    },
                    onUserTranscript: (data) => {
                        if (data.final) {
                            this.log(`User: ${data.text}`);
                            this.transcript?.addUser(data.text);
                        }
                    },
                    onBotTranscript: (data) => {
                        this.log(`Bot: ${data.text}`);
                        this.transcript?.appendBot(data.text);
                    },
                    onServerMessage: (data) => this.handleServerMessage(data as ServerMessage),
                    onMessageError: (error) => {
                        console.error('Message error:', error);
                        this.lastErrorAt = Date.now();
                        showToast(describeError(error), 'error', 'Message failed');
                    },
                    onError: (error) => {
                        console.error('Error:', error);
                        this.lastErrorAt = Date.now();
                        const fatal = !!(error as { data?: { fatal?: boolean } }).data?.fatal;
                        showToast(describeError(error), 'error', fatal ? 'Session ended' : 'Something went wrong');
                    },
                },
            };
            this.pcClient = new PipecatClient(PipecatConfig);
            // @ts-ignore
            window.pcClient = this.pcClient; // Expose for debugging
            this.setupTrackListeners();

            this.log('Initializing devices...');
            await this.pcClient.initDevices();

            this.log('Connecting to bot...');
            await this.pcClient.startBotAndConnect({
                // The baseURL and endpoint of your bot server that the client will connect to
                endpoint: 'http://localhost:7860/connect',
            });

            const timeTaken = Date.now() - startTime;
            this.log(`Connection complete, timeTaken: ${timeTaken}`);
        } catch (error) {
            this.log(`Error connecting: ${(error as Error).message}`);
            this.updateStatus('Error');
            this.setLoading(false);
            if (Date.now() - this.lastErrorAt > 3000) {
                showToast(connectionHint(error), 'error', "Couldn't connect");
            }
            this.lastErrorAt = Date.now();
            if (this.connectBtn) {
                this.connectBtn.disabled = false;
                this.connectBtn.textContent = 'Retry';
            }
            // Clean up if there's an error
            if (this.pcClient) {
                try {
                    await this.pcClient.disconnect();
                } catch (disconnectError) {
                    this.log(`Error during disconnect: ${disconnectError}`);
                }
            }
        }
    }

    /**
     * Disconnect from the bot and clean up media resources
     */
    public async disconnect(): Promise<void> {
        if (this.pcClient) {
            this.leavingOnPurpose = true;
            try {
                await this.pcClient.disconnect();
                this.pcClient = null;
                if (
                    this.botAudio.srcObject &&
                    'getAudioTracks' in this.botAudio.srcObject
                ) {
                    this.botAudio.srcObject
                        .getAudioTracks()
                        .forEach((track) => track.stop());
                    this.botAudio.srcObject = null;
                }
            } catch (error) {
                this.log(`Error disconnecting: ${(error as Error).message}`);
                showToast(describeError(error), 'warning', 'Disconnect was not clean');
            }
        }
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const data = error as { message?: unknown; data?: { message?: unknown } };
        const message = data.message ?? data.data?.message;
        if (typeof message === 'string') return message;
    }
    return 'An unexpected error occurred.';
}

function connectionHint(error: unknown): string {
    const message = describeError(error);
    const lower = message.toLowerCase();
    if (lower.includes('permission') || lower.includes('notallowed') || lower.includes('denied')) {
        return 'Microphone access was blocked. Allow the microphone in your browser and try again.';
    }
    if (lower.includes('fetch') || lower.includes('network') || lower.includes('failed to') || lower.includes('econn')) {
        return 'The backend is not reachable. Make sure the server is running on port 7860.';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
        return 'The backend took too long to respond. Check that it started without errors.';
    }
    return message;
}

declare global {
    interface Window {
        WebsocketClientApp: typeof WebsocketClientApp;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.WebsocketClientApp = WebsocketClientApp;
    new WebsocketClientApp();
});