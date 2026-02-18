# transcribe-cli

CLI wrapper around [transcribe-rs](https://github.com/cjpais/transcribe-rs) for transcribing audio files using Whisper (whisper.cpp via whisper-rs).

## Building

```bash
cargo build --release
```

The binary will be at `target/release/transcribe-cli`.

## Usage

```bash
transcribe-cli --model path/to/whisper-model.bin --audio path/to/audio.wav [--language en]
```

### Arguments

- `--audio` (required) - Path to WAV file (must be 16kHz, 16-bit, mono)
- `--model` (required) - Path to Whisper GGML model file (e.g. `whisper-medium-q4_1.bin`)
- `--language` (optional) - Language code (e.g. `en`, `es`, `fr`). Auto-detected if omitted.

### Output

On success (exit code 0), JSON is printed to stdout:

```json
{"text": "transcribed text here"}
```

On error (exit code 1), JSON is printed to stderr:

```json
{"error": "error message here"}
```

All logging goes to stderr, keeping stdout clean for JSON output.

## GPU Support

GPU acceleration is enabled by default:
- macOS: Metal
- Windows/Linux: Vulkan
