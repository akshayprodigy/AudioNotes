#!/usr/bin/env python3
"""Pin the CLI's exact transcript so a refactor can prove it changed nothing.

Not a ctest: it needs 60 MB of whisper weights and a real fixture. Run it once before a refactor
with --record, then again after with no flag. Any diff is a regression.

Determinism: whisper here is greedy, and thread count comes from inferenceThreadCount(), which
reads CPU topology. That makes output reproducible ON ONE MACHINE but not necessarily across
machines — so a baseline is only meaningful compared against itself on the same hardware.
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "cpp", "cli", "build", "audionotes_cli")
MODELS = os.path.join(ROOT, "eval", "models")
BASELINE = os.path.join(ROOT, "eval", "baseline")

# Two fixtures, chosen deliberately: one clean English meeting, and the Hindi/English recording
# that started all of this. A refactor that breaks only one of them is the interesting case.
FIXTURES = ["ES2002a", "real-neosym-2026-08-19"]


def run(fixture, language):
    """Transcript only — no diarization, no LLM. Fewer moving parts is the whole point here."""
    fixture_dir = os.path.join(ROOT, "eval", "fixtures", fixture)
    out = os.path.join("/tmp", f"characterize-{fixture}.json")
    cmd = [CLI,
           os.path.join(MODELS, "ggml-base-q5_1.bin"),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(MODELS, "silero_vad.onnx"),
           "--language", language,
           "--json", out]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    with open(out) as f:
        doc = json.load(f)
    # Only the transcript. Timings are wall-clock and would differ on every run.
    return [{"start_ms": u["start_ms"], "end_ms": u["end_ms"], "text": u["text"]}
            for u in doc.get("transcript", [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", action="store_true", help="write the baseline instead of diffing")
    ap.add_argument("--language", default="en")
    args = ap.parse_args()

    os.makedirs(BASELINE, exist_ok=True)
    failures = 0
    for fx in FIXTURES:
        got = run(fx, args.language)
        path = os.path.join(BASELINE, f"{fx}.json")
        if args.record:
            with open(path, "w") as f:
                json.dump(got, f, indent=1, ensure_ascii=False)
            print(f"recorded {fx}: {len(got)} utterances")
            continue
        if not os.path.exists(path):
            print(f"NO BASELINE for {fx} — run with --record first", file=sys.stderr)
            failures += 1
            continue
        with open(path) as f:
            want = json.load(f)
        if got == want:
            print(f"OK {fx}: {len(got)} utterances identical")
        else:
            failures += 1
            print(f"DIFF {fx}: baseline {len(want)} utterances, got {len(got)}", file=sys.stderr)
            for i, (a, b) in enumerate(zip(want, got)):
                if a != b:
                    print(f"  first diff at {i}:\n    was {a}\n    now {b}", file=sys.stderr)
                    break
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
