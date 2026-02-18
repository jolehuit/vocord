/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { randomBytes } from "crypto";
import https from "https";
import { arch, homedir, platform, tmpdir } from "os";
import { join } from "path";

const TEMP_DIR = join(tmpdir(), "vencord-vocord");
const VOCORD_DATA = join(homedir(), ".local", "share", "vocord");
const VOCORD_VENV_BIN = join(VOCORD_DATA, "venv", "bin");
const DEFAULT_PARAKEET_MODEL = join(VOCORD_DATA, "parakeet-tdt-0.6b-v3-int8");
const DEFAULT_MLX_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
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

function resolveBackend(): "parakeet-mlx" | "transcribe-rs" {
    const backendFile = join(VOCORD_DATA, "backend");
    if (existsSync(backendFile)) {
        const value = readFileSync(backendFile, "utf-8").trim();
        if (value === "parakeet-mlx" || value === "transcribe-rs") return value;
    }
    return isMacAppleSilicon() ? "parakeet-mlx" : "transcribe-rs";
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

        try {
            const parsed = new URL(url);
            if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
                reject(new Error(`Untrusted audio host: ${parsed.hostname}`));
                return;
            }
        } catch {
            reject(new Error(`Invalid URL: ${url}`));
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
                    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
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
async function convertToWav(oggPath: string): Promise<string> {
    const wavPath = oggPath.replace(/\.ogg$/, ".wav");

    return new Promise((resolve, reject) => {
        execFile("ffmpeg", [
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
        const proc = spawn(command, args);

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

            if (rawOutput) {
                const text = stdout.trim();
                if (!text) {
                    reject(new Error(`${label} produced no output`));
                } else {
                    resolve(text);
                }
            } else {
                try {
                    const result = JSON.parse(stdout.trim());
                    if (result.error) {
                        reject(new Error(result.error));
                    } else {
                        resolve(result.text);
                    }
                } catch {
                    reject(new Error(`Failed to parse ${label} output: ${stdout}`));
                }
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

/** Transcribe audio using parakeet-mlx (macOS ARM). */
async function runParakeetMlx(audioPath: string, language: string): Promise<string> {
    const venvBin = join(VOCORD_VENV_BIN, "parakeet-mlx");
    const bin = existsSync(venvBin) ? venvBin : "parakeet-mlx";

    const args = [audioPath, "--model", DEFAULT_MLX_MODEL];
    if (language) args.push("--language", language);

    return runSubprocess({
        command: bin,
        args,
        cleanupPath: audioPath,
        label: "parakeet-mlx",
        rawOutput: true,
        enoentMessage: "parakeet-mlx not found. Re-run the Vocord installer or: pip install parakeet-mlx",
    });
}

/** Transcribe audio using transcribe-cli (cross-platform, Parakeet). */
async function runTranscribeRs(wavPath: string, language: string): Promise<string> {
    if (!existsSync(DEFAULT_PARAKEET_MODEL)) {
        rmSync(wavPath, { force: true });
        throw new Error(`Parakeet model not found at ${DEFAULT_PARAKEET_MODEL}. Re-run the Vocord installer.`);
    }

    const cliBin = platform() === "win32" ? "transcribe-cli.exe" : "transcribe-cli";
    const cliPath = join(VOCORD_DATA, cliBin);

    const args = ["--audio", wavPath, "--model", DEFAULT_PARAKEET_MODEL];
    if (language) args.push("--language", language);

    return runSubprocess({
        command: cliPath,
        args,
        cleanupPath: wavPath,
        label: "transcribe-cli",
        errorStream: "stderr",
        enoentMessage: "transcribe-cli not found. Build it with: cd transcribe-cli && cargo build --release",
    });
}

export async function transcribe(
    _event: unknown,
    audioUrl: string,
    language: string
): Promise<{ text?: string; error?: string }> {
    try {
        const backend = resolveBackend();
        console.log(`[Vocord] Backend: ${backend} | Downloading audio...`);

        const oggPath = await downloadAudio(audioUrl);

        let text: string;

        if (backend === "parakeet-mlx") {
            console.log(`[Vocord] Transcribing with parakeet-mlx, model: ${DEFAULT_MLX_MODEL}`);
            text = await runParakeetMlx(oggPath, language);
        } else {
            console.log(`[Vocord] Converting OGG to WAV...`);
            const wavPath = await convertToWav(oggPath);

            console.log(`[Vocord] Transcribing with Parakeet ONNX, model: ${DEFAULT_PARAKEET_MODEL}`);
            text = await runTranscribeRs(wavPath, language);
        }

        console.log(`[Vocord] Transcription complete: ${text.substring(0, 50)}...`);
        return { text };
    } catch (err) {
        console.error("[Vocord] Error:", err);
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
    }
}
