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

Full numbers, and what the first real pass found:
`docs/superpowers/eval-baseline-whisper-base.md`.

whisper-base over 4 AMI meetings (1h47m), 2026-08-24:

| metric | value |
|---|---|
| WER | **29.7%** (4220 errors / 14220 reference words) |
| DER | **48.8%** — confusion 1190s vs missed 227s, false alarm 275s |
| attribution | 25-62% per meeting |
| speed | 0.06-0.09x realtime on desktop |

Published whisper-base on AMI headset audio sits around 20-30%, so WER is the right
neighbourhood. A run far above it usually means VAD dropped speech before ASR saw it — the
deletion count is the tell. Anything near 100% means the CLI failed and produced no transcript.

DER is NOT in the right neighbourhood: auto-clustering returns 28-101 clusters for meetings with
4 speakers. Forcing `--speakers 4` moves attribution from 52.9% to 80.1% on ES2003a, so the
embeddings are fine and the merge threshold is wrong. `--diar-threshold` exists to sweep it.

## Your own recordings

AMI tells you whether a change regressed. Your own meetings tell you whether the product works.
The first one added found a crash and a language failure that AMI cannot express — see the
baseline doc.

    python3 -m eval.corpus.build_local ~/Downloads/meeting.mp4 --id real-acme-2026-08-19
    cpp/cli/build/audionotes_cli eval/models/ggml-base-q5_1.bin \
      eval/fixtures/real-acme-2026-08-19/audio.wav --vad eval/models/silero_vad.onnx \
      --json /tmp/run.json
    python3 -m eval.corpus.truth_draft export real-acme-2026-08-19 /tmp/run.json
    # correct eval/fixtures/real-acme-2026-08-19/truth.draft.txt, then
    python3 -m eval.corpus.truth_draft import real-acme-2026-08-19

Fixtures named `real-*` are gitignored in full — audio, transcript and minutes. Correcting our
transcript instead of typing one makes the resulting WER a lower bound, since a plausible
mistranscription read past stays in the reference; the draft header says so and the gap markers
push against it.

Models live in `eval/models/` (gitignored). Fetch them with:

    mkdir -p eval/models && cd eval/models
    curl -sLO https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
    curl -sL -o ggml-base-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
