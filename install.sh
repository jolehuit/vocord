#!/bin/bash

# Vocord - One-line installer
# Usage: curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash
# Override Vencord path: VENCORD_DIR=~/my/vencord curl -sSL ... | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  Vocord${NC}"
echo -e "${CYAN}  Cross-platform voice message transcription for Vencord${NC}"
echo -e "${CYAN}  https://github.com/jolehuit/vocord${NC}"
echo ""

REPO="https://github.com/jolehuit/vocord.git"
OS="$(uname -s)"
ARCH="$(uname -m)"
IS_MAC_ARM=false
TMPDIR_VOCORD="$(mktemp -d)"

cleanup() { rm -rf "$TMPDIR_VOCORD"; }
trap cleanup EXIT

# ── Detect platform ───────────────────────────────────────────────

if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
    IS_MAC_ARM=true
    echo -e "  ${GREEN}Platform:${NC} macOS Apple Silicon"
    echo -e "  ${GREEN}Backend:${NC}  mlx-whisper"
elif [[ "$OS" == "Darwin" ]]; then
    echo -e "  ${GREEN}Platform:${NC} macOS Intel"
    echo -e "  ${GREEN}Backend:${NC}  transcribe-rs"
elif [[ "$OS" == "Linux" ]]; then
    echo -e "  ${GREEN}Platform:${NC} Linux ($ARCH)"
    echo -e "  ${GREEN}Backend:${NC}  transcribe-rs"
else
    echo -e "  ${GREEN}Platform:${NC} $OS ($ARCH)"
    echo -e "  ${GREEN}Backend:${NC}  transcribe-rs"
fi
echo ""

# ── Find Vencord source ──────────────────────────────────────────

if [[ -z "$VENCORD_DIR" ]]; then
    for dir in \
        "$HOME/Vencord" \
        "$HOME/VencordDev" \
        "$HOME/vencord" \
        "$HOME/.local/share/Vencord" \
        "$HOME/Vesktop" \
        "$HOME/vesktop" \
        /Applications/Vencord; do
        if [[ -d "$dir/src/userplugins" ]]; then
            VENCORD_DIR="$dir"
            break
        fi
    done

    # Also search common dev directories
    if [[ -z "$VENCORD_DIR" ]]; then
        for dir in "$HOME"/*/src/userplugins; do
            if [[ -d "$dir" ]]; then
                VENCORD_DIR="$(dirname "$(dirname "$dir")")"
                break
            fi
        done
    fi
fi

if [[ -n "$VENCORD_DIR" && -d "$VENCORD_DIR/src/userplugins" ]]; then
    DEST="$VENCORD_DIR/src/userplugins/vocord"
    echo -e "  ${GREEN}Vencord:${NC}  $VENCORD_DIR"
else
    echo -e "${YELLOW}  Vencord source not found automatically.${NC}"
    echo ""
    echo -e "  ${BOLD}Enter the path to your Vencord/Vesktop source directory:${NC}"
    echo -e "  (the folder containing src/userplugins/)"
    echo ""
    read -r -p "  Path: " VENCORD_DIR

    # Expand ~ manually
    VENCORD_DIR="${VENCORD_DIR/#\~/$HOME}"

    if [[ ! -d "$VENCORD_DIR/src/userplugins" ]]; then
        echo ""
        echo -e "${RED}  Error: $VENCORD_DIR/src/userplugins/ does not exist.${NC}"
        echo ""
        echo "  Make sure you have Vencord from source:"
        echo "    git clone https://github.com/Vendicated/Vencord"
        echo "    cd Vencord && pnpm install"
        echo ""
        echo "  Or set the path explicitly:"
        echo "    VENCORD_DIR=~/path/to/Vencord curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash"
        exit 1
    fi

    DEST="$VENCORD_DIR/src/userplugins/vocord"
    echo -e "  ${GREEN}Vencord:${NC}  $VENCORD_DIR"
fi
echo ""

# ── Step 1: Clone repo ────────────────────────────────────────────

echo -e "${BOLD}[1/4]${NC} Downloading Vocord..."
git clone --depth 1 --quiet "$REPO" "$TMPDIR_VOCORD/vocord"
echo -e "  ${GREEN}Done${NC}"

# ── Step 2: Install backend ───────────────────────────────────────

echo ""
VOCORD_DATA="$HOME/.local/share/vocord"

if [[ "$IS_MAC_ARM" == true ]]; then
    echo -e "${BOLD}[2/4]${NC} Installing mlx-whisper..."

    # Install uv if not present
    if ! command -v uv &> /dev/null; then
        echo "  Installing uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh 2>&1 | tail -1
        source "$HOME/.local/bin/env" 2>/dev/null || export PATH="$HOME/.local/bin:$PATH"
    fi
    echo -e "  uv $(uv --version | cut -d' ' -f2)"

    # Create isolated venv and install mlx-whisper
    VOCORD_VENV="$VOCORD_DATA/venv"
    echo "  Creating venv at $VOCORD_VENV..."
    uv venv "$VOCORD_VENV" --quiet
    echo "  Installing mlx-whisper (this may take a moment)..."
    uv pip install --python "$VOCORD_VENV/bin/python" mlx-whisper --quiet

    if "$VOCORD_VENV/bin/python" -c "import mlx_whisper" 2>/dev/null; then
        echo -e "  ${GREEN}mlx-whisper installed in isolated venv${NC}"
    else
        echo -e "${RED}Error: Failed to install mlx-whisper${NC}"
        exit 1
    fi
else
    echo -e "${BOLD}[2/4]${NC} Setting up transcribe-rs..."

    # Check Rust
    if ! command -v cargo &> /dev/null; then
        echo -e "${YELLOW}  Rust not found. Installing via rustup...${NC}"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --quiet
        source "$HOME/.cargo/env"
    fi
    echo -e "  Rust $(cargo --version | cut -d' ' -f2)"

    # Check ffmpeg
    if ! command -v ffmpeg &> /dev/null; then
        echo -e "${YELLOW}  Warning: ffmpeg not found.${NC}"
        if [[ "$OS" == "Darwin" ]]; then
            echo "  Install it: brew install ffmpeg"
        elif [[ "$OS" == "Linux" ]]; then
            echo "  Install it: sudo apt install ffmpeg"
        fi
    else
        echo -e "  ffmpeg found"
    fi

    # Build transcribe-cli
    echo "  Building transcribe-cli (this may take a few minutes)..."
    cd "$TMPDIR_VOCORD/vocord/transcribe-cli"
    cargo build --release --quiet 2>&1

    if [[ -f "target/release/transcribe-cli" ]]; then
        echo -e "  ${GREEN}transcribe-cli built${NC}"
    else
        echo -e "${RED}Error: Build failed${NC}"
        exit 1
    fi

    # Download model
    MODEL_DIR="$HOME/.local/share/vocord"
    MODEL_PATH="$MODEL_DIR/ggml-medium-q4_1.bin"

    if [[ ! -f "$MODEL_PATH" ]]; then
        echo "  Downloading Whisper model (~500 MB)..."
        mkdir -p "$MODEL_DIR"
        curl -L --progress-bar -o "$MODEL_PATH" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q4_1.bin"
        echo -e "  ${GREEN}Model saved to: $MODEL_PATH${NC}"
    else
        echo -e "  Model already at: $MODEL_PATH"
    fi
fi

# ── Step 3: Install plugin ────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/4]${NC} Installing plugin..."

rm -rf "$DEST"
mkdir -p "$DEST"

cp "$TMPDIR_VOCORD/vocord/index.tsx" "$DEST/"
cp "$TMPDIR_VOCORD/vocord/native.ts" "$DEST/"

# Copy transcribe-cli with built binary if applicable
if [[ "$IS_MAC_ARM" != true ]]; then
    cp -r "$TMPDIR_VOCORD/vocord/transcribe-cli" "$DEST/"
fi

echo -e "  ${GREEN}Installed to: $DEST${NC}"

# ── Step 4: Rebuild Vencord ───────────────────────────────────────

echo ""
echo -e "${BOLD}[4/4]${NC} Rebuilding Vencord..."

cd "$VENCORD_DIR"
if command -v pnpm &> /dev/null; then
    pnpm build 2>&1 | tail -3
    echo -e "  ${GREEN}Build complete${NC}"
else
    echo -e "${YELLOW}  pnpm not found -- rebuild manually: cd $VENCORD_DIR && pnpm build${NC}"
fi

# ── Done ──────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  Vocord installed successfully!${NC}"
echo ""
echo "  Next steps:"
echo "    1. Restart Discord / Vesktop"
echo "    2. Enable: Settings > Vencord > Plugins > Vocord"

if [[ "$IS_MAC_ARM" != true && -f "$MODEL_PATH" ]]; then
    echo "    3. Set GGML model path in plugin settings:"
    echo "       $MODEL_PATH"
fi

echo ""
