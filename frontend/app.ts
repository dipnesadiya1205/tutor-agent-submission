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

class WebsocketClientApp {
    private pcClient: PipecatClient | null = null;
    private connectBtn: HTMLButtonElement | null = null;
    private disconnectBtn: HTMLButtonElement | null = null;
    private pauseBtn: HTMLButtonElement | null = null;
    private prevBtn: HTMLButtonElement | null = null;
    private nextBtn: HTMLButtonElement | null = null;
    private paused = false;
    private slide: SlideState | null = null;
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
        this.pcClient.sendClientMessage('goto', { index });
    }

    private updateNavButtons(): void {
        const connected = !!this.pcClient && !!this.slide;
        if (this.prevBtn) this.prevBtn.disabled = !connected || (this.slide?.index ?? 0) <= 0;
        if (this.nextBtn) {
            const idx = this.slide?.index ?? -1;
            this.nextBtn.disabled = !connected || idx >= (this.slide?.total ?? 0) - 1;
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
        document.getElementById('slide-panel')?.classList.toggle('paused', paused);
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

            //const transport = new DailyTransport();
            const PipecatConfig: PipecatClientOptions = {
                transport: new WebSocketTransport(),
                enableMic: true,
                enableCam: false,
                callbacks: {
                    onConnected: () => {
                        this.updateStatus('Connected');
                        if (this.connectBtn) this.connectBtn.disabled = true;
                        if (this.disconnectBtn) this.disconnectBtn.disabled = false;
                    },
                    onDisconnected: () => {
                        this.updateStatus('Disconnected');
                        if (this.connectBtn) this.connectBtn.disabled = false;
                        if (this.disconnectBtn) this.disconnectBtn.disabled = true;
                        this.setPaused(false);
                        if (this.pauseBtn) this.pauseBtn.disabled = true;
                        this.slide = null;
                        this.updateNavButtons();
                        this.log('Client disconnected');
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