# Vocord - Windows installer
# Usage: irm https://raw.githubusercontent.com/jolehuit/vocord/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Vocord" -ForegroundColor Cyan
Write-Host "  Cross-platform voice message transcription for Vencord" -ForegroundColor Cyan
Write-Host "  https://github.com/jolehuit/vocord" -ForegroundColor Cyan
Write-Host ""

$Arch = $env:PROCESSOR_ARCHITECTURE
Write-Host "  Platform: Windows ($Arch)" -ForegroundColor Green
Write-Host "  Backend:  transcribe-rs" -ForegroundColor Green
Write-Host ""

$VocordData = "$env:LOCALAPPDATA\vocord"
$TmpDir = Join-Path $env:TEMP "vocord-install-$(Get-Random)"

# ── Helper: configure Vesktop ────────────────────────────────────

function Configure-Vesktop {
    param([string]$DistDir)

    $VesktopData = "$env:APPDATA\vesktop"
    if (-not (Test-Path $VesktopData)) {
        # Also check capitalized
        $VesktopData = "$env:APPDATA\Vesktop"
    }
    if (-not (Test-Path $VesktopData)) { return $false }

    Write-Host "  Vesktop detected: $VesktopData" -ForegroundColor Green

    # Try state.json first (newer), then settings.json (older)
    $TargetFile = $null
    if (Test-Path "$VesktopData\state.json") {
        $TargetFile = "$VesktopData\state.json"
    } elseif (Test-Path "$VesktopData\settings.json") {
        $TargetFile = "$VesktopData\settings.json"
    } else {
        '{}' | Out-File -FilePath "$VesktopData\state.json" -Encoding utf8
        $TargetFile = "$VesktopData\state.json"
    }

    $Json = Get-Content $TargetFile -Raw | ConvertFrom-Json
    $Json | Add-Member -NotePropertyName "vencordDir" -NotePropertyValue $DistDir -Force
    $Json | ConvertTo-Json -Depth 10 | Out-File -FilePath $TargetFile -Encoding utf8
    Write-Host "  Vesktop configured: vencordDir -> $DistDir" -ForegroundColor Green
    return $true
}

try {

# ── Find Vencord source ──────────────────────────────────────────

$VencordDir = $env:VENCORD_DIR
$ClonedVencord = $false

if (-not $VencordDir) {
    $SearchDirs = @(
        "$env:USERPROFILE\Vencord",
        "$env:USERPROFILE\VencordDev",
        "$env:USERPROFILE\vencord",
        "$env:USERPROFILE\Equicord",
        "$env:USERPROFILE\equicord",
        "$env:USERPROFILE\Documents\Vencord",
        "$env:USERPROFILE\Projects\Vencord",
        "$env:USERPROFILE\Dev\Vencord",
        "$env:USERPROFILE\dev\Vencord",
        "$env:USERPROFILE\Code\Vencord",
        "$env:USERPROFILE\code\Vencord",
        "$env:USERPROFILE\src\Vencord",
        "C:\Vencord",
        "D:\Vencord"
    )

    foreach ($Dir in $SearchDirs) {
        if (Test-Path "$Dir\src\userplugins") {
            $VencordDir = $Dir
            break
        }
    }

    # Wildcard search in home directory
    if (-not $VencordDir) {
        $Matches = Get-ChildItem -Path $env:USERPROFILE -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path "$($_.FullName)\src\userplugins" } |
            Select-Object -First 1
        if ($Matches) {
            $VencordDir = $Matches.FullName
        }
    }
}

if ($VencordDir -and (Test-Path "$VencordDir\src\userplugins")) {
    Write-Host "  Vencord source: $VencordDir" -ForegroundColor Green
} else {
    Write-Host "  No Vencord source tree found." -ForegroundColor Yellow
    Write-Host ""

    # Check prerequisites
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "  Error: git is required. Install git and try again." -ForegroundColor Red
        Write-Host "  https://git-scm.com/download/win" -ForegroundColor Yellow
        exit 1
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "  Error: Node.js is required to build Vencord." -ForegroundColor Red
        Write-Host "  Install it: winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
        exit 1
    }

    # Install pnpm if needed
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host "  Installing pnpm..."
        if (Get-Command corepack -ErrorAction SilentlyContinue) {
            corepack enable 2>$null
            corepack prepare pnpm@latest --activate 2>$null
        }
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
            npm install -g pnpm
        }
    }

    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host "  Error: Failed to install pnpm." -ForegroundColor Red
        exit 1
    }

    # Clone Vencord
    $VencordDir = "$env:USERPROFILE\Vencord"
    Write-Host "  Cloning Vencord to $VencordDir..."
    git clone --depth 1 --quiet "https://github.com/Vendicated/Vencord.git" $VencordDir

    Write-Host "  Installing Vencord dependencies..."
    Push-Location $VencordDir
    pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 3
    Pop-Location

    New-Item -ItemType Directory -Path "$VencordDir\src\userplugins" -Force | Out-Null
    $ClonedVencord = $true
    Write-Host "  Vencord source: $VencordDir" -ForegroundColor Green
}

$Dest = "$VencordDir\src\userplugins\vocord"
Write-Host ""

# ── Step 1: Clone Vocord ─────────────────────────────────────────

Write-Host "[1/4] Downloading Vocord..."
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
git clone --depth 1 --quiet "https://github.com/jolehuit/vocord.git" "$TmpDir\vocord"
Write-Host "  Done" -ForegroundColor Green

# ── Step 2: Install backend (always transcribe-rs on Windows) ────

Write-Host ""
Write-Host "[2/4] Setting up transcribe-rs..."

# Check Rust
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "  Rust not found. Installing via rustup..." -ForegroundColor Yellow
    $RustupInit = "$TmpDir\rustup-init.exe"
    Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $RustupInit
    & $RustupInit -y --quiet
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
}
$CargoVersion = (cargo --version) -replace 'cargo ', ''
Write-Host "  Rust $CargoVersion"

# Check ffmpeg
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "  Warning: ffmpeg not found." -ForegroundColor Yellow
    Write-Host "  Install it: winget install ffmpeg"
    Write-Host "  Or: scoop install ffmpeg"
} else {
    Write-Host "  ffmpeg found"
}

# Build transcribe-cli
Write-Host "  Building transcribe-cli (this may take a few minutes)..."
Push-Location "$TmpDir\vocord\transcribe-cli"
cargo build --release --quiet 2>&1
Pop-Location

if (Test-Path "$TmpDir\vocord\transcribe-cli\target\release\transcribe-cli.exe") {
    Write-Host "  transcribe-cli built" -ForegroundColor Green
} else {
    Write-Host "  Error: Build failed" -ForegroundColor Red
    exit 1
}

# Download model
$ModelPath = "$VocordData\ggml-medium-q4_1.bin"

if (-not (Test-Path $ModelPath)) {
    Write-Host "  Downloading Whisper model (~500 MB)..."
    New-Item -ItemType Directory -Path $VocordData -Force | Out-Null
    Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q4_1.bin" -OutFile $ModelPath
    Write-Host "  Model saved to: $ModelPath" -ForegroundColor Green
} else {
    Write-Host "  Model already at: $ModelPath"
}

# ── Step 3: Install plugin ────────────────────────────────────────

Write-Host ""
Write-Host "[3/4] Installing plugin..."

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Path $Dest -Force | Out-Null

Copy-Item "$TmpDir\vocord\index.tsx" $Dest
Copy-Item "$TmpDir\vocord\native.ts" $Dest
Copy-Item "$TmpDir\vocord\transcribe-cli" $Dest -Recurse

Write-Host "  Installed to: $Dest" -ForegroundColor Green

# ── Step 4: Build and configure ───────────────────────────────────

Write-Host ""
Write-Host "[4/4] Building Vencord..."

Push-Location $VencordDir
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm build 2>&1 | Select-Object -Last 3
    Write-Host "  Build complete" -ForegroundColor Green
} else {
    Write-Host "  pnpm not found -- rebuild manually: cd $VencordDir; pnpm build" -ForegroundColor Yellow
}
Pop-Location

# Auto-configure Vesktop
Write-Host ""
Configure-Vesktop -DistDir "$VencordDir\dist" | Out-Null

# ── Done ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Vocord installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Restart Discord / Vesktop"
Write-Host "    2. Enable: Settings > Vencord > Plugins > Vocord"
Write-Host "    3. Set GGML model path in plugin settings:"
Write-Host "       $ModelPath"
Write-Host ""

} finally {
    # ── Cleanup ───────────────────────────────────────────────────────
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
