/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { randomBytes } from "crypto";
import https from "https";
import { arch, homedir, platform, tmpdir } from "os";
import { join } from "path";

const TEMP_DIR = join(tmpdir(), "vencord-vocord");
const VOCORD_VENV_PYTHON = join(homedir(), ".local", "share", "vocord", "venv", "bin", "python");
const MAX_REDIRECTS = 5;
const ALLOWED_REDIRECT_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];
const SUBPROCESS_TIMEOUT_MS = 5 * 60 * 1000;

function ensureTempDir(): void {
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
        return;
    }
    // Clean up temp files older than 1 hour
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    try {
        for (const file of readdirSync(TEMP_DIR)) {
            const filePath = join(TEMP_DIR, file);
            const stat = statSync(filePath);
            if (now - stat.mtimeMs > ONE_HOUR) {
                rmSync(filePath, { force: true });
            }
        }
    } catch { /* ignore cleanup errors */ }
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

async function downloadAudio(url: string, redirectCount = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        ensureTempDir();
        const filename = `audio_${Date.now()}_${randomBytes(4).toString("hex")}.ogg`;
        const filepath = join(TEMP_DIR, filename);
        const file = createWriteStream(filepath);

        const cleanup = () => {
            file.destroy();
            rmSync(filepath, { force: true });
        };

        if (!url.startsWith("https://")) {
            reject(new Error("Only HTTPS URLs are supported"));
            return;
        }

        https.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; Vocord/1.0)"
            }
        }, response => {
            const status = response.statusCode ?? 0;

            if ([301, 302, 303, 307, 308].includes(status)) {
                cleanup();
                if (redirectCount >= MAX_REDIRECTS) {
                    reject(new Error("Too many redirects"));
                    return;
                }
                const redirectUrl = response.headers.location;
                if (!redirectUrl) {
                    reject(new Error(`Redirect ${status} without Location header`));
                    return;
                }
                try {
                    const parsed = new URL(redirectUrl, url);
                    if (parsed.protocol !== "https:") {
                        reject(new Error(`Redirect to non-HTTPS URL blocked: ${parsed.protocol}`));
                        return;
                    }
                    if (!ALLOWED_REDIRECT_HOSTS.includes(parsed.hostname)) {
                        reject(new Error(`Redirect to untrusted host blocked: ${parsed.hostname}`));
                        return;
                    }
                    downloadAudio(parsed.href, redirectCount + 1).then(resolve).catch(reject);
                } catch {
                    reject(new Error(`Invalid redirect URL: ${redirectUrl}`));
                }
                return;
            }

            if (status !== 200) {
                cleanup();
                reject(new Error(`Failed to download: HTTP ${status}`));
                return;
            }

            response.pipe(file);

            file.on("finish", () => {
                file.close();
                resolve(filepath);
            });
        }).on("error", err => {
            cleanup();
            reject(err);
        });
    });
}

/** Convert OGG audio to WAV (16kHz, 16-bit, mono) using ffmpeg. */
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

/** Transcribe audio using mlx-whisper via Python (macOS ARM). */
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

        const python = existsSync(VOCORD_VENV_PYTHON) ? VOCORD_VENV_PYTHON : "python3";

        const proc = spawn(python, args);

        let stdout = "";
        let stderr = "";
        let killed = false;

        const timeout = setTimeout(() => {
            killed = true;
            proc.kill();
        }, SUBPROCESS_TIMEOUT_MS);

        proc.stdout.on("data", data => { stdout += data.toString(); });
        proc.stderr.on("data", data => { stderr += data.toString(); });

        proc.on("close", code => {
            clearTimeout(timeout);
            rmSync(audioPath, { force: true });

            if (killed) {
                reject(new Error("mlx-whisper timed out"));
                return;
            }

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
            clearTimeout(timeout);
            rmSync(audioPath, { force: true });
            reject(err);
        });
    });
}

/** Transcribe audio using transcribe-cli (cross-platform, Rust/whisper.cpp). */
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
        const cliBin = platform() === "win32" ? "transcribe-cli.exe" : "transcribe-cli";
        const cliPath = join(__dirname, "transcribe-cli", "target", "release", cliBin);

        const args = ["--audio", wavPath, "--model", modelPath];
        if (language) {
            args.push("--language", language);
        }

        const proc = spawn(cliPath, args);

        let stdout = "";
        let stderr = "";
        let killed = false;

        const timeout = setTimeout(() => {
            killed = true;
            proc.kill();
        }, SUBPROCESS_TIMEOUT_MS);

        proc.stdout.on("data", data => { stdout += data.toString(); });
        proc.stderr.on("data", data => { stderr += data.toString(); });

        proc.on("close", code => {
            clearTimeout(timeout);
            rmSync(wavPath, { force: true });

            if (killed) {
                reject(new Error("transcribe-cli timed out"));
                return;
            }

            if (code !== 0) {
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
            clearTimeout(timeout);
            rmSync(wavPath, { force: true });
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                reject(new Error("transcribe-cli not found. Build it with: cd transcribe-cli && cargo build --release"));
            } else {
                reject(err);
            }
        });
    });
}

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
    } catch (err) {
        console.error("[Vocord] Error:", err);
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
    }
}
