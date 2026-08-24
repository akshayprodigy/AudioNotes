"""Run the core over every fixture and score it.

    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models <dir>

`--models` holds ggml-base-q5_1.bin and silero_vad.onnx (the same files ModelCatalog.kt downloads
on Android).
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

from eval.metrics.wer import wer_tokens
from eval.metrics.normalize import normalize
from eval import report

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cli, models, fixture_dir, out_json):
    """Invoke the shared core. Returns the parsed --json document."""
    cmd = [cli,
           os.path.join(models, "ggml-base-q5_1.bin"),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(models, "silero_vad.onnx"),
           "--json", out_json]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_json):
        sys.stderr.write(proc.stderr[-2000:] + "\n")
        raise SystemExit(f"CLI failed for {fixture_dir} (exit {proc.returncode})")
    with open(out_json) as f:
        return json.load(f)


def score(fixture_dir, doc):
    with open(os.path.join(fixture_dir, "truth.json")) as f:
        truth = json.load(f)
    with open(os.path.join(fixture_dir, "meta.json")) as f:
        meta = json.load(f)

    # Whole-meeting WER: concatenate in time order on both sides. Segment-level alignment would
    # need the hypothesis split to match the reference split, which it never does.
    ref_tokens = []
    for seg in sorted(truth["segments"], key=lambda s: s["start_ms"]):
        ref_tokens.extend(normalize(seg["text"]))
    hyp_tokens = []
    for utt in sorted(doc.get("transcript", []), key=lambda u: u["start_ms"]):
        hyp_tokens.extend(normalize(utt["text"]))

    return {
        "id": os.path.basename(fixture_dir.rstrip("/")),
        "source": meta.get("source", "unknown"),
        "notes": meta.get("notes", ""),
        "audio_ms": truth["audio_ms"],
        "wer": wer_tokens(ref_tokens, hyp_tokens).as_dict(),
        "timings": doc.get("timings", {}),
        "utterances": len(doc.get("transcript", [])),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--fixtures", default=os.path.join(ROOT, "eval", "fixtures"))
    ap.add_argument("--only", help="run a single fixture id")
    args = ap.parse_args()

    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(ROOT, "eval", "results", run_id)
    os.makedirs(out_dir, exist_ok=True)

    ids = sorted(d for d in os.listdir(args.fixtures)
                 if os.path.isdir(os.path.join(args.fixtures, d)))
    if args.only:
        ids = [i for i in ids if i == args.only]
    if not ids:
        raise SystemExit("no fixtures found — run: python3 -m eval.corpus.build_fixture ES2002a")

    results = {"run_id": run_id, "cli": args.cli, "fixtures": []}
    for fid in ids:
        fixture_dir = os.path.join(args.fixtures, fid)
        if not os.path.exists(os.path.join(fixture_dir, "audio.wav")):
            print(f"skip {fid}: audio.wav missing (gitignored; rebuild the fixture)")
            continue
        print(f"running {fid} …")
        doc = run_cli(args.cli, args.models, fixture_dir,
                      os.path.join(out_dir, f"{fid}.cli.json"))
        r = score(fixture_dir, doc)
        results["fixtures"].append(r)
        print(f"  WER {r['wer']['wer'] * 100:.1f}%  "
              f"({r['wer']['errors']}/{r['wer']['ref_words']} words)")

    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results)
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


if __name__ == "__main__":
    main()
