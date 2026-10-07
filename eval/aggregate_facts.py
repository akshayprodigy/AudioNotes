"""Merge several meetings' facts_score.json into one cohort report.

    python3 -m eval.aggregate_facts <meeting>/facts_score.json ... [--min-instances 30] [--out DIR]

The count-first rule is applied to the POOLED counts with the --min-instances given here, not to
each meeting and not to whatever each meeting was scored with: a class that is a dozen price
mentions in one meeting becomes a readable rate only when enough meetings have been added, and
that is the point of aggregating. Rows are recombined and summarised afresh, so a cohort or an
overall figure is the same arithmetic as a single meeting's. No pass/fail, no thresholds.
"""
import argparse
import json
import os
import sys

from eval.score_facts import DEFAULT_MIN_INSTANCES, render_report, summarise


def merge(docs, min_instances):
    """-> {"meetings": [...], "min_instances", "summary", "rows"}; ValueError on bad input."""
    seen = set()
    rows = []
    for d in docs:
        if not (isinstance(d, dict) and isinstance(d.get("rows"), list) and d.get("meeting_id")):
            raise ValueError("input is not a facts_score.json (needs meeting_id and rows)")
        if d["meeting_id"] in seen:
            raise ValueError(f"meeting {d['meeting_id']!r} appears twice; counting it twice "
                             f"would double every error")
        seen.add(d["meeting_id"])
        rows += d["rows"]
    return {"meetings": sorted(seen), "min_instances": min_instances,
            "summary": summarise(rows, min_instances), "rows": rows}


def render(docs, min_instances):
    merge(docs, min_instances)                    # validates
    return render_report(docs, min_instances)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python3 -m eval.aggregate_facts",
                                 description=__doc__.split("\n\n")[0])
    ap.add_argument("scores", nargs="+", help="facts_score.json files, one per meeting")
    ap.add_argument("--min-instances", type=int, default=DEFAULT_MIN_INSTANCES)
    ap.add_argument("--out", default=None, help="directory for facts_aggregate.json and "
                                               "facts_aggregate_report.md (default: print only)")
    args = ap.parse_args(argv)
    docs = []
    for p in args.scores:
        try:
            with open(p) as f:
                docs.append(json.load(f))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"cannot read {p}: {exc}") from None
    try:
        merged = merge(docs, args.min_instances)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    report = render_report(docs, args.min_instances)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "facts_aggregate.json"), "w") as f:
            json.dump(merged, f, indent=1)
        with open(os.path.join(args.out, "facts_aggregate_report.md"), "w") as f:
            f.write(report)
        print(f"wrote facts_aggregate.json and facts_aggregate_report.md in {args.out}")
    else:
        print(report)


if __name__ == "__main__":
    main(sys.argv[1:])
