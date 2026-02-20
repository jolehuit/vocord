/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import https from "https";
import { arch, homedir, platform, tmpdir } from "os";
import { join } from "path";

const TEMP_DIR = join(tmpdir(), "vencord-vocord");
const VOCORD_DATA = join(homedir(), ".local", "share", "vocord");
const VOCORD_VENV_BIN = join(VOCORD_DATA, "venv", "bin");
const DEFAULT_WHISPER_MODEL = join(VOCORD_DATA, "ggml-large-v3-turbo.bin");
const DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo";
const MAX_REDIRECTS = 5;
const ALLOWED_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];
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

/** Return process env with common binary dirs prepended, so subprocesses find ffmpeg etc. */
function getExtendedEnv(): NodeJS.ProcessEnv {
    const extras = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    const current = process.env.PATH ?? "";
    const merged = [...extras.filter(p => !current.split(":").includes(p)), current]
        .filter(Boolean)
        .join(":");
    return { ...process.env, PATH: merged };
}

function resolveBackend(): "mlx-whisper" | "transcribe-rs" {
    const backendFile = join(VOCORD_DATA, "backend");
    if (existsSync(backendFile)) {
        const value = readFileSync(backendFile, "utf-8").trim();
        if (value === "mlx-whisper" || value === "transcribe-rs") return value;
    }
    return isMacAppleSilicon() ? "mlx-whisper" : "transcribe-rs";
}

function validateAudioUrl(url: string): void {
    if (!url.startsWith("https://")) {
        throw new Error("Only HTTPS URLs are supported");
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`Invalid URL: ${url}`);
    }

    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
        throw new Error(`Untrusted audio host: ${parsed.hostname}`);
    }
}

async function downloadAudio(url: string, redirectCount = 0): Promise<string> {
    validateAudioUrl(url);

    return new Promise((resolve, reject) => {
        ensureTempDir();
        const filename = `audio_${Date.now()}_${randomBytes(4).toString("hex")}.ogg`;
        const filepath = join(TEMP_DIR, filename);
        const file = createWriteStream(filepath);

        const cleanup = () => {
            file.destroy();
            rmSync(filepath, { force: true });
        };

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
                const location = response.headers.location;
                if (!location) {
                    reject(new Error(`Redirect ${status} without Location header`));
                    return;
                }
                try {
                    const resolved = new URL(location, url);
                    validateAudioUrl(resolved.href);
                    downloadAudio(resolved.href, redirectCount + 1).then(resolve).catch(reject);
                } catch (err) {
                    reject(err instanceof Error ? err : new Error(`Invalid redirect URL: ${location}`));
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
                file.close(err => {
                    if (err) {
                        cleanup();
                        reject(err);
                    } else {
                        resolve(filepath);
                    }
                });
            });
        }).on("error", err => {
            cleanup();
            reject(err);
        });
    });
}

/** Convert OGG audio to WAV (16kHz, 16-bit, mono) using ffmpeg. */
async function convertToWav(oggPath: string): Promise<string> {
    // Always derive the WAV path by stripping any extension then appending .wav,
    // so the output path is never the same as the input path.
    const wavPath = oggPath.replace(/\.[^.]+$/, ".wav");

    return new Promise((resolve, reject) => {
        execFile("ffmpeg", [
            "-i", oggPath,
            "-ar", "16000",
            "-ac", "1",
            "-sample_fmt", "s16",
            "-y",
            wavPath
        ], { timeout: 30000, env: getExtendedEnv() }, (error, _stdout, stderr) => {
            rmSync(oggPath, { force: true });

            if (error) {
                rmSync(wavPath, { force: true });
                const isMissing = stderr?.includes("not found") || error.message.includes("ENOENT");
                const msg = isMissing
                    ? "ffmpeg not found. Install it: brew install ffmpeg (macOS) / sudo apt install ffmpeg (Linux)"
                    : `ffmpeg conversion failed: ${error.message}`;
                reject(new Error(msg));
                return;
            }

            resolve(wavPath);
        });
    });
}

interface SubprocessOptions {
    command: string;
    args: string[];
    cleanupPath: string;
    label: string;
    /** Which stream to look for JSON error output on non-zero exit. */
    errorStream?: "stdout" | "stderr";
    /** Custom handler for ENOENT spawn errors. */
    enoentMessage?: string;
    /** If true, return stdout as plain text instead of parsing JSON. */
    rawOutput?: boolean;
}

/** Spawn a subprocess with timeout, collect JSON output, and clean up the audio file. */
async function runSubprocess(options: SubprocessOptions): Promise<string> {
    const { command, args, cleanupPath, label, errorStream = "stdout", enoentMessage, rawOutput = false } = options;

    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { env: getExtendedEnv() });

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
            rmSync(cleanupPath, { force: true });

            if (killed) {
                reject(new Error(`${label} timed out`));
                return;
            }

            if (code !== 0) {
                const errorOutput = errorStream === "stderr" ? stderr : stdout;
                try {
                    const result = JSON.parse(errorOutput.trim());
                    if (result.error) {
                        reject(new Error(result.error));
                        return;
                    }
                } catch { /* ignore parse errors */ }
                reject(new Error(stderr || `${label} exited with code ${code}`));
                return;
            }

            const trimmed = stdout.trim();

            if (rawOutput) {
                if (!trimmed) {
                    reject(new Error(`${label} produced no output`));
                } else {
                    resolve(trimmed);
                }
                return;
            }

            try {
                const result = JSON.parse(trimmed);
                if (result.error) {
                    reject(new Error(result.error));
                } else if (typeof result.text !== "string") {
                    reject(new Error(`${label} output missing 'text' field: ${trimmed}`));
                } else {
                    resolve(result.text);
                }
            } catch {
                reject(new Error(`Failed to parse ${label} output: ${stdout}`));
            }
        });

        proc.on("error", err => {
            clearTimeout(timeout);
            rmSync(cleanupPath, { force: true });
            if (enoentMessage && (err as NodeJS.ErrnoException).code === "ENOENT") {
                reject(new Error(enoentMessage));
            } else {
                reject(err);
            }
        });
    });
}

/** Transcribe audio using mlx-whisper (macOS ARM). */
async function runMlxWhisper(audioPath: string): Promise<string> {
    const venvPython = join(VOCORD_VENV_BIN, "python");
    const python = existsSync(venvPython) ? venvPython : "python3";

    // Pass the model path via argv so it is never interpolated into Python source code.
    const script = `import mlx_whisper, sys; r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2]); print(r["text"].strip())`;

    return runSubprocess({
        command: python,
        args: ["-c", script, audioPath, DEFAULT_MLX_MODEL],
        cleanupPath: audioPath,
        label: "mlx-whisper",
        rawOutput: true,
        enoentMessage: "mlx-whisper not found. Re-run the Vocord installer or: pip install mlx-whisper",
    });
}

/** Transcribe audio using transcribe-cli (cross-platform, Whisper). */
async function runTranscribeRs(wavPath: string): Promise<string> {
    if (!existsSync(DEFAULT_WHISPER_MODEL)) {
        rmSync(wavPath, { force: true });
        throw new Error(`Whisper model not found at ${DEFAULT_WHISPER_MODEL}. Re-run the Vocord installer.`);
    }

    const cliBin = platform() === "win32" ? "transcribe-cli.exe" : "transcribe-cli";
    const cliPath = join(VOCORD_DATA, cliBin);

    return runSubprocess({
        command: cliPath,
        args: ["--audio", wavPath, "--model", DEFAULT_WHISPER_MODEL],
        cleanupPath: wavPath,
        label: "transcribe-cli",
        errorStream: "stderr",
        enoentMessage: "transcribe-cli not found. Build it with: cd transcribe-cli && cargo build --release",
    });
}

export async function transcribe(
    _event: unknown,
    audioUrl: string
): Promise<{ text?: string; error?: string }> {
    try {
        const backend = resolveBackend();
        console.log(`[Vocord] Backend: ${backend} | Downloading audio...`);

        const oggPath = await downloadAudio(audioUrl);

        let text: string;

        if (backend === "mlx-whisper") {
            console.log(`[Vocord] Transcribing with mlx-whisper, model: ${DEFAULT_MLX_MODEL}`);
            text = await runMlxWhisper(oggPath);
        } else {
            console.log(`[Vocord] Converting OGG to WAV...`);
            const wavPath = await convertToWav(oggPath);

            console.log(`[Vocord] Transcribing with Whisper GGML, model: ${DEFAULT_WHISPER_MODEL}`);
            text = await runTranscribeRs(wavPath);
        }

        const preview = text.length > 50 ? `${text.substring(0, 50)}...` : text;
        console.log(`[Vocord] Transcription complete: ${preview}`);
        return { text };
    } catch (err) {
        console.error("[Vocord] Error:", err);
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
    }
}
