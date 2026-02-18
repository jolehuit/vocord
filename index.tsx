/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Toasts } from "@webpack/common";

const settings = definePluginSettings({
    transcribeBackend: {
        type: OptionType.SELECT,
        description: "Transcription backend (auto detects your platform)",
        options: [
            { label: "Auto-detect", value: "auto", default: true },
            { label: "mlx-whisper (macOS ARM)", value: "mlx-whisper" },
            { label: "transcribe-rs", value: "transcribe-rs" },
        ]
    },
    whisperModel: {
        type: OptionType.STRING,
        description: "Whisper model to use",
        default: "mlx-community/whisper-large-v3-turbo"
    },
    modelPath: {
        type: OptionType.STRING,
        description: "Path to GGML Whisper model file (for transcribe-rs backend)",
        default: ""
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "Path to ffmpeg binary (for audio conversion, leave empty to use system ffmpeg)",
        default: ""
    },
    language: {
        type: OptionType.STRING,
        description: "Language code (e.g., 'fr', 'en') or leave empty for auto-detect",
        default: ""
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show toast notification when transcription is complete",
        default: true
    }
});

// State to track transcriptions and pending operations
const transcriptions = new Map<string, string>();
const pendingTranscriptions = new Set<string>();
const processedElements = new WeakSet<Element>();

// Runtime backend override for quick toggle (null = use settings)
let backendOverride: "mlx-whisper" | "transcribe-rs" | null = null;

function getActiveBackend(): string {
    return backendOverride ?? settings.store.transcribeBackend;
}

let observer: MutationObserver | null = null;

// Extract audio URL from a voice message element
function getAudioUrl(element: Element): string | null {
    // Try to find audio source in the voice message
    const audio = element.querySelector("audio");
    if (audio?.src) return audio.src;

    // Try data attributes
    const wrapper = element.closest("[class*='voiceMessage']") ||
                    element.closest("[class*='audioControls']") ||
                    element.closest("[class*='waveformContainer']");

    if (wrapper) {
        // Look for audio in parent
        const parentAudio = wrapper.querySelector("audio");
        if (parentAudio?.src) return parentAudio.src;

        // Check for source element
        const source = wrapper.querySelector("source");
        if (source?.src) return source.src;
    }

    return null;
}

// Create the backend toggle button
function createBackendToggle(): HTMLElement {
    const toggle = document.createElement("button");
    toggle.className = "vc-vocord-toggle";

    function update() {
        const active = getActiveBackend();
        const label = active === "mlx-whisper" ? "MLX" : active === "transcribe-rs" ? "RS" : "AUTO";
        toggle.textContent = label;
        toggle.title = `Backend: ${active} (click to switch)`;
        toggle.setAttribute("data-backend", active);
    }

    update();

    toggle.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();

        if (backendOverride === null || backendOverride === "mlx-whisper") {
            backendOverride = "transcribe-rs";
        } else {
            backendOverride = "mlx-whisper";
        }

        // Update all toggles on the page
        document.querySelectorAll(".vc-vocord-toggle").forEach(el => {
            const active = getActiveBackend();
            const label = active === "mlx-whisper" ? "MLX" : "RS";
            el.textContent = label;
            (el as HTMLElement).title = `Backend: ${active} (click to switch)`;
            el.setAttribute("data-backend", active);
        });

        Toasts.show({
            message: `Backend: ${backendOverride}`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId()
        });
    });

    return toggle;
}

// Create the transcribe button element
function createTranscribeButton(audioUrl: string, container: Element): HTMLElement {
    const audioId = audioUrl.split("?")[0].split("/").pop() || audioUrl;

    const wrapper = document.createElement("div");
    wrapper.className = "vc-vocord-wrapper";
    wrapper.setAttribute("data-audio-id", audioId);

    const btnRow = document.createElement("div");
    btnRow.className = "vc-vocord-btn-row";

    const button = document.createElement("button");
    button.className = "vc-vocord-btn";
    button.title = "Transcribe voice message";
    button.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" x2="12" y1="19" y2="22"></line>
            <line x1="8" x2="16" y1="22" y2="22"></line>
        </svg>
    `;

    const toggle = createBackendToggle();
    btnRow.appendChild(button);
    btnRow.appendChild(toggle);

    // Check if already transcribed
    const existingTranscription = transcriptions.get(audioId);
    if (existingTranscription) {
        const transcriptionBox = createTranscriptionBox(existingTranscription, audioId);
        wrapper.appendChild(btnRow);
        wrapper.appendChild(transcriptionBox);
        return wrapper;
    }

    button.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (pendingTranscriptions.has(audioId)) return;

        pendingTranscriptions.add(audioId);
        button.disabled = true;
        button.classList.add("transcribing");
        button.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
        `;
        button.title = "Transcribing...";

        try {
            const result = await (window as any).VencordNative.pluginHelpers.Vocord.transcribe(
                audioUrl,
                settings.store.whisperModel,
                settings.store.language,
                getActiveBackend(),
                settings.store.modelPath,
                settings.store.ffmpegPath
            );

            if (result.error) {
                Toasts.show({
                    message: `Transcription failed: ${result.error}`,
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId()
                });
            } else {
                transcriptions.set(audioId, result.text);

                // Add transcription box
                const transcriptionBox = createTranscriptionBox(result.text, audioId);
                wrapper.appendChild(transcriptionBox);

                if (settings.store.showToast) {
                    Toasts.show({
                        message: "Transcription complete!",
                        type: Toasts.Type.SUCCESS,
                        id: Toasts.genId()
                    });
                }
            }
        } catch (err) {
            console.error("[Vocord] Error:", err);
            Toasts.show({
                message: `Transcription error: ${err}`,
                type: Toasts.Type.FAILURE,
                id: Toasts.genId()
            });
        } finally {
            pendingTranscriptions.delete(audioId);
            button.disabled = false;
            button.classList.remove("transcribing");
            button.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                    <line x1="12" x2="12" y1="19" y2="22"></line>
                    <line x1="8" x2="16" y1="22" y2="22"></line>
                </svg>
            `;
            button.title = "Transcribe voice message";
        }
    });

    wrapper.appendChild(btnRow);
    return wrapper;
}

function createTranscriptionBox(text: string, audioId: string): HTMLElement {
    const box = document.createElement("div");
    box.className = "vc-vocord-transcription";

    const textSpan = document.createElement("span");
    textSpan.className = "vc-vocord-transcription-text";
    textSpan.textContent = text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "vc-vocord-transcription-copy";
    copyBtn.title = "Copy transcription";
    copyBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
        </svg>
    `;
    copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        if (settings.store.showToast) {
            Toasts.show({
                message: "Copied to clipboard!",
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId()
            });
        }
    });

    box.appendChild(textSpan);
    box.appendChild(copyBtn);
    return box;
}

// Process voice messages and add transcribe buttons
function processVoiceMessages() {
    // Find all voice message containers
    // Discord uses various class names, we try multiple selectors
    const selectors = [
        "[class*='voiceMessage']",
        "[class*='audioControls']",
        "[class*='waveform']",
        "[class*='audio_']"
    ];

    const voiceMessages = document.querySelectorAll(selectors.join(","));

    voiceMessages.forEach(vm => {
        // Skip if already processed
        if (processedElements.has(vm)) return;

        // Check if this element contains audio
        const audioUrl = getAudioUrl(vm);
        if (!audioUrl) return;

        // Skip if button already exists
        if (vm.querySelector(".vc-vocord-wrapper")) return;

        // Mark as processed
        processedElements.add(vm);

        // Find a good place to insert the button
        const controlsContainer = vm.querySelector("[class*='controls']") ||
                                   vm.querySelector("[class*='buttons']") ||
                                   vm;

        const button = createTranscribeButton(audioUrl, vm);

        // Insert the button
        if (controlsContainer && controlsContainer !== vm) {
            controlsContainer.appendChild(button);
        } else {
            // Append after the voice message element
            vm.parentElement?.insertBefore(button, vm.nextSibling);
        }
    });
}

export default definePlugin({
    name: "Vocord",
    description: "Transcribe Discord voice messages locally using Whisper AI (mlx-whisper on macOS ARM, transcribe-rs on other platforms)",
    authors: [{ name: "jolehuit", id: 0n }],
    settings,

    start() {
        // Add styles
        const style = document.createElement("style");
        style.id = "vc-vocord-styles";
        style.textContent = `
            .vc-vocord-wrapper {
                display: inline-flex;
                flex-direction: column;
                gap: 8px;
                margin-left: 8px;
                vertical-align: middle;
            }

            .vc-vocord-btn-row {
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .vc-vocord-toggle {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                padding: 0 6px;
                border: none;
                border-radius: 4px;
                background: var(--background-secondary);
                color: var(--interactive-normal);
                cursor: pointer;
                font-size: 10px;
                font-weight: 700;
                font-family: var(--font-code);
                letter-spacing: 0.5px;
                transition: all 0.15s ease;
            }

            .vc-vocord-toggle:hover {
                background: var(--background-tertiary);
                color: var(--interactive-hover);
            }

            .vc-vocord-toggle[data-backend="mlx-whisper"] {
                color: var(--text-positive);
            }

            .vc-vocord-toggle[data-backend="transcribe-rs"] {
                color: var(--text-brand);
            }

            .vc-vocord-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                border: none;
                border-radius: 50%;
                background: var(--background-secondary);
                color: var(--interactive-normal);
                cursor: pointer;
                transition: all 0.15s ease;
            }

            .vc-vocord-btn:hover:not(:disabled) {
                background: var(--background-tertiary);
                color: var(--interactive-hover);
            }

            .vc-vocord-btn:disabled {
                cursor: not-allowed;
                opacity: 0.7;
            }

            .vc-vocord-btn.transcribing svg {
                animation: vc-transcribe-spin 1s linear infinite;
            }

            @keyframes vc-transcribe-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            .vc-vocord-transcription {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                padding: 8px 12px;
                background: var(--background-secondary);
                border-radius: 8px;
                max-width: 400px;
                margin-top: 4px;
            }

            .vc-vocord-transcription-text {
                flex: 1;
                font-size: 14px;
                line-height: 1.4;
                color: var(--text-normal);
                word-wrap: break-word;
            }

            .vc-vocord-transcription-copy {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border: none;
                border-radius: 4px;
                background: transparent;
                color: var(--interactive-normal);
                cursor: pointer;
                flex-shrink: 0;
            }

            .vc-vocord-transcription-copy:hover {
                background: var(--background-tertiary);
                color: var(--interactive-hover);
            }
        `;
        document.head.appendChild(style);

        // Initial processing
        processVoiceMessages();

        // Set up MutationObserver to watch for new voice messages
        observer = new MutationObserver((mutations) => {
            let shouldProcess = false;
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    shouldProcess = true;
                    break;
                }
            }
            if (shouldProcess) {
                // Debounce processing
                setTimeout(processVoiceMessages, 100);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log("[Vocord] Plugin started");
    },

    stop() {
        // Remove observer
        if (observer) {
            observer.disconnect();
            observer = null;
        }

        // Remove styles
        document.getElementById("vc-vocord-styles")?.remove();

        // Remove all transcribe buttons
        document.querySelectorAll(".vc-vocord-wrapper").forEach(el => el.remove());

        // Clear state
        transcriptions.clear();
        pendingTranscriptions.clear();
        backendOverride = null;

        console.log("[Vocord] Plugin stopped");
    }
});
