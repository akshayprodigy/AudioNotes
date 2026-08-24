# eval/ — accuracy harness

Dev tooling. Never shipped, never linked into the app.

Runs the shared core over benchmark meetings and scores transcript / attribution / minutes /
speed. Design: `docs/superpowers/specs/2026-08-24-phase1b-eval-harness-design.md`.

## Run

    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models <dir>

## Tests

    python3 -m unittest discover -s eval/tests -v

## Fixture format

One directory per meeting under `eval/fixtures/<meeting-id>/`:

| file | contents |
|---|---|
| `audio.wav` | 16 kHz mono PCM16 |
| `truth.json` | `{"audio_ms": N, "segments": [{"start_ms","end_ms","speaker","text"}]}` |
| `minutes.json` | `{"decisions": [...], "actions": [{"text","owner","due"}], "questions": [...]}` |
| `meta.json` | `{"source","licence","notes"}` |

`speaker` is an opaque label. Nothing downstream knows which corpus a fixture came from — that is
what lets your own recordings become a benchmark by writing these four files.

## Baseline

whisper-base (`ggml-base-q5_1.bin`), VAD on, ES2002a (AMI), 2026-08-24:

| metric | value |
|---|---|
| WER | **30.8%** |
| substitutions / deletions / insertions | 329 / 304 / 159 |
| reference words | 2572 |

Published whisper-base on AMI headset audio sits around 20-30%, so this is the right
neighbourhood. A run far above it usually means VAD dropped speech before ASR saw it — the
deletion count is the tell. Anything near 100% means the CLI failed and produced no transcript.

Models live in `eval/models/` (gitignored). Fetch them with:

    mkdir -p eval/models && cd eval/models
    curl -sLO https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
    curl -sL -o ggml-base-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
