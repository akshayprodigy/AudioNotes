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
from eval.metrics.der import der
from eval.metrics.attribution import utterance_attribution
from eval import report

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cli, models, fixture_dir, out_json):
    """Invoke the shared core. Returns (document, peak_rss_bytes).

    Diarization models are passed when present, so DER is scored whenever the models exist and the
    run degrades to transcript-only when they do not, rather than failing.
    """
    cmd = [cli,
           os.path.join(models, "ggml-base-q5_1.bin"),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(models, "silero_vad.onnx")]
    seg = os.path.join(models, "diar_segmentation.onnx")
    emb = os.path.join(models, "diar_embedding.onnx")
    if os.path.exists(seg) and os.path.exists(emb):
        cmd += ["--diar-seg", seg, "--diar-emb", emb]
    cmd += ["--json", out_json]

    # /usr/bin/time -l reports peak RSS on macOS; it goes to stderr alongside the CLI's own output.
    proc = subprocess.run(["/usr/bin/time", "-l"] + cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_json):
        sys.stderr.write(proc.stderr[-2000:] + "\n")
        raise SystemExit(f"CLI failed for {fixture_dir} (exit {proc.returncode})")
    peak_rss = 0
    for line in proc.stderr.splitlines():
        if "maximum resident set size" in line:
            peak_rss = int(line.strip().split()[0])
            break
    with open(out_json) as f:
        return json.load(f), peak_rss


def score(fixture_dir, doc, peak_rss=0):
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

    d = der(truth["segments"], doc.get("transcript", []))
    attribution = utterance_attribution(truth["segments"], doc.get("transcript", []), d.mapping)

    timings = doc.get("timings", {})
    audio_ms = truth["audio_ms"] or 1
    realtime = {k.replace("_ms", "_xrt"): round(v / audio_ms, 4)
                for k, v in timings.items()}
    realtime["total_xrt"] = round(sum(timings.values()) / audio_ms, 4)

    return {
        "id": os.path.basename(fixture_dir.rstrip("/")),
        "source": meta.get("source", "unknown"),
        "notes": meta.get("notes", ""),
        "audio_ms": truth["audio_ms"],
        "wer": wer_tokens(ref_tokens, hyp_tokens).as_dict(),
        "der": d.as_dict(),
        "attribution": attribution,
        "timings": timings,
        "realtime": realtime,
        "peak_rss_mb": round(peak_rss / 1048576, 1) if peak_rss else None,
        "utterances": len(doc.get("transcript", [])),
    }


def rescore(run_dir, fixtures, out_dir, run_id):
    """Score the documents a previous run saved, without running the core again.

    Stage timings live in the document, so xrealtime survives; peak RSS was measured around the
    process and does not, so it reports n/a rather than carrying a stale number forward."""
    results = {"run_id": run_id, "cli": f"rescored from {run_dir}", "fixtures": []}
    for name in sorted(os.listdir(run_dir)):
        if not name.endswith(".cli.json"):
            continue
        fid = name[: -len(".cli.json")]
        fixture_dir = os.path.join(fixtures, fid)
        if not os.path.exists(os.path.join(fixture_dir, "truth.json")):
            print(f"skip {fid}: no truth.json")
            continue
        with open(os.path.join(run_dir, name)) as f:
            doc = json.load(f)
        r = score(fixture_dir, doc)
        results["fixtures"].append(r)
        print(f"  {fid}: WER {r['wer']['wer'] * 100:.1f}%  DER {r['der']['der'] * 100:.1f}%")
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results)
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--fixtures", default=os.path.join(ROOT, "eval", "fixtures"))
    ap.add_argument("--only", help="run a single fixture id")
    ap.add_argument("--rescore", metavar="RUN_DIR",
                    help="re-score the saved <fixture>.cli.json documents in RUN_DIR instead of "
                         "running the core again. A metric fix should not cost an hour of "
                         "inference, and re-running would also change the thing being measured.")
    args = ap.parse_args()

    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(ROOT, "eval", "results", run_id)
    os.makedirs(out_dir, exist_ok=True)

    if args.rescore:
        return rescore(args.rescore, args.fixtures, out_dir, run_id)

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
        doc, peak_rss = run_cli(args.cli, args.models, fixture_dir,
                                os.path.join(out_dir, f"{fid}.cli.json"))
        r = score(fixture_dir, doc, peak_rss)
        results["fixtures"].append(r)
        acc = r["attribution"]["accuracy"]
        print(f"  WER {r['wer']['wer'] * 100:.1f}%  "
              f"DER {r['der']['der'] * 100:.1f}%  "
              f"attrib {('%.1f%%' % (acc * 100)) if acc is not None else 'n/a'}  "
              f"{r['realtime']['total_xrt']:.2f}x realtime")

    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results)
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


if __name__ == "__main__":
    main()
