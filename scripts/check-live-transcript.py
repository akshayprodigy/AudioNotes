#!/usr/bin/env python3
"""The live pass is a CACHE. It must never write the pipeline's own rows.

The whole safety argument rests on this. Because the live pass only pre-computes decodes that the
post-hoc pipeline is free to ignore, a slow phone, a thermal backoff or a crash mid-meeting all
degrade to the behaviour that shipped before it existed. The moment it writes utterances,
segments or speakers, a PARTIAL live pass starts to look like a COMPLETE stage to ResumePlan --
which skips it -- and the tail of the meeting is silently lost.

Nothing fails when that invariant breaks. The transcript is simply short. Hence a grep.

See docs/superpowers/specs/2026-09-07-live-transcript-design.md section 2.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIVE = ROOT / "android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt"

# Writers the live pass must not call. Reading is fine; every one of these COMMITS pipeline state.
FORBIDDEN = [
    "replaceUtterancesJson",
    "replaceSegments",
    "insertUtterances",
    "insertSegments",
    "assignSpeakers",
    "setStatus",
    "setLanguage",
    "putNote",
]


def main() -> int:
    if not LIVE.exists():
        print(f"FAIL: {LIVE.relative_to(ROOT)} is missing", file=sys.stderr)
        return 1

    src = LIVE.read_text(encoding="utf-8")
    bad = sorted(n for n in FORBIDDEN if re.search(r"\b%s\s*\(" % re.escape(n), src))
    if bad:
        print(
            "FAIL: LiveTranscriber commits pipeline state: " + ", ".join(bad) + "\n"
            "The live pass must only write asr_cache. A partial pass that writes utterances\n"
            "makes ResumePlan skip Stage.ASR and silently loses the rest of the meeting.",
            file=sys.stderr,
        )
        return 1

    # It must actually BE a cache writer, or this guard is passing on a file that does nothing.
    if "putCachedWindow" not in src:
        print("FAIL: LiveTranscriber never calls putCachedWindow", file=sys.stderr)
        return 1

    print("live transcript: cache-only invariant holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
