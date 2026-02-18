/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "fs";
import http from "http";
import https from "https";
import { arch, homedir, platform, tmpdir } from "os";
import { join } from "path";

const TEMP_DIR = join(tmpdir(), "vencord-vocord");
const VOCORD_VENV_PYTHON = join(homedir(), ".local", "share", "vocord", "venv", "bin", "python");

function ensureTempDir() {
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }
}

function isMacAppleSilicon(): boolean {
    return platform() === "darwin" && arch() === "arm64";
}

function resolveBackend(backend: string): "mlx-whisper" | "transcribe-rs" {
    if (backend === "mlx-whisper") return "mlx-whisper";
    if (backend === "transcribe-rs") return "transcribe-rs";
    // auto-detect
    return isMacAppleSilicon() ? "mlx-whisper" : "transcribe-rs";
}

async function downloadAudio(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        ensureTempDir();
        const filename = `audio_${Date.now()}.ogg`;
        const filepath = join(TEMP_DIR, filename);
        const file = createWriteStream(filepath);

        const protocol = url.startsWith("https") ? https : http;

        protocol.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; Vocord/1.0)"
            }
        }, response => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    rmSync(filepath, { force: true });
                    downloadAudio(redirectUrl).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                file.close();
                rmSync(filepath, { force: true });
                reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on("finish", () => {
                file.close();
                resolve(filepath);
            });
        }).on("error", err => {
            file.close();
            rmSync(filepath, { force: true });
            reject(err);
        });
    });
}

/**
 * Convert OGG audio to WAV (16kHz, 16-bit, mono) using ffmpeg.
 * Required for the transcribe-rs backend.
 */
async function convertToWav(oggPath: string, ffmpegPath: string): Promise<string> {
    const wavPath = oggPath.replace(/\.ogg$/, ".wav");
    const ffmpeg = ffmpegPath || "ffmpeg";

    return new Promise((resolve, reject) => {
        execFile(ffmpeg, [
            "-i", oggPath,
            "-ar", "16000",
            "-ac", "1",
            "-sample_fmt", "s16",
            "-y",
            wavPath
        ], { timeout: 30000 }, (error, _stdout, stderr) => {
            rmSync(oggPath, { force: true });

            if (error) {
                rmSync(wavPath, { force: true });
                const msg = stderr?.includes("not found") || error.message.includes("ENOENT")
                    ? "ffmpeg not found. Please install ffmpeg or set the ffmpeg path in settings."
                    : `ffmpeg conversion failed: ${error.message}`;
                reject(new Error(msg));
                return;
            }

            resolve(wavPath);
        });
    });
}

/**
 * Transcribe audio using mlx-whisper via Python (macOS ARM).
 */
async function runMlxWhisper(
    audioPath: string,
    model: string,
    language: string
): Promise<string> {
    return new Promise((resolve, reject) => {
        const pythonScript = `
import sys
import json

try:
    import mlx_whisper
except ImportError:
    print(json.dumps({"error": "mlx-whisper not installed. Run the Vocord installer or: uv pip install mlx-whisper"}))
    sys.exit(1)

audio_path = sys.argv[1]
model = sys.argv[2]
language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

try:
    kwargs = {"path_or_hf_repo": model}
    if language:
        kwargs["language"] = language

    result = mlx_whisper.transcribe(audio_path, **kwargs)
    print(json.dumps({"text": result["text"].strip()}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

        const args = ["-c", pythonScript, audioPath, model];
        if (language) {
            args.push(language);
        }

        // Use the Vocord venv python if available, fall back to system python3
        const python = existsSync(VOCORD_VENV_PYTHON) ? VOCORD_VENV_PYTHON : "python3";

        const proc = spawn(python, args, {
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", data => { stdout += data.toString(); });
        proc.stderr.on("data", data => { stderr += data.toString(); });

        proc.on("close", code => {
            rmSync(audioPath, { force: true });

            if (code !== 0) {
                try {
                    const result = JSON.parse(stdout.trim());
                    if (result.error) {
                        reject(new Error(result.error));
                        return;
                    }
                } catch { /* ignore parse errors */ }
                reject(new Error(stderr || `python3 exited with code ${code}`));
                return;
            }

            try {
                const result = JSON.parse(stdout.trim());
                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result.text);
                }
            } catch {
                reject(new Error(`Failed to parse mlx-whisper output: ${stdout}`));
            }
        });

        proc.on("error", err => {
            rmSync(audioPath, { force: true });
            reject(err);
        });
    });
}

/**
 * Transcribe audio using transcribe-cli (cross-platform, Rust/whisper.cpp).
 * Requires the audio to be converted to WAV 16kHz mono first.
 */
async function runTranscribeRs(
    wavPath: string,
    modelPath: string,
    language: string
): Promise<string> {
    if (!modelPath) {
        rmSync(wavPath, { force: true });
        throw new Error("No GGML model path configured. Set 'Path to GGML Whisper model file' in Vocord settings.");
    }

    return new Promise((resolve, reject) => {
        const cliPath = join(__dirname, "..", "..", "userplugins", "vocord", "transcribe-cli", "target", "release", "transcribe-cli");

        const args = ["--audio", wavPath, "--model", modelPath];
        if (language) {
            args.push("--language", language);
        }

        const proc = spawn(cliPath, args, {
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", data => { stdout += data.toString(); });
        proc.stderr.on("data", data => { stderr += data.toString(); });

        proc.on("close", code => {
            rmSync(wavPath, { force: true });

            if (code !== 0) {
                // transcribe-cli outputs error JSON to stderr
                try {
                    const result = JSON.parse(stderr.trim());
                    if (result.error) {
                        reject(new Error(result.error));
                        return;
                    }
                } catch { /* ignore parse errors */ }
                reject(new Error(stderr || `transcribe-cli exited with code ${code}`));
                return;
            }

            try {
                const result = JSON.parse(stdout.trim());
                resolve(result.text);
            } catch {
                reject(new Error(`Failed to parse transcribe-cli output: ${stdout}`));
            }
        });

        proc.on("error", err => {
            rmSync(wavPath, { force: true });
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                reject(new Error("transcribe-cli not found. Build it with: cd transcribe-cli && cargo build --release"));
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Main transcribe function exported to the plugin.
 */
export async function transcribe(
    audioUrl: string,
    model: string,
    language: string,
    backend: string,
    modelPath: string,
    ffmpegPath: string
): Promise<{ text?: string; error?: string }> {
    try {
        const resolvedBackend = resolveBackend(backend);
        console.log(`[Vocord] Backend: ${resolvedBackend} | Downloading audio...`);

        const oggPath = await downloadAudio(audioUrl);

        let text: string;

        if (resolvedBackend === "mlx-whisper") {
            console.log(`[Vocord] Transcribing with mlx-whisper, model: ${model}`);
            text = await runMlxWhisper(oggPath, model, language);
        } else {
            console.log(`[Vocord] Converting OGG to WAV...`);
            const wavPath = await convertToWav(oggPath, ffmpegPath);

            console.log(`[Vocord] Transcribing with transcribe-rs, model: ${modelPath}`);
            text = await runTranscribeRs(wavPath, modelPath, language);
        }

        console.log(`[Vocord] Transcription complete: ${text.substring(0, 50)}...`);
        return { text };
    } catch (err: any) {
        console.error("[Vocord] Error:", err);
        return { error: err.message || String(err) };
    }
}
