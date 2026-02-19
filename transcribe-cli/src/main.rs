use std::io::Write;
use std::path::PathBuf;
use std::process;

use clap::Parser;
use serde::Serialize;
use transcribe_rs::{
    engines::whisper::{WhisperEngine, WhisperInferenceParams, WhisperModelParams},
    TranscriptionEngine,
};

#[derive(Parser)]
#[command(name = "transcribe-cli", about = "Transcribe audio files using Whisper")]
struct Args {
    /// Path to the WAV audio file (16kHz, 16-bit, mono)
    #[arg(long)]
    audio: PathBuf,

    /// Path to the Whisper GGML model file
    #[arg(long)]
    model: PathBuf,
}

#[derive(Serialize)]
struct SuccessOutput {
    text: String,
}

#[derive(Serialize)]
struct ErrorOutput {
    error: String,
}

fn run(args: Args) -> Result<String, Box<dyn std::error::Error>> {
    // Validate paths upfront to produce actionable error messages before
    // handing them off to the engine, which may emit opaque C-level errors.
    if !args.model.exists() {
        return Err(format!(
            "Model file not found: {}",
            args.model.display()
        )
        .into());
    }
    if !args.audio.exists() {
        return Err(format!(
            "Audio file not found: {}",
            args.audio.display()
        )
        .into());
    }

    let mut engine = WhisperEngine::new();
    engine.load_model_with_params(&args.model, WhisperModelParams { use_gpu: true })?;

    let result = engine.transcribe_file(&args.audio, Some(WhisperInferenceParams::default()))?;
    Ok(result.text)
}

fn main() {
    let args = Args::parse();

    match run(args) {
        Ok(text) => {
            let output = SuccessOutput { text };
            println!(
                "{}",
                serde_json::to_string(&output).expect("failed to serialize output")
            );
        }
        Err(e) => {
            let output = ErrorOutput {
                error: e.to_string(),
            };
            let json = serde_json::to_string(&output).expect("failed to serialize error");
            // Flush stderr explicitly before process::exit so the output is
            // not lost on platforms that buffer stderr.
            let _ = writeln!(std::io::stderr(), "{}", json);
            let _ = std::io::stderr().flush();
            process::exit(1);
        }
    }
}
