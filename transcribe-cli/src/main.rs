use std::path::PathBuf;
use std::process;

use clap::Parser;
use serde::Serialize;
use transcribe_rs::engines::parakeet::{ParakeetEngine, ParakeetModelParams};
use transcribe_rs::TranscriptionEngine;

#[derive(Parser)]
#[command(name = "transcribe-cli", about = "Transcribe audio files using Parakeet")]
struct Args {
    /// Path to the WAV audio file (16kHz, 16-bit, mono)
    #[arg(long)]
    audio: PathBuf,

    /// Path to the Parakeet model directory
    #[arg(long)]
    model: PathBuf,

    /// Language code (unused, Parakeet auto-detects)
    #[arg(long)]
    language: Option<String>,
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
    let mut engine = ParakeetEngine::new();
    engine.load_model_with_params(&args.model, ParakeetModelParams::int8())?;

    let result = engine.transcribe_file(&args.audio, None)?;
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
            eprintln!(
                "{}",
                serde_json::to_string(&output).expect("failed to serialize error")
            );
            process::exit(1);
        }
    }
}
