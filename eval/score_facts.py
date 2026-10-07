"""Score a meeting's factual accuracy against hand-labelled facts and HUMAN-adjudicated matches.

    python3 -m eval.score_facts --fixture eval/fixtures/real-<id> --run <run.json> \\
        [--matches matches.json] [--min-instances 30] [--out <dir>]

Three rules shape everything here (docs/superpowers/reports/2026-10-07-phase-0-baseline.md, 3.4-3.6):

  * Nothing is scored without a human's matches. Pairing a produced item with a reference fact is
    the very step whose error rate is unknown, so an automated matcher would be one more
    uncalibrated judge. Without --matches the script writes candidate pairs (token overlap, for a
    human to confirm or reject) and stops.
  * Every reference fact gets exactly one outcome: correct, wrong_value or missing. Every produced
    item that could be a fact gets a match, a `spurious` row, or an `ignored` row with a reason.
  * Count first. A rate is printed only when the class has at least --min-instances reference
    instances; below that the raw counts and the individual errors are printed instead. This is
    the same spirit as the judge-calibration gate, which prints "noise" instead of percentages.

There is no pass/fail and no threshold anywhere: this tool measures, the product owner decides.
"""
import argparse
import csv
import json
import os
import re
import sys
from math import sqrt

from eval import facts as facts_mod
from eval.metrics.mom import parse_action

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_MIN_INSTANCES = 30
Z_95 = 1.96

OUTCOMES = ("correct", "wrong_value", "missing", "spurious", "ignored")
REF_OUTCOMES = ("correct", "wrong_value", "missing")           # one per reference fact
ERROR_OUTCOMES = ("wrong_value", "missing", "spurious")
STAGES = ("asr", "diarization", "extractor-rules", "classifier", "writer", "rename-resolution",
          "export")
SEVERITIES = ("S1", "S2")
ANCHORS = ("resolves", "wrong-moment", "summary", "none", "na")
PRODUCED_KINDS = ("action", "decision", "question", "summary", "price", "date")
SOURCES = ("rules", "writer")
COHORT_KEYS = ("device", "capture_path", "tier", "meeting_type", "field_density")

CLS_OF_FACTS = {facts_mod.PRICES: "price", facts_mod.DATES: "date",
                facts_mod.COMMITMENTS: "commitment", facts_mod.DECISIONS: "decision"}
CLASSES = tuple(CLS_OF_FACTS.values())
KIND_CLASS = {"action": "commitment", "decision": "decision", "price": "price", "date": "date"}
WRONG_FIELDS = {"price": ("amount", "currency", "period"),
                "date": ("date", "kind"),
                "commitment": ("owner", "due", "state", "text"),
                "decision": ("text",)}
# Which produced kinds a reference class may sensibly pair with when proposing candidates. Prices
# and dates live in prose as often as in items of their own, so they may pair with anything.
CANDIDATE_KINDS = {"price": None, "date": None, "commitment": ("action",),
                   "decision": ("decision",)}
STOPWORDS = frozenset("a an the and or of to in on at for is are was were be will we i you it that "
                      "this so um uh".split())


# ---- statistics -----------------------------------------------------------------------------

def wilson(k, n, z=Z_95):
    """Wilson score interval for k successes in n trials, or None when n == 0.

    Chosen over the normal approximation because the counts here are small and the rates sit near
    0 or 1, where the normal interval leaves [0, 1] and says nothing useful.
    """
    if n <= 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


# ---- produced items -------------------------------------------------------------------------

def produced_from_run(doc):
    """A run document's minutes[] -> the generic produced list.

    The CLI's minutes carry only kind, content and source; ids are synthesised from position, and
    anchor_ms / flagged_for_review are read when present. A run that has none of those reports
    every S1 as silent, and the report says so rather than guessing.
    """
    out = []
    for i, m in enumerate(doc.get("minutes", [])):
        kind, content = m.get("kind"), m.get("content", "")
        owner = due = None
        if kind == "action":
            content, owner, due = parse_action(content)
            owner, due = owner or None, due or None
        item = {"id": str(m.get("id", f"m{i}")), "kind": kind, "text": content, "owner": owner,
                "due": due, "anchor_ms": m.get("anchor_ms"),
                "source": "rules" if m.get("source") in (None, "rule", "rules") else "writer"}
        if "flagged_for_review" in m:
            item["flagged_for_review"] = bool(m["flagged_for_review"])
        out.append(item)
    return out


def validate_produced(items):
    if not isinstance(items, list):
        return ["produced must be a JSON list of items"]
    problems, seen = [], set()
    for i, it in enumerate(items, start=1):
        if not isinstance(it, dict):
            problems.append(f"produced item {i} is not an object")
            continue
        iid = it.get("id")
        if not (isinstance(iid, str) and iid.strip()):
            problems.append(f"produced item {i} needs a non-empty string id")
        elif iid in seen:
            problems.append(f"produced item: duplicate id {iid!r}")
        else:
            seen.add(iid)
        if it.get("kind") not in PRODUCED_KINDS:
            problems.append(f"produced item {iid!r}: unknown kind {it.get('kind')!r} "
                            f"(one of {', '.join(PRODUCED_KINDS)})")
        if not isinstance(it.get("text"), str):
            problems.append(f"produced item {iid!r}: text must be a string")
        if it.get("source", "rules") not in SOURCES:
            problems.append(f"produced item {iid!r}: unknown source {it.get('source')!r}")
    return problems


# ---- candidates (never a score) -------------------------------------------------------------

def _tokens(text):
    return {t for t in re.findall(r"[a-z0-9]+", str(text).lower()) if t not in STOPWORDS}


def _ref_text(cls, item):
    return item.get("spoken") if cls in ("price", "date") else item.get("text", "")


def _produced_index(produced):
    return {p["id"]: p for p in produced}


def candidates(facts_doc, produced, per_ref=3):
    """Pairs a human might confirm, from token overlap alone. A starting point, not an answer:
    numbers are not normalised ("four ninety nine" will not meet "$499"), so a price pair may
    appear here only by its surrounding words, or not at all."""
    cands, template = [], []
    for fcls, item in facts_mod.all_items(facts_doc):
        cls = CLS_OF_FACTS[fcls]
        want = CANDIDATE_KINDS[cls]
        rt = _tokens(_ref_text(cls, item))
        scored = []
        for p in produced:
            if (want is not None and p["kind"] not in want) or p["kind"] in ("question",):
                continue
            pt = _tokens(p["text"])
            shared = rt & pt
            if shared:
                scored.append((len(shared) / len(rt | pt), p, sorted(shared)))
        scored.sort(key=lambda s: (-s[0], s[1]["id"]))
        for overlap, p, shared in scored[:per_ref]:
            cands.append({"ref_id": item["id"], "class": cls, "ref_text": _ref_text(cls, item),
                          "produced_id": p["id"], "produced_kind": p["kind"],
                          "produced_text": p["text"], "overlap": round(overlap, 3),
                          "shared_words": shared})
        template.append(_blank_row(item["id"], None))
    matched_somewhere = {c["produced_id"] for c in cands}
    for p in produced:
        if p["kind"] in KIND_CLASS:
            template.append(_blank_row(None, p["id"]))
    return {
        "status": "CANDIDATES ONLY -- nothing here has been scored or confirmed",
        "how_to_use": ("A human must hear the audio and decide. Copy the rows from `template` into "
                       "a matches.json and fill in each one: ref_id and produced_id for a match, "
                       "outcome = correct | wrong_value | missing | spurious | ignored, and for "
                       "anything but correct a stage, a severity (S1/S2) and, for wrong_value, "
                       "`fields` naming what was wrong. `candidates` below are only suggestions "
                       "from shared words."),
        "outcomes": list(OUTCOMES), "stages": list(STAGES), "severities": list(SEVERITIES),
        "anchors": list(ANCHORS), "wrong_value_fields": {c: list(f) for c, f in WRONG_FIELDS.items()},
        "produced_ids": [p["id"] for p in produced],
        "produced_with_a_candidate": sorted(matched_somewhere),
        "candidates": cands,
        "template": template,
    }


def _blank_row(ref_id, produced_id):
    return {"ref_id": ref_id, "produced_id": produced_id, "outcome": None, "stage": None,
            "severity": None, "fields": None, "note": "", "anchor": "na"}


# ---- matches --------------------------------------------------------------------------------

def validate_matches(matches, facts_doc, produced):
    """-> list of problems; empty means the matches are a complete, consistent adjudication."""
    if isinstance(matches, dict) and ("candidates" in matches or "template" in matches):
        return ["this looks like a candidates file (matches.todo.json), not adjudicated matches: "
                "a human must turn it into a JSON list of rows with an outcome on each"]
    if not isinstance(matches, list):
        return ["matches must be a JSON list of rows"]
    ref_cls = {it["id"]: CLS_OF_FACTS[c] for c, it in facts_mod.all_items(facts_doc)}
    prod = _produced_index(produced)
    problems = []
    ref_rows, matched_prod, loose_prod = {}, set(), {}

    for i, r in enumerate(matches, start=1):
        if not isinstance(r, dict):
            problems.append(f"row {i} is not an object")
            continue
        at = f"row {i}"
        outcome = r.get("outcome")
        rid, pid = r.get("ref_id"), r.get("produced_id")
        if outcome not in OUTCOMES:
            problems.append(f"{at}: unknown outcome {outcome!r} (one of {', '.join(OUTCOMES)})")
            continue
        if rid is not None and rid not in ref_cls:
            problems.append(f"{at}: ref_id {rid!r} is not in facts.json")
        if pid is not None and pid not in prod:
            problems.append(f"{at}: produced_id {pid!r} is not in the produced items")
        cls = ref_cls.get(rid) or KIND_CLASS.get((prod.get(pid) or {}).get("kind"))

        if outcome in ("correct", "wrong_value"):
            if rid is None or pid is None:
                problems.append(f"{at}: '{outcome}' needs both ref_id and produced_id")
        elif outcome == "missing":
            if rid is None:
                problems.append(f"{at}: 'missing' needs a ref_id")
            if pid is not None:
                problems.append(f"{at}: 'missing' must have produced_id null "
                                f"(nothing was produced for it)")
        else:
            if rid is not None:
                problems.append(f"{at}: '{outcome}' must have ref_id null")
            if pid is None:
                problems.append(f"{at}: '{outcome}' needs a produced_id")

        if outcome == "ignored" and not str(r.get("note") or "").strip():
            problems.append(f"{at}: ignored row for {pid!r} needs a note giving the reason")
        if outcome == "correct":
            if r.get("stage") is not None or r.get("severity") is not None:
                problems.append(f"{at}: a 'correct' row carries no stage or severity")
        if outcome in ERROR_OUTCOMES:
            if r.get("stage") not in STAGES:
                problems.append(f"{at}: '{outcome}' needs a stage (one of {', '.join(STAGES)})")
            if r.get("severity") not in SEVERITIES:
                problems.append(f"{at}: severity must be S1 or S2, got {r.get('severity')!r}")
        if outcome == "wrong_value":
            fields = r.get("fields")
            if not (isinstance(fields, list) and fields):
                problems.append(f"{at}: 'wrong_value' must name the wrong fields, e.g. "
                                f"\"fields\": [\"owner\"]")
            elif cls:
                for f in fields:
                    if f not in WRONG_FIELDS[cls]:
                        problems.append(f"{at}: field {f!r} is not a {cls} field "
                                        f"(one of {', '.join(WRONG_FIELDS[cls])})")
        if r.get("anchor", "na") not in ANCHORS:
            problems.append(f"{at}: unknown anchor {r.get('anchor')!r} "
                            f"(one of {', '.join(ANCHORS)})")

        if outcome in REF_OUTCOMES and rid is not None:
            ref_rows.setdefault(rid, []).append(i)
        if outcome in ("correct", "wrong_value") and pid is not None:
            matched_prod.add(pid)
        if outcome in ("spurious", "ignored") and pid is not None:
            loose_prod.setdefault(pid, []).append(i)
            if outcome == "spurious" and pid in prod and prod[pid]["kind"] not in KIND_CLASS:
                problems.append(f"{at}: produced item {pid!r} is a {prod[pid]['kind']}, "
                                f"which is not scored")

    for rid in ref_cls:
        n = len(ref_rows.get(rid, []))
        if n == 0:
            problems.append(f"reference fact {rid!r} has no outcome row")
        elif n > 1:
            problems.append(f"reference fact {rid!r} has {n} outcome rows (rows "
                            f"{', '.join(map(str, ref_rows[rid]))}); exactly one is allowed")
    for pid, rows_ in loose_prod.items():
        if len(rows_) > 1:
            problems.append(f"produced item {pid!r} has {len(rows_)} spurious/ignored rows")
        if pid in matched_prod:
            problems.append(f"produced item {pid!r} is both matched and spurious/ignored")
    for p in produced:
        if p["kind"] in KIND_CLASS and p["id"] not in matched_prod and p["id"] not in loose_prod:
            problems.append(f"produced item {p['id']!r} ({p['kind']}) is neither matched, "
                            f"spurious nor ignored")
    return problems


# ---- scoring --------------------------------------------------------------------------------

def _row_record(meeting_id, cohort, cls, r, ref_item, prod_item):
    return {
        "meeting_id": meeting_id, "cohort": cohort, "class": cls,
        "ref_id": r.get("ref_id"), "produced_id": r.get("produced_id"),
        "outcome": r["outcome"], "fields": list(r.get("fields") or []),
        "stage": r.get("stage"), "severity": r.get("severity"),
        "anchor": r.get("anchor", "na"), "note": r.get("note") or "",
        "flagged": bool(prod_item.get("flagged_for_review")) if prod_item else None,
        "ref_span": list(ref_item["span_ms"]) if ref_item else None,
        "ref_text": _ref_text(cls, ref_item) if ref_item else None,
        "produced_text": prod_item["text"] if prod_item else None,
    }


def score(facts_doc, produced, matches, meeting_id, cohort, min_instances):
    """-> {"doc": facts_score.json content, "rows", "summary"}. Raises ValueError with every
    problem when the matches are not a complete adjudication."""
    problems = validate_produced(produced) + validate_matches(matches, facts_doc, produced)
    if problems:
        raise ValueError(f"{len(problems)} problem(s):\n  " + "\n  ".join(problems))
    refs = {it["id"]: (CLS_OF_FACTS[c], it) for c, it in facts_mod.all_items(facts_doc)}
    prod = _produced_index(produced)
    rows = []
    for r in matches:
        ref = refs.get(r.get("ref_id"))
        p = prod.get(r.get("produced_id"))
        cls = ref[0] if ref else KIND_CLASS[p["kind"]]
        rows.append(_row_record(meeting_id, cohort, cls, r, ref[1] if ref else None, p))
    summary = summarise(rows, min_instances)
    doc = {"meeting_id": meeting_id, "cohort": cohort, "min_instances": min_instances,
           "flag_data_present": any("flagged_for_review" in p for p in produced),
           "produced_items": len(produced),
           "unscored_produced": sum(1 for p in produced if p["kind"] not in KIND_CLASS),
           "summary": summary, "rows": rows}
    return {"doc": doc, "rows": rows, "summary": summary}


def _metric(name, k, n, ref_n, min_instances):
    gate = min(ref_n, n)
    refused = n == 0 or gate < min_instances
    rate = None if refused else k / n
    ci = None if refused else wilson(k, n)
    return {"name": name, "k": k, "n": n, "gate_n": gate, "refused": refused,
            "rate": rate, "ci": list(ci) if ci else None}


def summarise(rows, min_instances):
    """Counts and metrics from rows alone, so a cohort or an aggregate is the same arithmetic."""
    classes = {}
    for cls in CLASSES:
        cr = [r for r in rows if r["class"] == cls]
        counts = {"ref": sum(r["outcome"] in REF_OUTCOMES for r in cr)}
        for o in OUTCOMES:
            counts[o] = sum(r["outcome"] == o for r in cr)
        errors = [r for r in cr if r["outcome"] in ERROR_OUTCOMES]
        counts_extra = {"s1": sum(r["severity"] == "S1" for r in errors)}
        ref_n = counts["ref"]
        found = counts["correct"] + counts["wrong_value"]
        metrics = {}
        if cls in ("price", "date"):
            metrics["accuracy"] = _metric(f"{cls} accuracy", counts["correct"], ref_n, ref_n,
                                          min_instances)
        elif cls == "commitment":
            for fld in ("owner", "state"):
                bad = sum(fld in r["fields"] for r in cr if r["outcome"] == "wrong_value")
                metrics[fld] = _metric(f"commitment {fld}", found - bad, found, ref_n,
                                       min_instances)
            metrics["recall"] = _metric("commitment recall", found, ref_n, ref_n, min_instances)
            produced_found = len({r["produced_id"] for r in cr
                                  if r["outcome"] in ("correct", "wrong_value")})
            metrics["precision"] = _metric("commitment precision", produced_found,
                                           produced_found + counts["spurious"], ref_n,
                                           min_instances)
        else:
            metrics["recall"] = _metric("decision recall", found, ref_n, ref_n, min_instances)
        classes[cls] = {"counts": counts, "extra": counts_extra, "metrics": metrics}

    errors = [r for r in rows if r["outcome"] in ERROR_OUTCOMES]
    s1 = [r for r in errors if r["severity"] == "S1"]
    with_item = [r for r in s1 if r["produced_id"] is not None]
    # A silent S1 is a serious error the app gave the reader no cue about. Only an error that had
    # a produced item can be flagged, so a missing fact is counted on its own line rather than
    # being folded into either number.
    silent = [r for r in with_item if not r["flagged"]]
    anchors = {a: 0 for a in ANCHORS}
    for r in rows:
        if r["outcome"] in ("correct", "wrong_value"):
            anchors[r["anchor"]] += 1
    stages = {}
    for r in errors:
        stages[r["stage"]] = stages.get(r["stage"], 0) + 1
    return {
        "classes": classes,
        "s1": {"total": len(s1), "with_item": len(with_item),
               "missing_no_item": len(s1) - len(with_item), "silent": len(silent),
               "flagged": len(with_item) - len(silent)},
        "anchors": anchors, "stages": stages,
        "meetings": len({r["meeting_id"] for r in rows}),
    }


# ---- report ---------------------------------------------------------------------------------

def _pct(x):
    return f"{x * 100:.1f}%"


def _metric_line(m, min_instances):
    counts = f"{m['k']} of {m['n']}"
    if m["refused"]:
        why = (f"{m['gate_n']} reference instances, fewer than the {min_instances} required"
               if m["n"] else "no instances")
        return f"{m['name']}: rate not printed ({counts}; {why})"
    lo, hi = m["ci"]
    return f"{m['name']}: {_pct(m['rate'])} ({counts}; Wilson 95% [{_pct(lo)}, {_pct(hi)}])"


def _class_block(summary, min_instances):
    out = []
    for cls in CLASSES:
        c = summary["classes"][cls]
        n = c["counts"]
        out.append(f"- **{cls}**: {n['ref']} reference | correct {n['correct']} | wrong_value "
                   f"{n['wrong_value']} | missing {n['missing']} | spurious {n['spurious']} | "
                   f"ignored {n['ignored']} | S1 {c['extra']['s1']}")
        out += [f"  - {_metric_line(m, min_instances)}" for m in c["metrics"].values()]
    return out


def _s1_lines(s):
    s1 = s["s1"]
    return [f"**Silent S1: {s1['silent']}** (an S1 error whose produced item was not flagged "
            f"for review). {s1['flagged']} of the {s1['with_item']} S1 errors that had a produced "
            f"item were flagged for review. {s1['missing_no_item']} further S1 errors were missing "
            f"facts: nothing was produced, so nothing could be flagged. S1 total: {s1['total']}."]


def _error_line(r):
    fields = f" ({', '.join(r['fields'])})" if r["fields"] else ""
    ref = f'ref "{r["ref_text"]}"' if r["ref_text"] else "no reference"
    prod = f'produced "{r["produced_text"]}"' if r["produced_text"] else "nothing produced"
    flag = "" if r["flagged"] is None else (", flagged" if r["flagged"] else ", not flagged")
    return (f"- {r['meeting_id']} {r['ref_id'] or r['produced_id']} {r['outcome']}{fields} "
            f"{r['severity']} at {r['stage']}: {ref} -> {prod}{flag}")


def render_report(docs, min_instances):
    """One markdown report over one or more facts_score docs (a meeting, or an aggregate)."""
    rows = [r for d in docs for r in d["rows"]]
    summary = summarise(rows, min_instances)
    meetings = sorted({d["meeting_id"] for d in docs})
    out = ["# Factual accuracy", "",
           f"- meetings: {len(meetings)} ({', '.join(meetings)})",
           f"- count-first minimum: {min_instances} reference instances per class. Below it no "
           f"rate is printed; the counts and the individual errors are.",
           "- Reference facts and matches are human-made; this report only counts them. It sets "
           "no thresholds and makes no judgement.", ""]
    unflagged = [d["meeting_id"] for d in docs if not d.get("flag_data_present", True)]
    if unflagged:
        out += [f"> {', '.join(unflagged)}: the produced items carried no flagged_for_review "
                f"data, so every S1 error there counts as silent. That is a statement about the "
                f"input, not about the app.", ""]
    out += ["## Overall", ""] + _class_block(summary, min_instances) + [""]
    out += _s1_lines(summary) + [""]
    out += ["Anchors (source links, on matched items): " +
            ", ".join(f"{a} {n}" for a, n in summary["anchors"].items()), ""]
    if summary["stages"]:
        out += ["First stage at which the truth was lost (errors): " +
                ", ".join(f"{s} {n}" for s, n in sorted(summary["stages"].items())), ""]

    refused = [cls for cls in CLASSES
               if any(m["refused"] for m in summary["classes"][cls]["metrics"].values())]
    out += ["## Individual errors", ""]
    if refused:
        out += [f"Listed for every class with a refused rate ({', '.join(refused)}); all errors "
                f"are in facts_errors.csv.", ""]
        listed = [r for r in rows if r["class"] in refused and r["outcome"] in ERROR_OUTCOMES]
        out += [_error_line(r) for r in listed] or ["(none)"]
    else:
        out += ["Every class met the minimum; the full list is in facts_errors.csv."]
    out.append("")

    out += ["## Cohorts", ""]
    for key in COHORT_KEYS:
        values = sorted({(r["cohort"] or {}).get(key, "unknown") for r in rows})
        for v in values:
            sub = [r for r in rows if (r["cohort"] or {}).get(key, "unknown") == v]
            s = summarise(sub, min_instances)
            out += [f"### {key} = {v} ({s['meetings']} meeting(s))", ""]
            out += _class_block(s, min_instances) + [""] + _s1_lines(s) + [""]
    return "\n".join(out)


def write_errors_csv(path, rows):
    cols = ["meeting_id", "class", "outcome", "stage", "severity", "reference_span",
            "produced_text", "anchor", "ref_id", "produced_id", "fields", "flagged",
            "reference_text", "note"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            if r["outcome"] not in ERROR_OUTCOMES:
                continue
            span = f"{r['ref_span'][0]}-{r['ref_span'][1]}" if r["ref_span"] else ""
            w.writerow([r["meeting_id"], r["class"], r["outcome"], r["stage"], r["severity"],
                        span, r["produced_text"] or "", r["anchor"], r["ref_id"] or "",
                        r["produced_id"] or "", ";".join(r["fields"]),
                        "" if r["flagged"] is None else str(r["flagged"]).lower(),
                        r["ref_text"] or "", r["note"]])


# ---- command line ---------------------------------------------------------------------------

def _load_json(path, what):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read {what} {path}: {exc}") from None


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python3 -m eval.score_facts", description=__doc__.split("\n\n")[0])
    ap.add_argument("--fixture", required=True, help="eval/fixtures/<id> with facts.json")
    ap.add_argument("--run", help="a run document (CLI --json output) with transcript/minutes")
    ap.add_argument("--produced", help="a generic produced.json: id, kind, text, owner, due, "
                                       "anchor_ms, flagged_for_review, source")
    ap.add_argument("--matches", help="human-adjudicated matches.json")
    ap.add_argument("--min-instances", type=int, default=DEFAULT_MIN_INSTANCES,
                    help="count-first rule: reference instances a class needs before a rate is "
                         "printed (default %(default)s)")
    ap.add_argument("--out", help="output directory (default eval/results/facts-<meeting-id>)")
    args = ap.parse_args(argv)
    if bool(args.run) == bool(args.produced):
        raise SystemExit("give exactly one of --run or --produced")

    fixture = os.path.abspath(args.fixture)
    meeting_id = os.path.basename(fixture.rstrip("/"))
    audio_ms = facts_mod.audio_ms_of(fixture)
    try:
        facts_doc = facts_mod.load(os.path.join(fixture, "facts.json"), audio_ms)
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
    meta_path = os.path.join(fixture, "meta.json")
    meta = _load_json(meta_path, "meta.json") if os.path.exists(meta_path) else {}
    cohort = {k: str(meta.get(k, "unknown")) for k in COHORT_KEYS}

    produced = (produced_from_run(_load_json(args.run, "run document")) if args.run
                else _load_json(args.produced, "produced.json"))
    bad = validate_produced(produced)
    if bad:
        raise SystemExit("produced items are not usable:\n  " + "\n  ".join(bad))

    out = args.out or os.path.join(ROOT, "eval", "results", f"facts-{meeting_id}")
    os.makedirs(out, exist_ok=True)

    if not args.matches:
        todo_path = os.path.join(out, "matches.todo.json")
        with open(todo_path, "w") as f:
            json.dump(candidates(facts_doc, produced), f, indent=1)
        raise SystemExit(
            f"no --matches given, so nothing was scored.\n"
            f"wrote {todo_path}: candidate pairs from shared words, for a human to confirm.\n"
            f"Decide each pair while listening, save the rows as matches.json, then re-run "
            f"with --matches.")

    try:
        result = score(facts_doc, produced, _load_json(args.matches, "matches"), meeting_id,
                       cohort, args.min_instances)
    except ValueError as exc:
        raise SystemExit(f"{args.matches}: {exc}") from None
    doc = result["doc"]
    with open(os.path.join(out, "facts_score.json"), "w") as f:
        json.dump(doc, f, indent=1)
    write_errors_csv(os.path.join(out, "facts_errors.csv"), result["rows"])
    with open(os.path.join(out, "facts_report.md"), "w") as f:
        f.write(render_report([doc], args.min_instances))
    print(f"wrote facts_score.json, facts_errors.csv, facts_report.md in {out}")


if __name__ == "__main__":
    main(sys.argv[1:])
