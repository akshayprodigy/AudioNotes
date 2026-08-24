"""Render a run's results as markdown.

Every report repeats the corpus caveat. A number without its provenance invites being quoted as
"our WER is X", which for a proxy corpus would be misleading.
"""


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def render(results):
    lines = ["# Eval run", "", f"- run id: `{results['run_id']}`",
             f"- cli: `{results['cli']}`", ""]

    lines += ["## Accuracy", "",
              "| fixture | source | audio | WER | S | D | I | DER | attrib |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        w, d = r["wer"], r["der"]
        lines.append(
            f"| {r['id']} | {r['source']} | {r['audio_ms'] / 1000:.0f}s | "
            f"{w['wer'] * 100:.1f}% | {w['substitutions']} | {w['deletions']} | {w['insertions']} | "
            f"{d['der'] * 100:.1f}% | {_pct(r['attribution']['accuracy'])} |")

    total_err = sum(r["wer"]["errors"] for r in results["fixtures"])
    total_ref = sum(r["wer"]["ref_words"] for r in results["fixtures"])
    overall_wer = (total_err / total_ref) if total_ref else 0.0

    der_num = sum(r["der"]["missed_ms"] + r["der"]["false_alarm_ms"] + r["der"]["confusion_ms"]
                  for r in results["fixtures"])
    der_den = sum(r["der"]["scored_ref_ms"] for r in results["fixtures"])
    overall_der = (der_num / der_den) if der_den else 0.0

    lines += ["",
              f"**Overall WER: {overall_wer * 100:.1f}%** "
              f"({total_err} errors over {total_ref} reference words)  ",
              f"**Overall DER: {overall_der * 100:.1f}%** "
              f"(over {der_den / 1000:.0f}s of scored reference speech)", ""]

    lines += ["## Diarization detail", "",
              "| fixture | missed | false alarm | confusion | scored | overlap (excluded) |",
              "|---|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        d = r["der"]
        lines.append(f"| {r['id']} | {d['missed_ms'] / 1000:.0f}s | "
                     f"{d['false_alarm_ms'] / 1000:.0f}s | {d['confusion_ms'] / 1000:.0f}s | "
                     f"{d['scored_ref_ms'] / 1000:.0f}s | {d['overlap_ms'] / 1000:.0f}s |")

    lines += ["", "## Performance", "",
              "| fixture | vad | asr | diarize | minutes | total | peak RSS |",
              "|---|---:|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        rt = r["realtime"]
        rss = f"{r['peak_rss_mb']:.0f} MB" if r.get("peak_rss_mb") else "n/a"
        lines.append(f"| {r['id']} | {rt.get('vad_xrt', 0):.3f}x | {rt.get('asr_xrt', 0):.3f}x | "
                     f"{rt.get('diar_xrt', 0):.3f}x | {rt.get('minutes_xrt', 0):.3f}x | "
                     f"**{rt.get('total_xrt', 0):.3f}x** | {rss} |")
    lines += ["", "_×realtime: processing time / audio duration. Lower is faster._", ""]

    caveats = sorted({r["notes"] for r in results["fixtures"] if r.get("notes")})
    if caveats:
        lines += ["## Corpus caveats", ""] + [f"- {c}" for c in caveats] + [""]
    return "\n".join(lines)
