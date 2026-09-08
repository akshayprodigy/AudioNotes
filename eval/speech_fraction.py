"""How much of a real meeting is speech — which is the ceiling on what skipping silence can save.

    python3 -m eval.speech_fraction eval/results/<run-id> [...]

Diarizing the VAD spans instead of the whole recording was built as a memory fix. This script is
what showed that it is not one. It reads the VAD spans the core already wrote into each run's
`<fixture>.cli.json`, pads them the way `cpp/diar/span_map.h` does, and reports the fraction of the
recording that survives.

The answer on AMI is 66-89%, so the saving is 11-34%: a constant factor on a cost that still grows
with the length of the meeting. A three-hour meeting fails with the spans exactly as it did without
them, just later. Bounding the memory takes windowing; this number is the reason.
"""
import argparse
import glob
import json
import os
import sys

# Must match kDiarPadMs in cpp/diar/span_map.h. A number that drifts from the code it describes
# measures nothing, so it is asserted against the header rather than copied and hoped for.
PAD_MS = 500
HEADER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "cpp", "diar", "span_map.h")


def pad_ms_from_header(path=HEADER):
    """Read kDiarPadMs out of the C++ header so this script cannot silently describe the wrong build."""
    try:
        with open(path) as f:
            for line in f:
                if "kDiarPadMs" in line and "=" in line:
                    return int(line.split("=")[1].split(";")[0].strip())
    except OSError:
        pass
    return None


def pad_and_merge(spans, pad_ms, total_ms):
    """The Python twin of padAndMerge(). Touching spans count as overlapping, as they do there."""
    grown = []
    for s in spans:
        start, end = s["start_ms"], s["end_ms"]
        if end <= start:
            continue
        grown.append((max(0, start - pad_ms), min(total_ms, end + pad_ms) if total_ms else end + pad_ms))
    grown.sort()
    merged = []
    for start, end in grown:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_dirs", nargs="+", help="eval/results/<run-id> directories")
    ap.add_argument("--pad-ms", type=int, default=None,
                    help="padding either side of each span; defaults to kDiarPadMs from the header")
    args = ap.parse_args(argv)

    pad = args.pad_ms if args.pad_ms is not None else pad_ms_from_header()
    if pad is None:
        print("could not read kDiarPadMs from %s; pass --pad-ms" % HEADER, file=sys.stderr)
        return 2
    print("padding %d ms either side\n" % pad)

    rows = []
    for run_dir in args.run_dirs:
        for path in sorted(glob.glob(os.path.join(run_dir, "*.cli.json"))):
            with open(path) as f:
                doc = json.load(f)
            total_ms = doc.get("audio_ms", 0)
            spans = doc.get("segments", [])
            if not total_ms or not spans:
                continue
            merged = pad_and_merge(spans, pad, total_ms)
            kept = sum(e - s for s, e in merged)
            rows.append((os.path.basename(path).replace(".cli.json", ""),
                         total_ms, kept, len(spans), len(merged)))

    if not rows:
        print("no .cli.json documents with VAD spans found", file=sys.stderr)
        return 1

    print("%-14s %8s %10s %9s %9s %8s" % ("fixture", "minutes", "coverage", "saving", "spans", "merged"))
    for name, total_ms, kept, n_spans, n_merged in rows:
        print("%-14s %8.1f %9.1f%% %8.1f%% %9d %8d" % (
            name, total_ms / 60000, 100 * kept / total_ms, 100 * (1 - kept / total_ms),
            n_spans, n_merged))

    worst = min(100 * (1 - k / t) for _, t, k, _, _ in rows)
    best = max(100 * (1 - k / t) for _, t, k, _, _ in rows)
    print("\nskipping the silence saves %.1f-%.1f%%. It is a constant factor, not a bound:" % (worst, best))
    print("the buffer still grows with the meeting, so a long enough meeting still fails.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
