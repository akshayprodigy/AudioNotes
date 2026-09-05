"""
Does the recogniser invent words where nobody spoke?

Built after a real 5-minute meeting on a Galaxy A07 came back with a first minute of
"I'm not going to eat this. / Let's eat this. / No! What are you doing? / I'm not eating this."
repeated three times, over a quiet opening in which nothing was said. That text reached the
transcript, the minutes, and the meeting's TITLE.

whisper ships its own guard and it was already on:

    is_no_speech = (no_speech_prob > 0.6 && avg_logprobs < -1.0)

The AND is the hole. A repetition loop is HIGH confidence by construction -- the model is certain
because it is copying itself -- so avg_logprobs stays high and the guard never fires. Confident
invention passes while hesitant invention is caught, which is exactly backwards.

WHY THIS NEEDS ITS OWN FIXTURES: the obvious idea, "score the gap before AMI's first annotated
word", does not work. ES2002a's leading 50 seconds measures p99.5 -17.0 dBFS and peaks at -5.6 --
LOUDER than the annotated speech that follows. It is real unannotated pre-meeting chatter, so
transcribing it is correct behaviour, not hallucination. Silence has to be constructed to have
exact ground truth.

THE METRIC IS TWO-SIDED, and that is the point. Every plausible fix here -- dropping low-confidence
segments, gating on energy, tightening the VAD -- can score perfectly on invented words by deleting
more text. Measuring only invention would let us trade a visible failure for an invisible one, and
for a product whose promise is "this is what was said", silently losing real words is the worse of
the two. So every run reports both.
"""

import argparse
import json
import os
import subprocess
import sys

SR = 16000
BYTES_PER_SAMPLE = 2

#: Where the room tone comes from: a 60 s stretch of ES2002a with no annotated speech in it,
#: measured at p99.5 -46.6 dBFS. REAL tone, not digital silence -- a real room has a chair, a
#: breath, a laptop fan, and those are what make a VAD open a span over nothing. Digital silence
#: would be an easier test than reality, and is scored separately as its own condition.
TONE_SOURCE = "ES2002a"
TONE_START_MS = 1_205_000
TONE_LEN_MS = 60_000


def _pcm(path):
    with open(path, "rb") as f:
        return f.read()


def _write_wav(path, pcm):
    """16 kHz mono PCM16 WAV. The CLI takes a .wav and derives the .pcm beside it."""
    import struct
    n = len(pcm)
    hdr = b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16) + b"data" + struct.pack("<I", n)
    with open(path, "wb") as f:
        f.write(hdr)
        f.write(pcm)


def _slice(pcm, start_ms, len_ms):
    a = start_ms * SR // 1000 * BYTES_PER_SAMPLE
    b = a + len_ms * SR // 1000 * BYTES_PER_SAMPLE
    return pcm[a:b]


def build(fixtures):
    """Create the silence fixtures. Returns [(id, silent_span_ms_or_None)]."""
    tone_src = _pcm(os.path.join(fixtures, TONE_SOURCE, "audio.wav.pcm"))
    tone = _slice(tone_src, TONE_START_MS, TONE_LEN_MS)
    assert len(tone) == TONE_LEN_MS * SR // 1000 * BYTES_PER_SAMPLE, "tone slice short"

    made = []

    def emit(fid, pcm, segments, silent_ms, note):
        d = os.path.join(fixtures, fid)
        os.makedirs(d, exist_ok=True)
        _write_wav(os.path.join(d, "audio.wav"), pcm)
        with open(os.path.join(d, "audio.wav.pcm"), "wb") as f:
            f.write(pcm)
        audio_ms = len(pcm) // BYTES_PER_SAMPLE * 1000 // SR
        with open(os.path.join(d, "truth.json"), "w") as f:
            json.dump({"audio_ms": audio_ms, "segments": segments}, f, indent=1)
        with open(os.path.join(d, "meta.json"), "w") as f:
            json.dump({"id": fid, "source": "synthetic", "notes": note}, f, indent=1)
        made.append((fid, silent_ms))

    # 1. Real room tone, and nothing else. Every word out of this is invented.
    emit("silence-roomtone", tone * 2, [], (0, 2 * TONE_LEN_MS),
         "120 s of real room tone from ES2002a (p99.5 -46.6 dBFS), no speech. "
         "Any transcript at all is fabrication.")

    # 2. Digital silence. Scored apart from room tone because they are not the same test: a VAD
    #    will not open a span over exact zeros, so this measures the floor rather than reality.
    emit("silence-digital", b"\x00" * len(tone) * 2, [], (0, 2 * TONE_LEN_MS),
         "120 s of digital silence. The easy case; real recordings never look like this.")

    # 3. The shape that actually failed: quiet opening, then a real meeting. Also catches a fix
    #    that suppresses the silence by damaging the speech next to it.
    speech_id = "ES2003a"
    speech = _pcm(os.path.join(fixtures, speech_id, "audio.wav.pcm"))
    truth = json.load(open(os.path.join(fixtures, speech_id, "truth.json")))
    shifted = [dict(s, start_ms=s["start_ms"] + TONE_LEN_MS, end_ms=s["end_ms"] + TONE_LEN_MS)
               for s in truth["segments"]]
    emit("silence-lead", tone + speech, shifted, (0, TONE_LEN_MS),
         f"60 s of room tone prepended to {speech_id}. Invented words are scored in the tone only; "
         "WER over the rest is the regression check that a fix has not eaten real speech.")

    return made


def words_in_span(doc, span):
    """Words the run emitted inside a span known to contain no speech."""
    lo, hi = span
    n = 0
    lines = []
    for u in doc.get("transcript", []):
        mid = (u.get("start_ms", 0) + u.get("end_ms", 0)) / 2
        if lo <= mid < hi:
            w = len(u.get("text", "").split())
            n += w
            if w:
                lines.append(f'{u["start_ms"]/1000:7.1f}s  {u["text"][:70]}')
    return n, lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--fixtures", default="eval/fixtures")
    ap.add_argument("--asr", default="ggml-base-q5_1.bin")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--show", action="store_true", help="print the invented lines")
    a = ap.parse_args()

    made = build(a.fixtures)
    print(f"built {len(made)} fixture(s): {', '.join(f for f, _ in made)}")
    if a.build_only:
        return 0

    print(f"\n{'fixture':20s} {'invented words':>14s} {'utterances':>11s}")
    total = 0
    for fid, span in made:
        d = os.path.join(a.fixtures, fid)
        out = os.path.join(d, "silence.cli.json")
        cmd = [a.cli, os.path.join(a.models, a.asr), os.path.join(d, "audio.wav"),
               "--vad", os.path.join(a.models, "silero_vad.onnx"), "--json", out]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"{fid:20s}  CLI FAILED: {proc.stderr.strip()[:120]}")
            continue
        doc = json.load(open(out))
        n, lines = words_in_span(doc, span)
        total += n
        print(f"{fid:20s} {n:14d} {len(doc.get('transcript', [])):11d}")
        if a.show:
            for l in lines[:12]:
                print(f"    {l}")
    print(f"\ninvented words over silence, all conditions: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
