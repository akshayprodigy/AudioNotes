"""Turn one of your own recordings into a benchmark fixture.

    python3 -m eval.corpus.build_local ~/Downloads/meeting.mp4 --id real-acme-2026-08-19

Extracts the audio to the 16 kHz mono PCM16 the core expects (any container ffmpeg can open,
video included) and writes the fixture metadata. Ground truth comes afterwards, from
`truth_draft`: run the pipeline, correct what it heard, import it.

Fixtures whose id starts with `real-` are gitignored in full — audio, transcript and minutes.
Your meetings are the most valuable benchmark there is and the one thing that must never leave
the machine, so the privacy is structural rather than a habit anyone has to remember.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "eval", "fixtures")

CAVEAT = ("A real recording, held locally and never committed. This is the validity set: AMI "
          "tells you whether a change regressed, THIS tells you whether the product works for "
          "the people who will actually use it.")

MINUTES_TEMPLATE = {
    "_how": [
        "The minutes a good human note-taker would have written for this meeting. Write them",
        "from the MEETING, not from our output — a template pre-filled with what AudioNotes",
        "produced would only measure how well it agrees with itself, and every miss it made",
        "would be missing from the yardstick too.",
        "Then rename this file to minutes.json.",
    ],
    "decisions": [],
    "actions": [{"text": "", "owner": "", "due": ""}],
    "questions": [],
}


def extract_audio(src, dest):
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found — brew install ffmpeg")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src,
                    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", dest],
                   check=True)


def duration_ms(wav_path):
    """Milliseconds of PCM16 mono 16 kHz payload, from the file size less the WAV header."""
    return int((os.path.getsize(wav_path) - 44) / 2 / 16000 * 1000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media", help="any audio or video file ffmpeg can read")
    ap.add_argument("--id", help="fixture id (default: real-<filename>)")
    ap.add_argument("--note", default="", help="anything worth knowing: room, mic, accents")
    args = ap.parse_args()

    if not os.path.exists(args.media):
        raise SystemExit(f"no such file: {args.media}")
    fixture_id = args.id or "real-" + os.path.splitext(os.path.basename(args.media))[0]
    if not fixture_id.startswith("real-"):
        print(f"note: '{fixture_id}' does not start with 'real-', so it is NOT gitignored.",
              file=sys.stderr)
    fixture_dir = os.path.join(FIXTURES, fixture_id)
    os.makedirs(fixture_dir, exist_ok=True)

    wav = os.path.join(fixture_dir, "audio.wav")
    extract_audio(args.media, wav)
    ms = duration_ms(wav)

    with open(os.path.join(fixture_dir, "meta.json"), "w") as f:
        json.dump({"source": "local", "meeting": fixture_id, "speakers": [],
                   "licence": "private", "audio_ms": ms,
                   "notes": (args.note + " " if args.note else "") + CAVEAT}, f, indent=1)

    todo = os.path.join(fixture_dir, "minutes.todo.json")
    if not os.path.exists(todo) and not os.path.exists(os.path.join(fixture_dir, "minutes.json")):
        with open(todo, "w") as f:
            json.dump(MINUTES_TEMPLATE, f, indent=1)

    print(f"{fixture_id}: {ms / 1000:.0f}s of audio -> {fixture_dir}")
    print("next: run the CLI over it, then")
    print(f"  python3 -m eval.corpus.truth_draft export {fixture_id} <cli.json>")


if __name__ == "__main__":
    main()
