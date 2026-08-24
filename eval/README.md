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
| DER | **18.3%** — was 48.8% before the diarization threshold fix |
| attribution | **73.8-95.8%** per meeting — was 25-62% |
| speed | 0.06-0.09x realtime on desktop |

Published whisper-base on AMI headset audio sits around 20-30%, so WER is the right
neighbourhood. Anything near 100% means the CLI failed and produced no transcript.

Deletions are the largest error bucket (2035 of 4220), and it is NOT VAD dropping speech —
measured, only 0.5% of reference words fall in audio the pipeline produced no transcript for at
all. Whisper is under-transcribing audio it did read. Some of that is structural: ~15% of AMI
speech time is two people at once, and one mono transcript cannot hold both.

DER was 48.8% until the diarization merge threshold moved from sherpa's default 0.5 to 1.0:
auto-clustering had been returning 28-101 clusters for 4-speaker meetings. Confusion time fell
from 1190s to 132s while missed and false alarm did not move at all. Validated on two held-out
meetings; `--diar-threshold` sweeps it.

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
