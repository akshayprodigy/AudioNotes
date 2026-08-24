"""Turn a pipeline run into a transcript a human can correct, and back into ground truth.

Typing a reference transcript from scratch costs hours per meeting. Correcting ours costs
minutes. The trade is not free and the draft says so in its own header: a plausible-sounding
mistranscription that the corrector reads past stays in the reference and then scores as
*correct* forever after, so a WER measured this way is a lower bound — optimistic by however
much the corrector missed. Two things push back on that, and both live in the format: gap
markers point at the silences where we transcribed nothing (deletions are invisible otherwise,
and they are our largest error bucket), and the instructions ask for listening rather than
reading.

    python3 -m eval.corpus.truth_draft export <fixture-id> <cli.json>
    # ... edit eval/fixtures/<id>/truth.draft.txt ...
    python3 -m eval.corpus.truth_draft import <fixture-id>
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "eval", "fixtures")

# [start -> end] Speaker: text     (-> or the arrow glyph; speaker may not contain a colon)
LINE = re.compile(r"^\[\s*([^\s\]]+)\s*(?:->|→)\s*([^\s\]]+)\s*\]\s*([^:]*?)\s*:\s?(.*)$")
GAP_MS = 2000


def parse_timestamp(text):
    """`HH:MM:SS.mmm`, `MM:SS.mmm`, or plain seconds -> integer milliseconds.

    String arithmetic on the fractional part, not float: `3.120 * 1000` is 3119.9999 in binary
    floating point, and a reference transcript that drifts a millisecond per line would quietly
    smear the diarization scoring.
    """
    parts = str(text).strip().split(":")
    if len(parts) > 3:
        raise ValueError(f"not a timestamp: {text!r}")
    whole, _, frac = parts[-1].partition(".")
    ms = int(frac.ljust(3, "0")[:3]) if frac else 0
    seconds = int(whole or 0)
    for i, p in enumerate(reversed(parts[:-1]), start=1):
        seconds += int(p) * (60 ** i)
    return seconds * 1000 + ms


def format_timestamp(ms):
    ms = int(ms)
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


HEADER = """\
# Ground-truth transcript for `{fixture}` — correct this file, then run:
#     python3 -m eval.corpus.truth_draft import {fixture}
#
# This is what AudioNotes HEARD, not what was said. Fix it and it becomes the yardstick every
# accuracy number is measured against.
#
# HOW TO CORRECT
#   * Play the audio and follow along. Do not just read — a wrong word that reads plausibly is
#     exactly the kind we need caught, and it is invisible on the page.
#   * Fix the words. Write what was actually said, including "um" and false starts; the scorer
#     strips disfluencies from both sides, so they cost you nothing.
#   * Fix the speaker. Replace S0/S1/... with real names, spelled the same way every time.
#     The label is what matters, not the number we guessed.
#   * Blank the text after the colon to delete a line we invented (noise scored as speech).
#   * ADD lines for speech we missed — see the gap markers below. New lines can go at the end
#     of the file; they get sorted by time on import. Rough timings are fine.
#   * Lines starting with # are ignored, so leave yourself notes.
#
# Format:  [start -> end] Speaker: text        (timestamps are HH:MM:SS.mmm)
#
# audio_ms: {audio_ms}
# STATUS: UNCORRECTED — delete this line when you are done. Import refuses while it is here,
# because a reference imported straight from this file would BE the transcript it is meant to
# grade: near-0% WER, and the product would look perfect.
"""


def render_draft(doc, fixture_id, gap_ms=GAP_MS):
    utts = sorted(doc.get("transcript", []), key=lambda u: u["start_ms"])
    audio_ms = doc.get("audio_ms") or (utts[-1]["end_ms"] if utts else 0)
    out = [HEADER.format(fixture=fixture_id, audio_ms=audio_ms)]

    def gap(prev_end, next_start):
        if next_start - prev_end >= gap_ms:
            out.append(f"# ---- {(next_start - prev_end) / 1000:.1f}s with no detected speech "
                       f"({format_timestamp(prev_end)} -> {format_timestamp(next_start)}) — "
                       f"add anything said here ----")

    cursor = 0
    for u in utts:
        gap(cursor, u["start_ms"])
        text = " ".join(str(u.get("text", "")).split())
        out.append(f"[{format_timestamp(u['start_ms'])} -> {format_timestamp(u['end_ms'])}] "
                   f"S{u.get('speaker')}: {text}")
        cursor = max(cursor, u["end_ms"])
    gap(cursor, audio_ms)
    return "\n".join(out) + "\n"


def parse_draft(text):
    """-> {"audio_ms", "segments": [{start_ms,end_ms,speaker,text}], "dropped": N}.

    Raises ValueError naming the line number for anything it cannot read, rather than skipping
    it: a typo'd bracket that silently dropped a line would turn real speech into permanent
    insertions in every future score.
    """
    audio_ms = None
    segments = []
    dropped = 0
    if "UNCORRECTED" in text:
        raise ValueError(
            "this draft still carries its STATUS: UNCORRECTED line.\n"
            "  Correct the transcript against the audio, then delete that line.\n"
            "  Importing it as-is would make the reference a copy of the transcript being "
            "graded — near-0% WER, and every real error invisible.")
    for n, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            m = re.match(r"#\s*audio_ms\s*:\s*(\d+)", line)
            if m:
                audio_ms = int(m.group(1))
            continue
        m = LINE.match(line)
        if not m:
            raise ValueError(f"line {n}: cannot read {raw!r}\n"
                             f"  expected: [start -> end] Speaker: text")
        start_text, end_text, speaker, body = m.groups()
        try:
            start_ms, end_ms = parse_timestamp(start_text), parse_timestamp(end_text)
        except ValueError as exc:
            raise ValueError(f"line {n}: {exc}") from None
        if end_ms < start_ms:
            raise ValueError(f"line {n}: ends ({end_text}) before it starts ({start_text})")
        body = " ".join(body.split())
        if not body:
            dropped += 1
            continue
        segments.append({"start_ms": start_ms, "end_ms": end_ms,
                         "speaker": speaker.strip(), "text": body})
    segments.sort(key=lambda s: (s["start_ms"], s["end_ms"]))
    if audio_ms is None:
        audio_ms = max((s["end_ms"] for s in segments), default=0)
    return {"audio_ms": audio_ms, "segments": segments, "dropped": dropped}


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    cmd, fixture_id = argv[1], argv[2]
    fixture_dir = os.path.join(FIXTURES, fixture_id)
    draft_path = os.path.join(fixture_dir, "truth.draft.txt")

    if cmd == "export":
        if len(argv) < 4:
            raise SystemExit("usage: export <fixture-id> <cli.json>")
        with open(argv[3]) as f:
            doc = json.load(f)
        with open(draft_path, "w") as f:
            f.write(render_draft(doc, fixture_id))
        n = len(doc.get("transcript", []))
        print(f"wrote {draft_path}\n  {n} utterances to check — correct it, then: "
              f"python3 -m eval.corpus.truth_draft import {fixture_id}")
    elif cmd == "import":
        with open(draft_path) as f:
            try:
                parsed = parse_draft(f.read())
            except ValueError as exc:
                # A traceback here is noise: every one of these is a message for the person
                # holding the file, not a bug in the parser.
                raise SystemExit(f"{draft_path}\n{exc}") from None
        truth = {"audio_ms": parsed["audio_ms"], "segments": parsed["segments"]}
        out = os.path.join(fixture_dir, "truth.json")
        with open(out, "w") as f:
            json.dump(truth, f, indent=1)
        speakers = sorted({s["speaker"] for s in parsed["segments"]})
        words = sum(len(s["text"].split()) for s in parsed["segments"])
        print(f"wrote {out}\n  {len(parsed['segments'])} segments, {words} words, "
              f"{len(speakers)} speakers: {', '.join(speakers)}")
        if parsed["dropped"]:
            print(f"  {parsed['dropped']} line(s) dropped as blank")
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
