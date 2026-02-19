# Vocord

Cross-platform voice message transcription for [Vencord](https://github.com/Vendicated/Vencord). 100% local, privacy-first.

## Quick Start

**macOS / Linux:**
```bash
curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/jolehuit/vocord/main/install.ps1 | iex
```

That's it. The installer handles everything automatically:
- Finds your Vencord source tree (or clones it if you don't have one)
- **macOS ARM**: lets you choose between mlx-whisper (GPU, recommended) and whisper-onnx (CPU)
- **Linux / macOS Intel / Windows**: installs Rust if needed, builds the transcribe-cli binary, downloads the Whisper model
- Cleans up any existing Vocord installation before reinstalling
- Copies the plugin into Vencord and rebuilds (verifies Vocord is in the build output)
- Auto-configures **Vesktop** if detected (closes it, sets the custom Vencord build path, restarts it)
- Auto-injects into **Discord Desktop** if Vesktop is not found

Works with **Vesktop**, **Discord Desktop + Vencord**, and **Equicord** on macOS, Linux, and Windows.

Restart Discord / Vesktop, enable **Vocord** in Settings > Vencord > Plugins, and you're good to go.

> **Tip:** If the installer can't find your Vencord source, you can specify it:
> ```bash
> VENCORD_DIR=~/path/to/Vencord curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash
> ```
> On Windows:
> ```powershell
> $env:VENCORD_DIR="C:\path\to\Vencord"; irm https://raw.githubusercontent.com/jolehuit/vocord/main/install.ps1 | iex
> ```

## How It Works

| Platform | Backend | Model |
|----------|---------|-------|
| macOS Apple Silicon | [mlx-whisper](https://github.com/ml-explore/mlx-examples) | [whisper-large-v3-turbo](https://huggingface.co/mlx-community/whisper-large-v3-turbo) — GPU via Apple MLX |
| Linux / Windows / macOS Intel | [transcribe-rs](https://github.com/cjpais/transcribe-rs) (Whisper GGML) | ggml-large-v3-turbo — CPU/GPU |

The installer lets you choose your backend on macOS Apple Silicon. On other platforms, transcribe-rs is used automatically.

Auto-detects language — no configuration needed.

## Features

- One-click transcription of voice messages
- 100% local — no data sent to external servers
- Auto language detection
- Copy transcription to clipboard
- Clean reinstall — re-running the installer removes the old version automatically

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Show Toast | Notification on completion | `true` |

Everything (backend, model, ffmpeg) is auto-detected. No manual configuration needed.

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
   ```

3. **Set up backend**:

   **macOS ARM (mlx-whisper):**
   ```bash
   uv venv ~/.local/share/vocord/venv --allow-existing
   uv pip install --python ~/.local/share/vocord/venv/bin/python mlx-whisper
   echo "mlx-whisper" > ~/.local/share/vocord/backend
   ```

   **Linux / Windows / macOS Intel (transcribe-rs):**
   ```bash
   # ffmpeg (for ogg->wav conversion)
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian/Ubuntu
   winget install ffmpeg        # Windows

   # Build and install transcribe-cli
   cd /tmp/vocord/transcribe-cli
   cargo build --release
   cp target/release/transcribe-cli ~/.local/share/vocord/

   # Download Whisper large-v3-turbo GGML model (~800 MB)
   curl -L --fail -o ~/.local/share/vocord/ggml-large-v3-turbo.bin \
     https://blob.handy.computer/ggml-large-v3-turbo.bin

   echo "transcribe-rs" > ~/.local/share/vocord/backend
   ```

4. **Build**:
   ```bash
   cd /path/to/Vencord && pnpm build
   ```

5. **Connect your client**:
   - **Vesktop**: Settings > Developer Options > Vencord Location → select `Vencord/dist/`
   - **Discord Desktop**: `cd /path/to/Vencord && pnpm inject`

6. Restart Discord / Vesktop, enable Vocord in Settings > Vencord > Plugins.

## Architecture

```
Discord Voice Message
  |  click
  v
index.tsx (browser) ---IPC---> native.ts (Node.js)
                                  |
                         reads ~/.local/share/vocord/backend
                          /             \
                    macOS ARM64      everything else
                    (mlx-whisper)         |
                         |           ffmpeg (ogg->wav)
                         |                |
                   python venv       transcribe-cli
                  (whisper-large-     (Whisper GGML)
                    v3-turbo)
                          \             /
                           JSON result
                         {"text": "..."}
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| Plugin not showing (Vesktop) | The installer auto-configures Vesktop. If it didn't work: Vesktop Settings > Developer Options > Vencord Location → select your Vencord `dist/` folder |
| Plugin not showing (Discord) | Rebuild (`cd Vencord && pnpm build`) and inject (`pnpm inject`), then restart Discord |
| mlx-whisper not found | Re-run the installer, or: `uv pip install --python ~/.local/share/vocord/venv/bin/python mlx-whisper` |
| ffmpeg not found | `brew install ffmpeg` / `sudo apt install ffmpeg` |
| transcribe-cli not found | Re-run the installer to rebuild the binary |
| Whisper model not found | Re-run the installer to download the model |

## License

GPL-3.0-or-later

## Credits

- [Vencord](https://github.com/Vendicated/Vencord)
- [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) / [mlx-community/whisper-large-v3-turbo](https://huggingface.co/mlx-community/whisper-large-v3-turbo)
- [transcribe-rs](https://github.com/cjpais/transcribe-rs)
- [Handy](https://github.com/cjpais/Handy)

## Author

[jolehuit](https://github.com/jolehuit)
