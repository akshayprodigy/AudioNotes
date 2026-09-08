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
from eval.metrics.judge import BatchedJudge, local_runner
from eval import report

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cli, models, fixture_dir, out_json, llm_model=None, asr="ggml-base-q5_1.bin",
            asr_engine=None, qwen3_model=None, sherpa_model=None, language=None,
            diar_window_min=None, diar_speaker_threshold=None, live_cache=False):
    """Invoke the shared core. Returns (document, peak_rss_bytes).

    Diarization models are passed when present, so DER is scored whenever the models exist and the
    run degrades to transcript-only when they do not, rather than failing.

    `asr` names the whisper weights inside `models`. It is a parameter and not a constant because
    whisper-small is what the Pro tier claims to add, and a claim nobody has measured is not a
    feature — it is a promise. Defaults to base, which is what the free tier ships.

    `llm_model` turns on narration, which is the configuration that ships. Without it the harness
    scores rule-based minutes only — which was silently the case until 2026-08-26, so the numbers
    described a configuration the phone does not run. Note what this does and does not buy: the
    recall/invented metrics score ITEMS, and narration no longer writes items, so they measure the
    rule extractor either way. What changes is that the run exercises the real code path and the
    prose lands in the result document where a future prose metric can reach it.
    """
    cmd = [cli,
           os.path.join(models, asr),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(models, "silero_vad.onnx")]
    # Engine selection is EXPLICIT here rather than left to the language policy: a benchmark that
    # quietly measured a different engine than the one named would be worse than a failed run.
    if asr_engine:
        cmd += ["--asr-engine", asr_engine]
    if qwen3_model:
        cmd += ["--qwen3-model", qwen3_model]
    if sherpa_model:
        cmd += ["--sherpa-model", sherpa_model]
    if language:
        cmd += ["--language", language]
    # How much speech diarization holds at once, which is what stops a long meeting needing memory
    # in proportion to its length. Passed explicitly — including the negative value that turns
    # windowing off — so the before-and-after is a flag rather than a rebuild.
    # Decode every window up front and run the pipeline from that cache, the way the Android live
    # capture pass does. The transcript must come out IDENTICAL to a cold run, not merely close:
    # if it does not, the cache is not the pure function the whole design rests on.
    if live_cache:
        cmd += ["--live-cache"]
    if diar_window_min is not None:
        cmd += ["--diar-window-min", str(diar_window_min)]
    # The cross-window speaker merge distance. Separate from --diar-threshold and separately swept:
    # the first clusters per-segment embeddings inside a window, this one compares per-speaker
    # averages, and averaging shortens every distance it takes part in.
    if diar_speaker_threshold is not None:
        cmd += ["--diar-speaker-threshold", str(diar_speaker_threshold)]
    seg = os.path.join(models, "diar_segmentation.onnx")
    emb = os.path.join(models, "diar_embedding.onnx")
    if os.path.exists(seg) and os.path.exists(emb):
        cmd += ["--diar-seg", seg, "--diar-emb", emb]
    if llm_model:
        cmd += ["--llm", llm_model]
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


def script_histogram(text):
    """Which writing systems a transcript actually came back in.

    The 2026-08-19 recording returned FIVE scripts including Korean and Chinese, and nobody knew
    until they read it. A per-fixture percentage turns that into a number a run can be judged on:
    a Hindi meeting that is 8% CJK is a failure however good its WER looks.

    This is also how the Qwen language hint gets judged rather than assumed. No CJK output filter
    ships, deliberately — a threshold guessed before the evidence exists can silently delete real
    speech. This is the evidence.
    """
    counts = {"latin": 0, "devanagari": 0, "arabic": 0, "cjk": 0, "other": 0}
    for ch in text:
        if not ch.isalpha():
            continue
        cp = ord(ch)
        if cp < 0x0250:
            counts["latin"] += 1
        elif 0x0900 <= cp <= 0x097F:
            counts["devanagari"] += 1
        elif 0x0600 <= cp <= 0x06FF:
            counts["arabic"] += 1
        elif (0x4E00 <= cp <= 0x9FFF or 0x3040 <= cp <= 0x30FF or 0xAC00 <= cp <= 0xD7AF):
            counts["cjk"] += 1
        else:
            counts["other"] += 1
    total = sum(counts.values()) or 1
    return {k: round(100.0 * v / total, 1) for k, v in counts.items()}


def _within(segments, lo, hi):
    """Segments whose midpoint falls in [lo, hi). Midpoint rather than overlap so a segment
    straddling the boundary lands on exactly one side, and on the same side for reference and
    hypothesis alike.

    Either bound may be None, meaning unbounded on that side. This used to require both: a fixture
    that set only `scored_from_ms` reached `lo <= mid < None` and died with a TypeError. Nothing
    caught it because every fixture that had ever used the field set both ends — the EdAcc ones
    are the first to need "everything after the read-aloud passage" with no upper limit.
    """
    if lo is None and hi is None:
        return segments
    low = float("-inf") if lo is None else lo
    high = float("inf") if hi is None else hi
    return [s for s in segments if low <= (s["start_ms"] + s["end_ms"]) / 2 < high]


def score(fixture_dir, doc, peak_rss=0, judge=None):
    with open(os.path.join(fixture_dir, "truth.json")) as f:
        truth = json.load(f)
    with open(os.path.join(fixture_dir, "meta.json")) as f:
        meta = json.load(f)

    # A reference may cover only the span someone corrected. Both sides get clipped to it —
    # scoring a partial reference against the whole transcript would turn every uncorrected
    # minute into insertions and read as a catastrophic regression.
    lo = truth.get("scored_from_ms")
    hi = truth.get("scored_to_ms")
    ref_segments = _within(truth["segments"], lo, hi)
    hyp_utterances = _within(doc.get("transcript", []), lo, hi)

    # Whole-meeting WER: concatenate in time order on both sides. Segment-level alignment would
    # need the hypothesis split to match the reference split, which it never does.
    ref_tokens = []
    for seg in sorted(ref_segments, key=lambda s: s["start_ms"]):
        ref_tokens.extend(normalize(seg["text"]))
    hyp_tokens = []
    for utt in sorted(hyp_utterances, key=lambda u: u["start_ms"]):
        hyp_tokens.extend(normalize(utt["text"]))

    d = der(ref_segments, hyp_utterances)
    attribution = utterance_attribution(ref_segments, hyp_utterances, d.mapping)

    # Minutes quality, when a judge is configured and the fixture carries reference minutes.
    mom = None
    minutes_path = os.path.join(fixture_dir, "minutes.json")
    if judge is not None and os.path.exists(minutes_path):
        with open(minutes_path) as f:
            reference_minutes = json.load(f)
        transcript_text = " ".join(s["text"] for s in
                                   sorted(ref_segments, key=lambda s: s["start_ms"]))
        # Our own transcript too: it is what separates "ASR misheard this" from "the minutes
        # layer made it up", which look identical in a support verdict.
        ours = " ".join(u["text"] for u in sorted(hyp_utterances, key=lambda u: u["start_ms"]))
        mom = judge.score(reference_minutes, doc, transcript_text, ours)

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
        # What script the model actually answered in, alongside how accurate it was. A transcript
        # can score well on WER and still be unreadable to its owner.
        "scripts": script_histogram(" ".join(u.get("text", "") for u in hyp_utterances)),
        "timings": timings,
        "realtime": realtime,
        "peak_rss_mb": round(peak_rss / 1048576, 1) if peak_rss else None,
        "utterances": len(doc.get("transcript", [])),
        # Carried into the report so a partial-reference number is never read as whole-meeting.
        "scored_span_ms": [lo, hi] if lo is not None else None,
        "mom": mom,
    }


def rescore(run_dir, fixtures, out_dir, run_id, judge=None, results_judge=None):
    """Score the documents a previous run saved, without running the core again.

    Stage timings live in the document, so xrealtime survives; peak RSS was measured around the
    process and does not, so it reports n/a rather than carrying a stale number forward."""
    results = {"run_id": run_id, "cli": f"rescored from {run_dir}", "judge": results_judge,
               "fixtures": []}
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
        r = score(fixture_dir, doc, judge=judge)
        results["fixtures"].append(r)
        print(f"  {fid}: WER {r['wer']['wer'] * 100:.1f}%  DER {r['der']['der'] * 100:.1f}%")
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results, _calibration(out_dir))
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


def _calibration(run_dir):
    """A previous `eval.calibrate import` for this run, if one happened."""
    path = os.path.join(run_dir, "calibration.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--fixtures", default=os.path.join(ROOT, "eval", "fixtures"))
    ap.add_argument("--only", help="run a single fixture id")
    ap.add_argument("--asr", default="ggml-base-q5_1.bin", metavar="FILE",
                    help="whisper weights inside --models (e.g. ggml-small-q5_1.bin)")
    ap.add_argument("--asr-engine", metavar="NAME",
                    choices=["whisper", "qwen3", "parakeet", "moonshine"],
                    help="force an engine instead of letting the language policy choose")
    ap.add_argument("--sherpa-model", metavar="DIR",
                    help="a sherpa-onnx export of Parakeet-TDT or Moonshine, used with "
                         "--asr-engine parakeet|moonshine (e.g. "
                         "eval/models/parakeet-tdt-0.6b-v2-int8)")
    ap.add_argument("--qwen3-model", metavar="DIR",
                    help="directory holding conv_frontend.onnx, encoder.onnx, decoder.onnx, "
                         "tokenizer/ (e.g. eval/models/qwen3-asr)")
    ap.add_argument("--live-cache", action="store_true",
                    help="pre-decode every window and run from that cache, as the Android live "
                         "capture pass does; the transcript must be identical to a cold run")
    ap.add_argument("--language", metavar="CODE",
                    help="language to pin the transcriber to (default: the core's own, 'en')")
    ap.add_argument("--llm", metavar="GGUF",
                    help="the SHIPPED model (eval/models/qwen-instruct-q4_k_m.gguf) — turns on "
                         "narration so the run matches what the phone does")
    ap.add_argument("--judge", metavar="BINARY", help="cpp/cli/build/audionotes_judge")
    ap.add_argument("--judge-model", metavar="GGUF", help="a stronger GGUF than the shipped 1.5B")
    ap.add_argument("--rescore", metavar="RUN_DIR",
                    help="re-score the saved <fixture>.cli.json documents in RUN_DIR instead of "
                         "running the core again. A metric fix should not cost an hour of "
                         "inference, and re-running would also change the thing being measured.")
    ap.add_argument("--diar-window-min", type=float, default=None,
                    help="minutes of speech to diarize at once (0 = the shipped default, negative "
                         "= no windowing). This is the knob the memory bound rests on, so the "
                         "A/B against un-windowed diarization is a flag and not a rebuild.")
    ap.add_argument("--diar-speaker-threshold", type=float, default=None,
                    help="cross-window speaker merge distance (0 = the shipped default). Only "
                         "consulted for a meeting long enough to need more than one window.")
    args = ap.parse_args()

    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(ROOT, "eval", "results", run_id)
    os.makedirs(out_dir, exist_ok=True)

    judge = None
    if args.judge and args.judge_model:
        judge = BatchedJudge(local_runner(args.judge, args.judge_model))
        results_judge = {"binary": args.judge, "model": os.path.basename(args.judge_model)}
    else:
        results_judge = None

    if args.rescore:
        return rescore(args.rescore, args.fixtures, out_dir, run_id, judge, results_judge)

    ids = sorted(d for d in os.listdir(args.fixtures)
                 if os.path.isdir(os.path.join(args.fixtures, d)))
    if args.only:
        ids = [i for i in ids if i == args.only]
    if not ids:
        raise SystemExit("no fixtures found — run: python3 -m eval.corpus.build_fixture ES2002a")

    results = {"run_id": run_id, "cli": args.cli, "asr": args.asr,
               "asr_engine": args.asr_engine, "qwen3_model": args.qwen3_model,
               "sherpa_model": args.sherpa_model,
               "language": args.language,
               "live_cache": args.live_cache,
               "diar_window_min": args.diar_window_min,
               "diar_speaker_threshold": args.diar_speaker_threshold,
               "judge": results_judge, "fixtures": []}
    for fid in ids:
        fixture_dir = os.path.join(args.fixtures, fid)
        if not os.path.exists(os.path.join(fixture_dir, "audio.wav")):
            print(f"skip {fid}: audio.wav missing (gitignored; rebuild the fixture)")
            continue
        # Symmetric with the audio check above, and it was not. A fixture whose reference has not
        # been written yet took the whole run down with a FileNotFoundError AFTER every other
        # fixture had been transcribed — so the report was never printed and an hour of inference
        # was thrown away over a file nobody was scoring anyway.
        if not os.path.exists(os.path.join(fixture_dir, "truth.json")):
            print(f"skip {fid}: truth.json missing (no reference to score against yet)")
            continue
        print(f"running {fid} …")
        doc, peak_rss = run_cli(args.cli, args.models, fixture_dir,
                                os.path.join(out_dir, f"{fid}.cli.json"),
                                llm_model=args.llm, asr=args.asr,
                                asr_engine=args.asr_engine, qwen3_model=args.qwen3_model,
                                sherpa_model=args.sherpa_model,
                                language=args.language,
                                live_cache=args.live_cache,
                                diar_window_min=args.diar_window_min,
                                diar_speaker_threshold=args.diar_speaker_threshold)
        r = score(fixture_dir, doc, peak_rss, judge=judge)
        results["fixtures"].append(r)
        acc = r["attribution"]["accuracy"]
        print(f"  WER {r['wer']['wer'] * 100:.1f}%  "
              f"DER {r['der']['der'] * 100:.1f}%  "
              f"attrib {('%.1f%%' % (acc * 100)) if acc is not None else 'n/a'}  "
              f"{r['realtime']['total_xrt']:.2f}x realtime")

    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results, _calibration(out_dir))
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


if __name__ == "__main__":
    main()
