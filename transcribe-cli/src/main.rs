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

    /// Language code for transcription (e.g. "en", "es", "fr"). Auto-detected if omitted.
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
    let model_params = WhisperModelParams { use_gpu: true };

    let mut engine = WhisperEngine::new();
    engine.load_model_with_params(&args.model, model_params)?;

    let inference_params = WhisperInferenceParams {
        language: args.language,
        ..Default::default()
    };

    let result = engine.transcribe_file(&args.audio, Some(inference_params))?;
    Ok(result.text)
}

fn main() {
    let args = Args::parse();

    match run(args) {
        Ok(text) => {
            let output = SuccessOutput { text };
            println!("{}", serde_json::to_string(&output).unwrap());
        }
        Err(e) => {
            let output = ErrorOutput {
                error: e.to_string(),
            };
            eprintln!("{}", serde_json::to_string(&output).unwrap());
            process::exit(1);
        }
    }
}
