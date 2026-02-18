# Vocord

Cross-platform voice message transcription for [Vencord](https://github.com/Vendicated/Vencord). 100% local, privacy-first.

## Quick Start

Make sure you have [Vencord from source](https://github.com/Vendicated/Vencord) installed, then run:

```bash
curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash
```

That's it. The installer handles everything:
- Detects your platform
- Installs the right transcription backend:
  - **macOS ARM**: installs [uv](https://github.com/astral-sh/uv), creates an isolated venv, installs mlx-whisper -- no system pollution
  - **Linux / Windows / macOS Intel**: installs Rust if needed, builds the transcribe-cli binary, downloads a Whisper model -- no Python required
- Copies the plugin into Vencord
- Rebuilds Vencord

Restart Discord, enable **Vocord** in Settings > Vencord > Plugins, and you're good to go.

## How It Works

| Platform | Backend | How |
|----------|---------|-----|
| macOS Apple Silicon | [mlx-whisper](https://github.com/ml-explore/mlx-examples) | GPU-accelerated via Apple MLX |
| Linux / Windows / macOS Intel | [transcribe-rs](https://github.com/cjpais/transcribe-rs) | whisper.cpp via Rust (Metal/Vulkan GPU) |

The backend is auto-detected. You can also switch manually via the **MLX/RS** toggle button next to each voice message, or in the plugin settings.

## Features

- One-click transcription of voice messages
- 100% local -- no data sent to external servers
- Auto language detection (or set a specific language)
- Copy transcription to clipboard
- Live backend toggle (MLX / RS) for A/B testing

## Manual Install

If you prefer not to use the one-liner:

1. **Clone Vencord** (if not already):
   ```bash
   git clone https://github.com/Vendicated/Vencord && cd Vencord && pnpm install
   ```

2. **Clone and copy Vocord**:
   ```bash
   git clone https://github.com/jolehuit/vocord.git /tmp/vocord
   mkdir -p src/userplugins/vocord
   cp /tmp/vocord/index.tsx /tmp/vocord/native.ts src/userplugins/vocord/
   cp -r /tmp/vocord/transcribe-cli src/userplugins/vocord/
   ```

3. **Set up backend**:

   **macOS ARM:**
   ```bash
   # Install uv (if not already)
   curl -LsSf https://astral.sh/uv/install.sh | sh

   # Create isolated venv and install mlx-whisper
   uv venv ~/.local/share/vocord/venv
   uv pip install --python ~/.local/share/vocord/venv/bin/python mlx-whisper
   ```

   **Linux / Windows / macOS Intel:**
   ```bash
   # ffmpeg (for ogg->wav conversion)
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian/Ubuntu
   winget install ffmpeg         # Windows

   # Build transcribe-cli
   cd src/userplugins/vocord/transcribe-cli
   cargo build --release

   # Download a Whisper model (~500 MB)
   mkdir -p ~/.local/share/vocord
   curl -L -o ~/.local/share/vocord/ggml-medium-q4_1.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q4_1.bin
   ```

4. **Build and restart**:
   ```bash
   cd /path/to/Vencord && pnpm build
   ```
   Restart Discord, enable Vocord in plugin settings.

5. **For transcribe-rs users**: set the GGML model path in Settings > Plugins > Vocord.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | auto-detect, mlx-whisper, or transcribe-rs | `auto` |
| Whisper Model | HuggingFace model ID (mlx-whisper) | `mlx-community/whisper-large-v3-turbo` |
| GGML Model Path | Path to `.bin` model (transcribe-rs) | -- |
| ffmpeg Path | Custom ffmpeg binary path | system ffmpeg |
| Language | Language code or empty for auto-detect | auto |
| Show Toast | Notification on completion | `true` |

## Architecture

```
Discord Voice Message
  |  click
  v
index.tsx (browser) ---IPC---> native.ts (Node.js)
                                  |
                         platform detection
                          /             \
                    macOS ARM64      everything else
                         |                |
                    mlx-whisper       ffmpeg (ogg->wav)
                    (uv venv)             |
                         |          transcribe-cli
                         |          (Rust/whisper.cpp)
                          \             /
                           JSON result
                         {"text": "..."}
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| mlx-whisper not installed | `uv pip install --python ~/.local/share/vocord/venv/bin/python mlx-whisper` |
| ffmpeg not found | `brew install ffmpeg` / `sudo apt install ffmpeg` |
| transcribe-cli not found | `cd transcribe-cli && cargo build --release` |
| No GGML model path | Set path in Settings > Plugins > Vocord |
| Plugin not showing | Rebuild Vencord (`pnpm build`) and restart Discord |

## License

GPL-3.0-or-later

## Credits

- [Vencord](https://github.com/Vendicated/Vencord)
- [mlx-whisper](https://github.com/ml-explore/mlx-examples)
- [transcribe-rs](https://github.com/cjpais/transcribe-rs)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- [OpenAI Whisper](https://github.com/openai/whisper)

## Author

[jolehuit](https://github.com/jolehuit)
