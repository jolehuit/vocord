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
- **macOS ARM**: lets you choose between parakeet-mlx (GPU, recommended) and parakeet-onnx (CPU)
- **Linux / macOS Intel / Windows**: installs Rust if needed, builds the transcribe-cli binary, downloads a Whisper model
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

| Platform | Backend | How |
|----------|---------|-----|
| macOS Apple Silicon | [parakeet-mlx](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3) | GPU-accelerated via Apple MLX |
| Linux / Windows / macOS Intel | [Parakeet](https://github.com/cjpais/transcribe-rs) via transcribe-rs | ONNX runtime (Metal/Vulkan GPU) |

The installer lets you choose your backend on macOS Apple Silicon. On other platforms, Parakeet is used automatically.

## Features

- One-click transcription of voice messages
- 100% local -- no data sent to external servers
- Auto language detection (or set a specific language)
- Copy transcription to clipboard
- Clean reinstall -- re-running the installer removes the old version automatically

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

   # Create isolated venv and install parakeet-mlx
   uv venv ~/.local/share/vocord/venv --allow-existing
   uv pip install --python ~/.local/share/vocord/venv/bin/python parakeet-mlx
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

   # Download Parakeet v3 int8 model (~200 MB)
   mkdir -p ~/.local/share/vocord
   curl -L -o /tmp/parakeet.tar.gz https://blob.handy.computer/parakeet-v3-int8.tar.gz
   tar -xzf /tmp/parakeet.tar.gz -C ~/.local/share/vocord
   rm /tmp/parakeet.tar.gz
   ```

4. **Build**:
   ```bash
   cd /path/to/Vencord && pnpm build
   ```

5. **Connect your client**:
   - **Vesktop**: Settings > Developer Options > Vencord Location → select `Vencord/dist/`
   - **Discord Desktop**: `cd /path/to/Vencord && pnpm inject`

6. Restart Discord / Vesktop, enable Vocord in Settings > Vencord > Plugins.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Language | Language code (e.g., `fr`, `en`) or empty for auto-detect | auto |
| Show Toast | Notification on completion | `true` |

Everything else (backend, models, ffmpeg) is auto-detected.

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
                   parakeet-mlx      ffmpeg (ogg->wav)
                    (uv venv)             |
                         |          transcribe-cli
                         |          (Parakeet v3 / ONNX)
                          \             /
                           JSON result
                         {"text": "..."}
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| Plugin not showing (Vesktop) | The installer auto-configures Vesktop. If it didn't work: Vesktop Settings > Developer Options > Vencord Location → select your Vencord `dist/` folder |
| Plugin not showing (Discord) | Rebuild (`cd Vencord && pnpm build`) and inject (`pnpm inject`), then restart Discord |
| parakeet-mlx not found | Re-run the installer, or: `uv pip install --python ~/.local/share/vocord/venv/bin/python parakeet-mlx` |
| ffmpeg not found | `brew install ffmpeg` / `sudo apt install ffmpeg` |
| transcribe-cli not found | `cd transcribe-cli && cargo build --release` |
| Parakeet model not found | Re-run the installer to download the model |

## License

GPL-3.0-or-later

## Credits

- [Vencord](https://github.com/Vendicated/Vencord)
- [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [parakeet-mlx](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3)
- [transcribe-rs](https://github.com/cjpais/transcribe-rs)
- [Handy](https://github.com/cjpais/Handy)

## Author

[jolehuit](https://github.com/jolehuit)
