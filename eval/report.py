"""Render a run's results as markdown.

Every report repeats the corpus caveat. A number without its provenance invites being quoted as
"our WER is X", which for a proxy corpus would be misleading.
"""


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def render(results, calibration=None):
    lines = ["# Eval run", "", f"- run id: `{results['run_id']}`",
             f"- cli: `{results['cli']}`"]
    if results.get("judge"):
        lines.append(f"- judge: `{results['judge']['model']}`")
    lines.append("")

    lines += ["## Accuracy", "",
              "| fixture | source | audio | WER | S | D | I | DER | attrib |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        w, d = r["wer"], r["der"]
        lines.append(
            f"| {r['id']}{'*' if r.get('scored_span_ms') else ''} | {r['source']} | "
            f"{r['audio_ms'] / 1000:.0f}s | "
            f"{w['wer'] * 100:.1f}% | {w['substitutions']} | {w['deletions']} | {w['insertions']} | "
            f"{d['der'] * 100:.1f}% | {_pct(r['attribution']['accuracy'])} |")

    partial = [r for r in results["fixtures"] if r.get("scored_span_ms")]
    if partial:
        lines.append("")
        for r in partial:
            lo, hi = r["scored_span_ms"]
            lines.append(f"\\* `{r['id']}` is scored over {lo / 1000:.0f}-{hi / 1000:.0f}s only "
                         f"({(hi - lo) / 1000:.0f}s of {r['audio_ms'] / 1000:.0f}s), the span its "
                         f"reference covers. Not comparable with a whole-meeting number.")

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

    lines += _mom_section(results, calibration)

    caveats = sorted({r["notes"] for r in results["fixtures"] if r.get("notes")})
    if caveats:
        lines += ["## Corpus caveats", ""] + [f"- {c}" for c in caveats] + [""]
    return "\n".join(lines)


def _mom_section(results, calibration):
    """Minutes quality, with the judge's own trustworthiness stated before its numbers.

    The order is deliberate. An uncalibrated judge's recall figure printed as a percentage is
    indistinguishable on the page from a measured one, so the caveat goes above the table rather
    than in a footnote under it.
    """
    scored = [r for r in results["fixtures"] if r.get("mom")]
    if not scored:
        return []
    out = ["## Minutes quality", ""]

    if calibration is None:
        out += ["> **The judge has not been calibrated.** Nobody has checked these verdicts "
                "against a human, so treat every number below as provisional: "
                "`python3 -m eval.calibrate export <run-dir>`.", ""]
    elif not calibration["trustworthy"]:
        out += [f"> **These numbers are noise.** The judge agreed with the human on only "
                f"{calibration['rate'] * 100:.0f}% of {calibration['total']} hand-labelled items, "
                f"below the {calibration['threshold'] * 100:.0f}% gate. Reported for the record, "
                f"not to be acted on — fix the judge (prompt or model) and re-run.", ""]
    else:
        out += [f"_Judge calibrated: {calibration['rate'] * 100:.0f}% agreement with a human over "
                f"{calibration['total']} hand-labelled items._", ""]

    out += ["| fixture | decisions | actions | questions | overall recall | invented |",
            "|---|---:|---:|---:|---:|---:|"]
    for r in scored:
        m = r["mom"]
        rec = m["recall"]
        invented = sum(m["hallucinated"].values()) if m["hallucinated"] else None
        out.append(f"| {r['id']} | {_pct(rec['decisions'])} | {_pct(rec['actions'])} | "
                   f"{_pct(rec['questions'])} | **{_pct(rec['overall'])}** | "
                   f"{'n/a' if invented is None else invented} |")
    out.append("")
    out.append("_Recall: reference items our minutes captured, judged semantically — the "
               "reference is abstractive and our minutes quote the meeting, so they rarely share "
               "wording. `n/a` means the reference had no items of that kind, which is not the "
               "same as scoring zero._")

    owner = {"correct": sum(r["mom"]["owner"]["correct"] for r in scored),
             "checked": sum(r["mom"]["owner"]["checked"] for r in scored)}
    due = {"correct": sum(r["mom"]["due"]["correct"] for r in scored),
           "checked": sum(r["mom"]["due"]["checked"] for r in scored)}
    if owner["checked"] or due["checked"]:
        out += ["", f"Owner correct on {owner['correct']}/{owner['checked']} matched action items; "
                    f"due date on {due['correct']}/{due['checked']}."]
    notes = [n for r in scored for n in (r["mom"].get("notes") or [])]
    for n in sorted(set(notes)):
        out.append(f"- {n}")
    out.append("")
    return out
