/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Toasts } from "@webpack/common";

const settings = definePluginSettings({
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

let observer: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const MICROPHONE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line><line x1="8" x2="16" y1="22" y2="22"></line></svg>`;

const SPINNER_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;

const COPY_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`;

function setSvg(el: HTMLElement, svg: string): void {
    el.innerHTML = svg;
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

function createTranscribeButton(audioUrl: string): HTMLElement {
    const audioId = getAudioId(audioUrl);

    const wrapper = document.createElement("div");
    wrapper.className = "vc-vocord-wrapper";
    wrapper.setAttribute("data-audio-id", audioId);

    const button = document.createElement("button");
    button.className = "vc-vocord-btn";
    button.title = "Transcribe voice message";
    setSvg(button, MICROPHONE_SVG);

    const existingTranscription = transcriptions.get(audioId);
    if (existingTranscription) {
        const transcriptionBox = createTranscriptionBox(existingTranscription);
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
                settings.store.language
            );

            if (result.error) {
                Toasts.show({
                    message: `Transcription failed: ${result.error}`,
                    type: Toasts.Type.FAILURE,
                    id: Toasts.genId()
                });
            } else {
                transcriptions.set(audioId, result.text);
                button.style.display = "none";
                const transcriptionBox = createTranscriptionBox(result.text);
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
            if (button.style.display !== "none") {
                button.disabled = false;
                button.classList.remove("transcribing");
                setSvg(button, MICROPHONE_SVG);
                button.title = "Transcribe voice message";
            }
        }
    });

    wrapper.appendChild(button);
    return wrapper;
}

function createTranscriptionBox(text: string): HTMLElement {
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
    // Find audio elements directly — resilient to Discord class name changes
    document.querySelectorAll("audio").forEach(audio => {
        const url = audio.src || audio.querySelector("source")?.src;
        if (!url) return;

        const container = audio.parentElement;
        if (!container || processedElements.has(container)) return;

        processedElements.add(container);

        // Place right after the player as a sibling, not inside
        if (container.nextElementSibling?.classList.contains("vc-vocord-wrapper")) return;
        const btn = createTranscribeButton(url);
        container.insertAdjacentElement("afterend", btn);
    });
}

export default definePlugin({
    name: "Vocord",
    description: "Transcribe Discord voice messages locally using Parakeet AI (parakeet-mlx on macOS ARM, transcribe-rs on other platforms)",
    authors: [{ name: "jolehuit", id: 0n }],
    settings,

    start() {
        const style = document.createElement("style");
        style.id = "vc-vocord-styles";
        style.textContent = `
            .vc-vocord-wrapper {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin-top: 6px;
                margin-left: 12px;
            }

            .vc-vocord-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                border: none;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.1);
                color: #dcddde;
                cursor: pointer;
                transition: all 0.15s ease;
            }

            .vc-vocord-btn:hover:not(:disabled) {
                background: #5865f2;
                color: #fff;
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
                background: rgba(255, 255, 255, 0.06);
                border-radius: 8px;
                max-width: 400px;
                max-height: 120px;
                margin-top: 4px;
            }

            .vc-vocord-transcription-text {
                flex: 1;
                font-size: 14px;
                line-height: 1.4;
                color: #dcddde;
                word-wrap: break-word;
                overflow-y: auto;
                max-height: 100px;
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
                color: #b5bac1;
                cursor: pointer;
                flex-shrink: 0;
            }

            .vc-vocord-transcription-copy:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
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

        console.log("[Vocord] Plugin stopped");
    }
});
