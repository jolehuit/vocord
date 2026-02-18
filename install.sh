#!/bin/bash

# Vocord - One-line installer
# Usage: curl -sSL https://raw.githubusercontent.com/jolehuit/vocord/main/install.sh | bash
# Override Vencord path: VENCORD_DIR=~/my/vencord curl -sSL ... | bash

set -eo pipefail

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
TMPDIR_VOCORD="$(mktemp -d)"
VOCORD_DATA="$HOME/.local/share/vocord"

cleanup() { rm -rf "$TMPDIR_VOCORD"; }
trap cleanup EXIT

# ── Detect platform ───────────────────────────────────────────────

BACKEND="transcribe-rs"

if [[ "$OS" == "Darwin" && "$ARCH" == "arm64" ]]; then
    echo -e "  ${GREEN}Platform:${NC} macOS Apple Silicon"
    echo ""
    echo -e "  ${BOLD}Choose transcription backend:${NC}"
    echo -e "    ${CYAN}1)${NC} mlx-whisper  — fast, uses Apple GPU (recommended)"
    echo -e "    ${CYAN}2)${NC} transcribe-rs — Rust/whisper.cpp, CPU-based"
    echo ""
    printf "  Choice [1]: "
    read -r BACKEND_CHOICE </dev/tty 2>/dev/null || BACKEND_CHOICE=""
    case "$BACKEND_CHOICE" in
        2) BACKEND="transcribe-rs" ;;
        *) BACKEND="mlx-whisper" ;;
    esac
    echo -e "  ${GREEN}Backend:${NC}  $BACKEND"
else
    if [[ "$OS" == "Darwin" ]]; then
        echo -e "  ${GREEN}Platform:${NC} macOS Intel"
    else
        echo -e "  ${GREEN}Platform:${NC} $OS ($ARCH)"
    fi
    echo -e "  ${GREEN}Backend:${NC}  transcribe-rs"
fi
echo ""

VESKTOP_DATA=""
DISCORD_APP=""

# ── Helper: detect Vesktop data directory ─────────────────────────

detect_vesktop() {
    if [[ "$OS" == "Darwin" ]]; then
        for d in "$HOME/Library/Application Support/vesktop" "$HOME/Library/Application Support/Vesktop"; do
            [[ -d "$d" ]] && VESKTOP_DATA="$d" && return 0
        done
    elif [[ "$OS" == "Linux" ]]; then
        local xdg="${XDG_CONFIG_HOME:-$HOME/.config}"
        for d in "$xdg/vesktop" "$xdg/Vesktop"; do
            [[ -d "$d" ]] && VESKTOP_DATA="$d" && return 0
        done
    fi
    return 1
}

# ── Helper: configure Vesktop to use a custom Vencord build ──────

configure_vesktop() {
    local dist_dir="$1"

    [[ -z "$VESKTOP_DATA" ]] && return 1

    echo -e "  ${GREEN}Vesktop detected:${NC} $VESKTOP_DATA"

    # Try state.json first (newer Vesktop), fall back to settings.json
    local target_file=""
    if [[ -f "$VESKTOP_DATA/state.json" ]]; then
        target_file="$VESKTOP_DATA/state.json"
    elif [[ -f "$VESKTOP_DATA/settings.json" ]]; then
        target_file="$VESKTOP_DATA/settings.json"
    else
        # No config file exists yet -- create state.json
        echo '{}' > "$VESKTOP_DATA/state.json"
        target_file="$VESKTOP_DATA/state.json"
    fi

    # Use python3 for reliable JSON manipulation
    if command -v python3 &> /dev/null; then
        python3 -c "
import json, sys
path, dist = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data['vencordDir'] = dist
with open(path, 'w') as f:
    json.dump(data, f, indent=4)
    f.write('\n')
" "$target_file" "$dist_dir"
        echo -e "  ${GREEN}Vesktop configured:${NC} vencordDir → $dist_dir"
        return 0
    else
        echo -e "  ${YELLOW}python3 not found -- set Vencord location manually in Vesktop:${NC}"
        echo "    Settings > Developer Options > Vencord Location → $dist_dir"
        return 1
    fi
}

# ── Helper: check if Discord Desktop has Vencord injected ────────

check_discord_desktop() {
    # Check if Discord Desktop is installed
    if [[ "$OS" == "Darwin" ]]; then
        for app in "/Applications/Discord.app" "/Applications/Discord Canary.app" "$HOME/Applications/Discord.app"; do
            if [[ -d "$app" ]]; then
                DISCORD_APP="$app"
                echo ""
                echo -e "  ${CYAN}Discord Desktop detected:${NC} $app"
                break
            fi
        done
    elif [[ "$OS" == "Linux" ]]; then
        if command -v discord &> /dev/null; then
            DISCORD_APP="discord"
            echo ""
            echo -e "  ${CYAN}Discord Desktop detected.${NC}"
        fi
    fi
}

# ── Find Vencord source ──────────────────────────────────────────

if [[ -z "$VENCORD_DIR" ]]; then
    # Search common locations (Vencord, Equicord, and common dev dirs)
    for dir in \
        "$HOME/Vencord" \
        "$HOME/VencordDev" \
        "$HOME/vencord" \
        "$HOME/Equicord" \
        "$HOME/equicord" \
        "$HOME/.local/share/Vencord" \
        "$HOME/Documents/Vencord" \
        "$HOME/Projects/Vencord" \
        "$HOME/Dev/Vencord" \
        "$HOME/dev/Vencord" \
        "$HOME/Code/Vencord" \
        "$HOME/code/Vencord" \
        "$HOME/src/Vencord"; do
        if [[ -d "$dir/src/userplugins" ]]; then
            VENCORD_DIR="$dir"
            break
        fi
    done

    # Wildcard search in home directory
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
    echo -e "  ${GREEN}Vencord source:${NC} $VENCORD_DIR"
else
    echo -e "  ${YELLOW}No Vencord source tree found.${NC}"
    echo ""

    # Check prerequisites for cloning
    if ! command -v git &> /dev/null; then
        echo -e "${RED}  Error: git is required. Install git and try again.${NC}"
        exit 1
    fi

    if ! command -v node &> /dev/null; then
        echo -e "${RED}  Error: Node.js is required to build Vencord.${NC}"
        echo ""
        if [[ "$OS" == "Darwin" ]]; then
            echo "  Install it: brew install node"
        elif [[ "$OS" == "Linux" ]]; then
            echo "  Install it: https://nodejs.org or use your package manager"
        fi
        exit 1
    fi

    # Install pnpm if needed
    if ! command -v pnpm &> /dev/null; then
        echo "  Installing pnpm..."
        if command -v corepack &> /dev/null; then
            corepack enable 2>/dev/null || true
            corepack prepare pnpm@latest --activate 2>/dev/null || npm install -g pnpm
        else
            npm install -g pnpm
        fi
    fi

    if ! command -v pnpm &> /dev/null; then
        echo -e "${RED}  Error: Failed to install pnpm.${NC}"
        exit 1
    fi

    # Clone Vencord
    VENCORD_DIR="$HOME/Vencord"
    echo -e "  ${BOLD}Cloning Vencord to $VENCORD_DIR...${NC}"
    git clone --depth 1 --quiet "https://github.com/Vendicated/Vencord.git" "$VENCORD_DIR"

    echo "  Installing Vencord dependencies..."
    cd "$VENCORD_DIR"
    pnpm install --frozen-lockfile 2>&1 | tail -3

    mkdir -p "$VENCORD_DIR/src/userplugins"
    echo -e "  ${GREEN}Vencord source:${NC} $VENCORD_DIR"
fi

DEST="$VENCORD_DIR/src/userplugins/vocord"
echo ""

# ── Clean up existing installation if present ─────────────────────

if [[ -d "$DEST" ]]; then
    echo -e "  ${YELLOW}Existing Vocord installation detected. Removing...${NC}"
    rm -rf "$DEST"
    echo -e "  ${GREEN}Old plugin files removed${NC}"
fi

if [[ -d "$VOCORD_DATA/venv" ]]; then
    echo -e "  ${YELLOW}Existing venv detected. Removing...${NC}"
    rm -rf "$VOCORD_DATA/venv"
    echo -e "  ${GREEN}Old venv removed${NC}"
fi

echo ""

# ── Step 1: Clone Vocord repo ────────────────────────────────────

echo -e "${BOLD}[1/4]${NC} Downloading Vocord..."
git clone --depth 1 --quiet "$REPO" "$TMPDIR_VOCORD/vocord"
echo -e "  ${GREEN}Done${NC}"

# ── Step 2: Install backend ──────────────────────────────────────

echo ""

if [[ "$BACKEND" == "mlx-whisper" ]]; then
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
    uv venv "$VOCORD_VENV" --quiet --allow-existing
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
    MODEL_PATH="$VOCORD_DATA/ggml-medium-q4_1.bin"

    if [[ ! -f "$MODEL_PATH" ]]; then
        echo "  Downloading Whisper model (~500 MB)..."
        mkdir -p "$VOCORD_DATA"
        curl -L --progress-bar -o "$MODEL_PATH" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q4_1.bin"
        echo -e "  ${GREEN}Model saved to: $MODEL_PATH${NC}"
    else
        echo -e "  Model already at: $MODEL_PATH"
    fi
fi

# ── Close Vesktop before making any changes ───────────────────────

detect_vesktop

if [[ -n "$VESKTOP_DATA" ]]; then
    echo ""
    echo -e "${YELLOW}Closing Vesktop to apply changes...${NC}"
    if [[ "$OS" == "Darwin" ]]; then
        osascript -e 'quit app "Vesktop"' 2>/dev/null || pkill -ix vesktop 2>/dev/null || true
    else
        pkill -ix vesktop 2>/dev/null || true
    fi
    sleep 2
fi

# ── Step 3: Install plugin ────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/4]${NC} Installing plugin..."

mkdir -p "$DEST"

cp "$TMPDIR_VOCORD/vocord/index.tsx" "$DEST/"
cp "$TMPDIR_VOCORD/vocord/native.ts" "$DEST/"

# Copy transcribe-cli with built binary if applicable
if [[ "$BACKEND" == "transcribe-rs" ]]; then
    cp -r "$TMPDIR_VOCORD/vocord/transcribe-cli" "$DEST/"
fi

echo -e "  ${GREEN}Installed to: $DEST${NC}"

# ── Step 4: Build and configure ───────────────────────────────────

echo ""
echo -e "${BOLD}[4/4]${NC} Building Vencord..."

cd "$VENCORD_DIR"
if command -v pnpm &> /dev/null; then
    if pnpm build 2>&1 | tail -5; then
        # Verify the plugin is actually in the build output
        if grep -q "Vocord" "$VENCORD_DIR/dist/renderer.js" 2>/dev/null; then
            echo -e "  ${GREEN}Build complete (Vocord verified in output)${NC}"
        else
            echo -e "${RED}  Build succeeded but Vocord not found in output!${NC}"
            echo -e "${RED}  Check that $DEST/index.tsx exists and retry: cd $VENCORD_DIR && pnpm build${NC}"
            exit 1
        fi
    else
        echo -e "${RED}  Build failed! Retry manually: cd $VENCORD_DIR && pnpm build${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}  pnpm not found -- rebuild manually: cd $VENCORD_DIR && pnpm build${NC}"
fi

# Auto-configure Vesktop if detected
echo ""
configure_vesktop "$VENCORD_DIR/dist" || true

# Check for Discord Desktop and inject if detected and not using Vesktop
check_discord_desktop
[[ -z "$VESKTOP_DATA" && -n "$DISCORD_APP" ]] && {
    echo -e "  ${GREEN}Injecting Vencord into Discord Desktop...${NC}"
    if ! (cd "$VENCORD_DIR" && pnpm inject 2>&1 | tail -5); then
        echo -e "${YELLOW}  Warning: Vencord injection failed. Try manually: cd $VENCORD_DIR && pnpm inject${NC}"
    fi
}

# ── Done ──────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}  Vocord installed successfully!${NC}"
echo ""

# Restart Vesktop if detected
if [[ -n "$VESKTOP_DATA" ]]; then
    echo -e "  ${GREEN}Restarting Vesktop...${NC}"
    if [[ "$OS" == "Darwin" ]]; then
        open -a "$(ls -d /Applications/[Vv]esktop.app 2>/dev/null | head -1)" 2>/dev/null || open -a Vesktop 2>/dev/null || true
    elif [[ "$OS" == "Linux" ]]; then
        vesktop &>/dev/null &
    fi
    echo ""
fi

echo "  Next steps:"
echo "    1. Enable: Settings > Vencord > Plugins > Vocord"

if [[ "$BACKEND" == "transcribe-rs" && -f "$MODEL_PATH" ]]; then
    echo "    2. Set GGML model path in plugin settings:"
    echo "       $MODEL_PATH"
fi

echo ""
