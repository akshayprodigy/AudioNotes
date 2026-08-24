"""Hand-label a sample of the judge's verdicts, so its numbers can be believed or discarded.

    python3 -m eval.calibrate export <run-dir>     # writes judge-calibration.txt
    # ... label it ...
    python3 -m eval.calibrate import <run-dir>     # prints agreement, writes calibration.json

Below 85% agreement the MOM numbers are reported as noise rather than as percentages. That is
the point of this file: a model grading a model is not a measurement until someone has checked
the grader.
"""
import json
import os
import re
import sys

from eval.metrics.calibration import THRESHOLD, agreement, sample_for_labelling

HEADER = """\
# Judge calibration — {n} of the judge's verdicts, for you to grade.
#
# For each item below, the judge decided whether our minutes CAPTURED a reference item (or, for
# `support`, whether an item we produced is backed by the transcript). Its answer is hidden on
# purpose: seeing it first is the fastest way to agree with it.
#
# Put YES or NO after `you:` on each line.
#   YES = the minutes really do capture this item / the claim really is supported
#   NO  = they do not
#
# Then: python3 -m eval.calibrate import {run_dir}
"""


def _items_path(run_dir):
    return os.path.join(run_dir, "judge-calibration.txt")


def export(run_dir, n=20):
    with open(os.path.join(run_dir, "results.json")) as f:
        results = json.load(f)
    verdicts = [v for fx in results["fixtures"] for v in fx.get("mom", {}).get("verdicts", [])]
    if not verdicts:
        raise SystemExit("no judge verdicts in that run — was the judge configured?")
    sampled = sample_for_labelling(verdicts, n=n)
    lines = [HEADER.format(n=len(sampled), run_dir=run_dir)]
    for i, v in enumerate(sampled, 1):
        lines.append(f"## {i}. [{v['kind']}/{v['category']}]")
        lines.append(f"item: {v['item']}")
        if v.get("evidence"):
            lines.append(f"the line the judge pointed at: {v['evidence']}")
        lines.append("you: ")
        lines.append("")
    path = _items_path(run_dir)
    with open(path, "w") as f:
        f.write("\n".join(lines))
    # The judge's own answers go somewhere the labeller will not read them by accident.
    with open(os.path.join(run_dir, "judge-calibration.key.json"), "w") as f:
        json.dump(sampled, f, indent=1)
    print(f"wrote {path}\n  {len(sampled)} items to label, then: "
          f"python3 -m eval.calibrate import {run_dir}")


def import_labels(run_dir):
    with open(os.path.join(run_dir, "judge-calibration.key.json")) as f:
        sampled = json.load(f)
    text = open(_items_path(run_dir)).read()
    items = re.findall(r"^item:\s*(.*)$", text, re.M)
    answers = re.findall(r"^you:\s*(.*)$", text, re.M)
    if len(items) != len(answers) or len(items) != len(sampled):
        raise SystemExit(f"{len(items)} items but {len(answers)} answers and {len(sampled)} "
                         f"sampled — the file has been reshaped; re-export it")
    labels = {}
    blank = []
    for item, answer in zip(items, answers):
        a = answer.strip().upper()
        if a in ("YES", "Y"):
            labels[item] = True
        elif a in ("NO", "N"):
            labels[item] = False
        else:
            blank.append(item)
    if blank:
        raise SystemExit(f"{len(blank)} item(s) have no YES/NO answer. Every one matters at a "
                         f"sample of {len(sampled)}: first is {blank[0][:70]!r}")
    result = agreement(sampled, labels)
    with open(os.path.join(run_dir, "calibration.json"), "w") as f:
        json.dump(result, f, indent=1)
    # Re-render the report so the judge's trustworthiness sits above its numbers rather than in
    # a file nobody opens.
    from eval import report
    with open(os.path.join(run_dir, "results.json")) as f:
        results = json.load(f)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report.render(results, result))
    print(f"agreement {result['rate'] * 100:.0f}% ({result['agree']}/{result['total']})")
    if not result["trustworthy"]:
        print(f"BELOW the {THRESHOLD * 100:.0f}% gate — the MOM numbers in this run are noise "
              f"and the report will say so.")
    for d in result["disagreements"]:
        print(f"  judge {'YES' if d['judge'] else 'NO':3} / you {'YES' if d['human'] else 'NO':3}"
              f"  {d['item'][:80]}")


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    cmd, run_dir = argv[1], argv[2]
    if cmd == "export":
        export(run_dir)
    elif cmd == "import":
        import_labels(run_dir)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
