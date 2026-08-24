"""Render a run's results as markdown.

Every report repeats the corpus caveat. A number without its provenance invites being quoted as
"our WER is X", which for a proxy corpus would be misleading.
"""


def render(results):
    lines = ["# Eval run", "", f"- run id: `{results['run_id']}`",
             f"- cli: `{results['cli']}`", ""]

    lines += ["## Summary", "",
              "| fixture | source | audio | WER | S | D | I | ref words |",
              "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        w = r["wer"]
        lines.append(
            f"| {r['id']} | {r['source']} | {r['audio_ms'] / 1000:.0f}s | "
            f"{w['wer'] * 100:.1f}% | {w['substitutions']} | {w['deletions']} | "
            f"{w['insertions']} | {w['ref_words']} |")

    total_err = sum(r["wer"]["errors"] for r in results["fixtures"])
    total_ref = sum(r["wer"]["ref_words"] for r in results["fixtures"])
    overall = (total_err / total_ref) if total_ref else 0.0
    lines += ["", f"**Overall WER: {overall * 100:.1f}%** "
                  f"({total_err} errors over {total_ref} reference words)", ""]

    caveats = sorted({r["notes"] for r in results["fixtures"] if r.get("notes")})
    if caveats:
        lines += ["## Corpus caveats", ""] + [f"- {c}" for c in caveats] + [""]
    return "\n".join(lines)
