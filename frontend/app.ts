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
    | { type: 'playback'; state: 'paused' | 'playing' };

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
    private jumpPending = false;
    private activity: Activity = 'idle';
    private activityEl: HTMLElement | null = null;
    private activityLabel: HTMLElement | null = null;
    private slidePanel: HTMLElement | null = null;
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

    private handleServerMessage(msg: ServerMessage): void {
        switch (msg.type) {
            case 'deck':
                this.slides = msg.slides;
                this.renderSlide(msg);
                break;
            case 'slide':
                this.renderSlide(msg);
                break;
            case 'playback':
                this.log(`Playback: ${msg.state}`);
                this.setPaused(msg.state === 'paused');
                break;
        }
    }

    private renderSlide(state: SlideState): void {
        this.slide = state;
        this.jumpPending = false;
        this.slidePanel?.classList.remove('transitioning');
        this.setLoading(false);
        this.updateNavButtons();
        if (!this.slideTitle || !this.slideCounter || !this.modeBadge) return;

        if (state.index < 0) {
            this.slideCounter.textContent = 'Starting soon';
            this.slideTitle.textContent = 'Natural Disasters';
        } else {
            this.slideCounter.textContent = `Slide ${state.index + 1} of ${state.total}`;
            this.slideTitle.textContent = state.title ?? '';
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
        const entry = document.createElement('div');
        entry.textContent = `${new Date().toISOString()} - ${message}`;
        if (message.startsWith('User: ')) {
            entry.style.color = '#2196F3';
        } else if (message.startsWith('Bot: ')) {
            entry.style.color = '#4CAF50';
        }
        this.debugLog.appendChild(entry);
        this.debugLog.scrollTop = this.debugLog.scrollHeight;
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
                        this.setLoading(false);
                        this.setActivity('idle');
                        this.updateNavButtons();
                        this.log('Client disconnected');
                    },
                    onBotLlmStarted: () => this.setActivity('thinking'),
                    onBotStartedSpeaking: () => this.setActivity('speaking'),
                    onBotStoppedSpeaking: () => this.setActivity('idle'),
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
                        }
                    },
                    onBotTranscript: (data) => this.log(`Bot: ${data.text}`),
                    onServerMessage: (data) => this.handleServerMessage(data as ServerMessage),
                    onMessageError: (error) => console.error('Message error:', error),
                    onError: (error) => console.error('Error:', error),
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
            }
        }
    }
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