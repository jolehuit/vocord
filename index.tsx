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

const transcriptions = new Map<string, string>();
const pendingTranscriptions = new Set<string>();
const processedElements = new WeakSet<Element>();

let backendOverride: "mlx-whisper" | "transcribe-rs" | null = null;

function getActiveBackend(): string {
    return backendOverride ?? settings.store.transcribeBackend;
}

let observer: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const MICROPHONE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line><line x1="8" x2="16" y1="22" y2="22"></line></svg>`;

const SPINNER_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;

const COPY_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`;

function setSvg(el: Element, svg: string): void {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const svgEl = parsed.documentElement;
    el.replaceChildren(document.importNode(svgEl, true));
}

function getBackendLabel(backend: string): string {
    switch (backend) {
        case "mlx-whisper": return "MLX";
        case "transcribe-rs": return "RS";
        default: return "AUTO";
    }
}

function getAudioUrl(element: Element): string | null {
    const audio = element.querySelector("audio");
    if (audio?.src) return audio.src;

    const wrapper = element.closest("[class*='voiceMessage']") ||
                    element.closest("[class*='audioControls']") ||
                    element.closest("[class*='waveformContainer']");

    if (wrapper) {
        const parentAudio = wrapper.querySelector("audio");
        if (parentAudio?.src) return parentAudio.src;

        const source = wrapper.querySelector("source");
        if (source?.src) return source.src;
    }

    return null;
}

function updateToggleElement(el: Element): void {
    const active = getActiveBackend();
    el.textContent = getBackendLabel(active);
    (el as HTMLElement).title = `Backend: ${active} (click to switch)`;
    el.setAttribute("data-backend", active);
}

function createBackendToggle(): HTMLElement {
    const toggle = document.createElement("button");
    toggle.className = "vc-vocord-toggle";
    updateToggleElement(toggle);

    toggle.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();

        backendOverride = backendOverride === "transcribe-rs" ? "mlx-whisper" : "transcribe-rs";

        document.querySelectorAll(".vc-vocord-toggle").forEach(updateToggleElement);

        Toasts.show({
            message: `Backend: ${backendOverride}`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId()
        });
    });

    return toggle;
}

function getAudioId(url: string): string {
    // Use the full path (without query params) as a stable ID
    try {
        const parsed = new URL(url);
        return parsed.pathname;
    } catch {
        return url.split("?")[0];
    }
}

function createTranscribeButton(audioUrl: string, container: Element): HTMLElement {
    const audioId = getAudioId(audioUrl);

    const wrapper = document.createElement("div");
    wrapper.className = "vc-vocord-wrapper";
    wrapper.setAttribute("data-audio-id", audioId);

    const btnRow = document.createElement("div");
    btnRow.className = "vc-vocord-btn-row";

    const button = document.createElement("button");
    button.className = "vc-vocord-btn";
    button.title = "Transcribe voice message";
    setSvg(button, MICROPHONE_SVG);

    const toggle = createBackendToggle();
    btnRow.appendChild(button);
    btnRow.appendChild(toggle);

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
        setSvg(button, SPINNER_SVG);
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
            setSvg(button, MICROPHONE_SVG);
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
    setSvg(copyBtn, COPY_SVG);
    copyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
            if (settings.store.showToast) {
                Toasts.show({
                    message: "Copied to clipboard!",
                    type: Toasts.Type.SUCCESS,
                    id: Toasts.genId()
                });
            }
        }).catch(() => {
            Toasts.show({
                message: "Failed to copy to clipboard",
                type: Toasts.Type.FAILURE,
                id: Toasts.genId()
            });
        });
    });

    box.appendChild(textSpan);
    box.appendChild(copyBtn);
    return box;
}

function processVoiceMessages(): void {
    const selectors = [
        "[class*='voiceMessage']",
        "[class*='audioControls']",
        "[class*='waveform']",
        "[class*='audio_']"
    ];

    const voiceMessages = document.querySelectorAll(selectors.join(","));

    voiceMessages.forEach(vm => {
        if (processedElements.has(vm)) return;

        const audioUrl = getAudioUrl(vm);
        if (!audioUrl) return;
        if (vm.querySelector(".vc-vocord-wrapper")) return;

        processedElements.add(vm);

        const controlsContainer = vm.querySelector("[class*='controls']") ||
                                   vm.querySelector("[class*='buttons']") ||
                                   vm;

        const button = createTranscribeButton(audioUrl, vm);

        if (controlsContainer && controlsContainer !== vm) {
            controlsContainer.appendChild(button);
        } else {
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

        processVoiceMessages();

        observer = new MutationObserver(mutations => {
            if (mutations.some(m => m.addedNodes.length > 0)) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processVoiceMessages, 200);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log("[Vocord] Plugin started");
    },

    stop() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (observer) {
            observer.disconnect();
            observer = null;
        }

        document.getElementById("vc-vocord-styles")?.remove();
        document.querySelectorAll(".vc-vocord-wrapper").forEach(el => el.remove());

        transcriptions.clear();
        pendingTranscriptions.clear();
        backendOverride = null;

        console.log("[Vocord] Plugin stopped");
    }
});
